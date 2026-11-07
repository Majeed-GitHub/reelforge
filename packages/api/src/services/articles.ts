import { buildArticleFromFlow } from '../../../core/src/articles.ts';
import { WEB_BASE_URL } from '../../../core/src/config.ts';
import { ApiError } from '../../../core/src/http.ts';
import { newId, nowIso, slugify } from '../../../core/src/ids.ts';
import { flowNameFromInstruction } from '../../../core/src/flow.ts';
import type { ArticleChannel, ArticleRow, ArticleStatus, FlowRow, FlowStepRow, StepKind, StepRecord } from '../../../core/src/types.ts';
import type { AuthContext } from '../auth.ts';
import { many, one, run } from '../dbq.ts';
import { mediaUrl } from '../signing.ts';
import { notFound } from '../util.ts';

export type ArticleView = ArticleRow & {
  stale: boolean;
  flowName: string | null;
  environmentName: string | null;
};

const STALE_MARKER = /^> \[!WARNING\] Stale flow[\s\S]*?(?:\r?\n){2}/;

function toView(row: ArticleRow): ArticleView {
  const flow = row.flow_id
    ? one<{ name: string; status: string }>('SELECT name, status FROM flows WHERE id = ?', row.flow_id)
    : undefined;
  const env = row.environment_id
    ? one<{ name: string }>('SELECT name FROM environments WHERE id = ?', row.environment_id)
    : undefined;
  return {
    ...row,
    stale: flow?.status === 'stale',
    flowName: flow?.name ?? null,
    environmentName: env?.name ?? null
  };
}

