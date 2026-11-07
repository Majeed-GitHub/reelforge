import crypto from 'node:crypto';
import { relativeToData } from '../../core/src/config.ts';
import { buildArticleFromFlow, buildGuideSteps } from '../../core/src/articles.ts';
import { flowNameFromInstruction, flowSignature, stepLabel } from '../../core/src/flow.ts';
import { newId, nowIso } from '../../core/src/ids.ts';
import type { ArticleChannel, FlowRow, StepRecord } from '../../core/src/types.ts';
import { many, one, run } from './dbq.ts';
import { clearStaleBanner } from './services/articles.ts';
import { mediaUrl } from './signing.ts';

/**
 * The Product Graph writer.
 *
 * One recording feeds all four outputs. A flow's identity is
 * `flowSignature(steps)` (core/flow.ts), so re-recording the same route
 * updates the existing flow, its steps and its screens instead of creating
 * duplicates. From the same capture we keep exactly one draft article
 * (help centre) and one draft in-app guide per flow.
 */

export type GraphUpsertInput = {
  workspaceId: string;
  environmentId: string;
  instruction: string;
  steps: StepRecord[];
  /** Step index -> absolute screenshot path (from demo_steps). */
  screenshots?: Map<number, string>;
  channel?: ArticleChannel;
};

export type GraphUpsertResult = {
  flowId: string;
  flowCreated: boolean;
  signature: string;
  articleId: string | null;
  articleCreated: boolean;
  guideId: string | null;
  guideCreated: boolean;
  screenCount: number;
  stepCount: number;
};

function urlPath(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return url.startsWith('/') ? url : null;
  }
}