export function listArticles(
  auth: AuthContext,
  filter: { limit?: number; channel?: ArticleChannel; status?: ArticleStatus } = {}
): ArticleView[] {
  const clauses = ['workspace_id = ?'];
  const params: Array<string | number> = [auth.workspaceId];
  if (filter.channel) {
    clauses.push('channel = ?');
    params.push(filter.channel);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  params.push(Math.min(Math.max(filter.limit ?? 50, 1), 100));
  return many<ArticleRow>(
    `SELECT * FROM articles WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ...params
  ).map(toView);
}

export function getArticle(auth: AuthContext, id: string): ArticleView {
  const row = one<ArticleRow>('SELECT * FROM articles WHERE id = ? AND workspace_id = ?', id, auth.workspaceId);
  if (!row) throw notFound('article', id);
  return toView(row);
}

function flowStepsAsRecords(flowId: string): Array<StepRecord & { label?: string | null }> {
  return many<FlowStepRow>('SELECT * FROM flow_steps WHERE flow_id = ? ORDER BY idx ASC', flowId).map((step) => ({
    index: Number(step.idx),
    kind: step.kind as StepKind,
    narration: step.label ?? '',
    startedAtMs: 0,
    endedAtMs: 0,
    selector: step.selector ?? undefined,
    role: step.role ?? undefined,
    accessibleName: step.name ?? undefined,
    url: step.url ?? undefined,
    label: step.label
  }));
}

/** Signed screenshots for the URLs a flow touched, keyed by step index. */
function screenshotUrlsFor(environmentId: string, steps: Array<StepRecord & { label?: string | null }>): Map<number, string> {
  const screens = many<{ url_path: string; screenshot_path: string | null }>(
    'SELECT url_path, screenshot_path FROM screens WHERE environment_id = ?',
    environmentId
  );
  const byPath = new Map<string, string | null>();
  for (const screen of screens) byPath.set(screen.url_path, screen.screenshot_path);
  const out = new Map<number, string>();
  for (const step of steps) {
    if (!step.url) continue;
    try {
      const pathname = new URL(step.url).pathname;
      const shot = mediaUrl(byPath.get(pathname) ?? null);
      if (shot) out.set(step.index, shot);
    } catch {
      /* ignore malformed step urls */
    }
  }
  return out;
}

/** POST /api/articles/from-flow */
export function createArticleFromFlow(
  auth: AuthContext,
  input: { flowId: string; channel: ArticleChannel; environmentId?: string }
): ArticleView {
  const flow = one<FlowRow>('SELECT * FROM flows WHERE id = ? AND workspace_id = ?', input.flowId, auth.workspaceId);
  if (!flow) throw notFound('flow', input.flowId);
  if (input.environmentId && input.environmentId !== flow.environment_id) {
    throw new ApiError('VALIDATION_ERROR', 'That flow belongs to a different environment.', {
      action: 'list_graph_flows',
      hint: `Use GET /api/environments/${flow.environment_id}/graph/flows.`
    });
  }
  const env = one<{ name: string }>('SELECT name FROM environments WHERE id = ?', flow.environment_id);
  const steps = flowStepsAsRecords(flow.id);
  const draft = buildArticleFromFlow({
    instruction: flow.name,
    steps,
    channel: input.channel,
    productName: env?.name,
    screenshotUrls: screenshotUrlsFor(flow.environment_id, steps)
  });

  const id = newId('art');
  const ts = nowIso();
  run(
    `INSERT INTO articles (id, workspace_id, environment_id, flow_id, title, slug, excerpt, body_md, channel, status, published_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?)`,
    id,
    auth.workspaceId,
    flow.environment_id,
    flow.id,
    draft.title,
    uniqueSlug(auth.workspaceId, draft.title),
    draft.excerpt,
    draft.body_md,
    input.channel,
    ts,
    ts
  );
  return getArticle(auth, id);
}

function uniqueSlug(workspaceId: string, title: string): string {
  const base = slugify(title);
  let candidate = base;
  let n = 2;
  while (one<{ id: string }>('SELECT id FROM articles WHERE workspace_id = ? AND slug = ?', workspaceId, candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

export function patchArticle(
  auth: AuthContext,
  id: string,
  body: {
    title?: string;
    excerpt?: string;
    body_md?: string;
    channel?: ArticleChannel;
    status?: ArticleStatus;
    published_url?: string | null;
  }
): ArticleView {
  const current = getArticle(auth, id);
  const title = body.title ?? current.title;
  run(
    `UPDATE articles SET title = ?, excerpt = ?, body_md = ?, channel = ?, status = ?, published_url = ?, slug = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
    title,
    body.excerpt ?? current.excerpt,
    body.body_md ?? current.body_md,
    body.channel ?? current.channel,
    body.status ?? current.status,
    body.published_url !== undefined ? body.published_url : current.published_url,
    body.title && body.title !== current.title ? uniqueSlug(auth.workspaceId, body.title) : current.slug,
    nowIso(),
    id,
    auth.workspaceId
  );
  return getArticle(auth, id);
}

export function publishArticle(auth: AuthContext, id: string): ArticleView {
  const current = getArticle(auth, id);
  const publishedUrl = current.published_url ?? `${WEB_BASE_URL}/#/articles/${current.slug}`;
  run(
    "UPDATE articles SET status = 'published', published_url = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
    publishedUrl,
    nowIso(),
    id,
    auth.workspaceId
  );
  return getArticle(auth, id);
}

export function unpublishArticle(auth: AuthContext, id: string): ArticleView {
  getArticle(auth, id);
  run(
    "UPDATE articles SET status = 'draft', published_url = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?",
    nowIso(),
    id,
    auth.workspaceId
  );
  return getArticle(auth, id);
}

/**
 * Mark every article written from a flow as stale: the flag is derived from
 * flows.status, and the body gets a visible, idempotent warning banner.
 */
export function markArticlesStaleForFlow(flowId: string, reason: string): string[] {
  const articles = many<{ id: string; body_md: string }>('SELECT id, body_md FROM articles WHERE flow_id = ?', flowId);
  const ts = nowIso();
  const note = `> [!WARNING] Stale flow\n> ${reason}\n> Detected ${ts}. Re-record the flow and regenerate this article.\n\n`;
  for (const article of articles) {
    const stripped = (article.body_md ?? '').replace(STALE_MARKER, '');
    run('UPDATE articles SET body_md = ?, updated_at = ? WHERE id = ?', note + stripped, ts, article.id);
  }
  return articles.map((article) => article.id);
}

export function clearStaleBanner(articleBody: string): string {
  return articleBody.replace(STALE_MARKER, '');
}

/** Used by the product-graph writer: the flow's article title for a channel. */
export function articleTitleForFlow(flowId: string, channel: ArticleChannel, fallback: string): string {
  const row = one<{ title: string }>('SELECT title FROM articles WHERE flow_id = ? AND channel = ?', flowId, channel);
  return row?.title ?? flowNameFromInstruction(fallback);
}