export function upsertProductGraph(input: GraphUpsertInput): GraphUpsertResult | null {
  const steps = input.steps.filter((step) => step.kind !== 'done');
  if (steps.length === 0) return null;

  const signature = flowSignature(steps);
  const name = flowNameFromInstruction(input.instruction);
  const ts = nowIso();

  const existing = one<FlowRow>(
    'SELECT * FROM flows WHERE environment_id = ? AND signature = ?',
    input.environmentId,
    signature
  );

  let flowId: string;
  let flowCreated = false;
  if (existing) {
    flowId = existing.id;
    // Re-recording refreshes the flow: it is fresh again, drift cleared.
    run(
      "UPDATE flows SET name = ?, status = 'fresh', stale_reason = NULL, last_verified_at = ? WHERE id = ?",
      name,
      ts,
      flowId
    );
  } else {
    flowId = newId('flw');
    run(
      `INSERT INTO flows (id, workspace_id, environment_id, name, signature, status, stale_reason, first_seen_at, last_verified_at)
       VALUES (?, ?, ?, ?, ?, 'fresh', NULL, ?, ?)`,
      flowId,
      input.workspaceId,
      input.environmentId,
      name,
      signature,
      ts,
      ts
    );
    flowCreated = true;
  }

  // Steps are replaced wholesale: the flow is the current shape of the route.
  run('DELETE FROM flow_steps WHERE flow_id = ?', flowId);
  steps.forEach((step, idx) => {
    run(
      `INSERT INTO flow_steps (flow_id, idx, kind, selector, role, name, url, label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      flowId,
      idx,
      step.kind,
      step.selector ?? null,
      step.role ?? null,
      step.accessibleName ?? null,
      step.url ?? null,
      stepLabel(step)
    );
  });

  // Screens: one row per distinct url_path the capture visited.
  const screenPaths = new Map<string, { title: string; brief: string; screenshot: string | null }>();
  for (const step of steps) {
    const path = urlPath(step.url);
    if (!path) continue;
    const shot = step.screenshotPath ? relativeToData(step.screenshotPath) : null;
    const existingScreen = screenPaths.get(path);
    if (existingScreen) {
      if (!existingScreen.brief && step.narration) existingScreen.brief = step.narration;
      if (!existingScreen.screenshot && shot) existingScreen.screenshot = shot;
      continue;
    }
    screenPaths.set(path, {
      title: step.accessibleName || stepLabel(step),
      brief: step.narration || '',
      screenshot: shot
    });
  }
  for (const [path, screen] of screenPaths) {
    run(
      `INSERT INTO screens (id, environment_id, url_path, title, brief, screenshot_path, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(environment_id, url_path) DO UPDATE SET
         title = excluded.title,
         brief = excluded.brief,
         screenshot_path = COALESCE(excluded.screenshot_path, screens.screenshot_path),
         last_seen_at = excluded.last_seen_at`,
      newId('scr'),
      input.environmentId,
      path,
      screen.title,
      screen.brief,
      screen.screenshot,
      ts
    );
  }

  // A fresh recording means the stale banner on dependent articles is obsolete.
  for (const article of many<{ id: string; body_md: string }>(
    'SELECT id, body_md FROM articles WHERE flow_id = ?',
    flowId
  )) {
    const cleaned = clearStaleBanner(article.body_md ?? '');
    if (cleaned !== article.body_md) {
      run('UPDATE articles SET body_md = ?, updated_at = ? WHERE id = ?', cleaned, ts, article.id);
    }
  }

  // ---- draft article (help centre) --------------------------------------
  const channel: ArticleChannel = input.channel ?? 'help_center';
  const productName = one<{ name: string }>(
    'SELECT name FROM environments WHERE id = ?',
    input.environmentId
  )?.name;
  const screenshotUrls = new Map<number, string>();
  if (input.screenshots) {
    for (const [index, absPath] of input.screenshots) {
      const signed = mediaUrl(absPath);
      if (signed) screenshotUrls.set(index, signed);
    }
  }

  let articleId: string | null = null;
  let articleCreated = false;
  const existingArticle = one<{ id: string }>(
    'SELECT id FROM articles WHERE flow_id = ? AND channel = ?',
    flowId,
    channel
  );
  if (existingArticle) {
    articleId = existingArticle.id;
  } else {
    const draft = buildArticleFromFlow({
      instruction: input.instruction,
      steps,
      channel,
      productName,
      screenshotUrls: screenshotUrls.size > 0 ? screenshotUrls : undefined
    });
    articleId = newId('art');
    run(
      `INSERT INTO articles (id, workspace_id, environment_id, flow_id, title, slug, excerpt, body_md, channel, status, published_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?)`,
      articleId,
      input.workspaceId,
      input.environmentId,
      flowId,
      draft.title,
      uniqueSlug(input.workspaceId, draft.title),
      draft.excerpt,
      draft.body_md,
      channel,
      ts,
      ts
    );
    articleCreated = true;
  }

  // ---- in-app guide draft ------------------------------------------------
  const guideSteps = buildGuideSteps(steps);
  let guideId: string | null = null;
  let guideCreated = false;
  const existingGuide = one<{ id: string }>('SELECT id FROM guides WHERE flow_id = ?', flowId);
  if (existingGuide) {
    guideId = existingGuide.id;
    if (guideSteps.length > 0) {
      run(
        'UPDATE guides SET steps_json = ?, name = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(guideSteps),
        name,
        ts,
        guideId
      );
    }
  } else if (guideSteps.length > 0) {
    guideId = newId('gde');
    run(
      `INSERT INTO guides (id, workspace_id, environment_id, flow_id, name, steps_json, status, embed_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      guideId,
      input.workspaceId,
      input.environmentId,
      flowId,
      name,
      JSON.stringify(guideSteps),
      crypto.randomBytes(12).toString('hex'),
      ts,
      ts
    );
    guideCreated = true;
  }

  return {
    flowId,
    flowCreated,
    signature,
    articleId,
    articleCreated,
    guideId,
    guideCreated,
    screenCount: screenPaths.size,
    stepCount: steps.length
  };
}

function uniqueSlug(workspaceId: string, title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'article';
  let candidate = base;
  let n = 2;
  while (one<{ id: string }>('SELECT id FROM articles WHERE workspace_id = ? AND slug = ?', workspaceId, candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}