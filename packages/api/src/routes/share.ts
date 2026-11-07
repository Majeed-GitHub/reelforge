/**
 * Public share pages.
 *
 *   GET /api/demos/:id/share   (auth)      -> { url } — a 30-day link you can paste anywhere
 *   GET /api/share/:token      (no auth)   -> a self-contained HTML page
 *
 * The share token is a separate HMAC claim from the 1-hour media token (see
 * signing.ts): the link has to survive being sent in a DM, while the media URLs
 * it mints are re-signed on every page load and stay short-lived.
 *
 * The page itself is deliberately framework-free: one inlined stylesheet, one
 * `<video>`, no JavaScript, no external assets beyond the signed poster/video.
 * It works with the browser's HTTP cache disabled and behind any CDN.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { PUBLIC_BASE_URL } from '../../../core/src/config.ts';
import type { ArticleRow, DemoFailure, DemoRow, DemoStatus } from '../../../core/src/types.ts';
import { authOf } from '../auth.ts';
import { one } from '../dbq.ts';
import { getDemoRow } from '../services/demos.ts';
import { SHARE_TOKEN_TTL_MS, mediaUrl, signShareToken, verifyShareToken } from '../signing.ts';
import { safeJson } from '../util.ts';

const HTML_TYPE = 'text/html; charset=utf-8';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 33.2 s -> "33.2s"; 95 s -> "1:35". */
function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) return '—';
  const seconds = Math.round(durationMs / 100) / 10;
  if (seconds < 60) return `${seconds}s`;
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 10);
}

function pageShell(opts: { title: string; description?: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(opts.title)}</title>
${opts.description ? `<meta name="description" content="${esc(opts.description)}" />` : ''}
<style>
  :root {
    color-scheme: dark;
    --bg: #0b1220;
    --panel: #121a2b;
    --panel-2: #172136;
    --line: #24314d;
    --text: #e8eefc;
    --muted: #93a3c4;
    --accent: #5eead4;
    --accent-2: #38bdf8;
    --good: #34d399;
    --bad: #fb7185;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    background:
      radial-gradient(1100px 520px at 12% -8%, rgba(56, 189, 248, 0.20), transparent 62%),
      radial-gradient(900px 460px at 92% 0%, rgba(94, 234, 212, 0.14), transparent 58%),
      var(--bg);
    color: var(--text);
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { width: 100%; max-width: 1040px; margin: 0 auto; padding: 40px 20px 56px; }
  .brand { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 13px; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 22px; }
  .brand .dot { width: 9px; height: 9px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 0 18px rgba(94,234,212,.55); }
  h1 { font-size: clamp(24px, 3.3vw, 38px); line-height: 1.18; margin: 0 0 14px; letter-spacing: -.015em; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; color: var(--muted); font-size: 14px; margin-bottom: 24px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--panel-2); border-radius: 999px; padding: 4px 11px; font-size: 12.5px; color: var(--text); }
  .pill.good { border-color: rgba(52,211,153,.45); color: var(--good); }
  .pill.bad { border-color: rgba(251,113,133,.45); color: var(--bad); }
  .stage { position: relative; border-radius: 16px; overflow: hidden; background: #000; border: 1px solid var(--line); box-shadow: 0 24px 70px -30px rgba(0,0,0,.9); }
  .stage video { display: block; width: 100%; height: auto; aspect-ratio: 16 / 9; background: #000; }
  .stage .poster { display: block; width: 100%; height: auto; aspect-ratio: 16 / 9; object-fit: cover; }
  .grid { display: grid; grid-template-columns: 1.55fr 1fr; gap: 18px; margin-top: 26px; }
  @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
  .card { background: linear-gradient(180deg, var(--panel), rgba(18,26,43,.72)); border: 1px solid var(--line); border-radius: 14px; padding: 20px 22px; }
  .card h2 { margin: 0 0 12px; font-size: 13px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  .card p { margin: 0; color: var(--text); }
  ol.steps { margin: 0; padding-left: 20px; color: var(--text); }
  ol.steps li { margin: 6px 0; }
  ol.steps li::marker { color: var(--accent); }
  .cta { display: inline-flex; align-items: center; gap: 8px; margin-top: 18px; padding: 11px 16px; border-radius: 10px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #06212b; font-weight: 700; text-decoration: none; }
  .cta:hover { filter: brightness(1.06); }
  .notice { border: 1px solid rgba(251,113,133,.4); background: rgba(251,113,133,.08); border-radius: 14px; padding: 18px 20px; margin-top: 22px; }
  .notice strong { color: var(--bad); display: block; margin-bottom: 6px; }
  footer { margin-top: 34px; color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 8px 14px; justify-content: space-between; }
  footer a { color: var(--accent-2); text-decoration: none; }
  footer a:hover { text-decoration: underline; }
  .muted { color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
${opts.body}
<footer>
  <span>Recorded with <a href="${esc(PUBLIC_BASE_URL)}">Reelforge</a> — self-hosted product demos.</span>
  <span class="muted">Share link valid for ${Math.round(SHARE_TOKEN_TTL_MS / 86_400_000)} days.</span>
</footer>
</div>
</body>
</html>`;
}

/** The article that belongs to this demo's flow/environment, if any. */
function articleForDemo(demo: DemoRow): ArticleRow | null {
  const flow = demo.environment_id
    ? one<{ id: string }>(
        'SELECT id FROM flows WHERE environment_id = ? ORDER BY first_seen_at DESC, rowid DESC LIMIT 1',
        demo.environment_id
      )
    : undefined;
  const byFlow = flow
    ? one<ArticleRow>(
        'SELECT * FROM articles WHERE workspace_id = ? AND flow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
        demo.workspace_id,
        flow.id
      )
    : undefined;
  if (byFlow) return byFlow;
  if (!demo.environment_id) return null;
  return (
    one<ArticleRow>(
      'SELECT * FROM articles WHERE workspace_id = ? AND environment_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      demo.workspace_id,
      demo.environment_id
    ) ?? null
  );
}

function articleLink(article: ArticleRow | null): { href: string; label: string } | null {
  if (!article) return null;
  const published = (article.published_url ?? '').trim();
  if (/^https?:\/\//i.test(published)) return { href: published, label: 'Read the step-by-step article' };
  // No public URL stored: the draft lives in this Reelforge dashboard.
  return {
    href: `${PUBLIC_BASE_URL}/app/#/articles/${encodeURIComponent(article.id)}`,
    label: 'Read the step-by-step article'
  };
}

function statusPill(status: DemoStatus): string {
  if (status === 'complete') return '<span class="pill good">● complete</span>';
  if (status === 'failed') return '<span class="pill bad">● failed</span>';
  if (status === 'cancelled') return '<span class="pill bad">● cancelled</span>';
  return '<span class="pill">● in progress</span>';
}

function goalSummary(outcome: Record<string, unknown> | null): string {
  if (!outcome) return '';
  const goalMet = outcome.goalMet === true;
  const steps = Array.isArray(outcome.whatWasShown) ? outcome.whatWasShown.filter((s) => typeof s === 'string') : [];
  const shown = steps.slice(0, 8) as string[];
  return `<div class="card">
  <h2>What this demo shows</h2>
  <p>${goalMet ? '<span class="pill good">✓ goal met</span>' : '<span class="pill">goal not confirmed</span>'}</p>
  ${shown.length > 0 ? `<ol class="steps">${shown.map((step) => `<li>${esc(step)}</li>`).join('')}</ol>` : ''}
</div>`;
}

/**
 * Render the share page for a demo row. Handles finished, in-progress and
 * failed demos, and degrades to a poster-only page if the MP4 is missing.
 */
export function renderSharePage(demo: DemoRow): string {
  const videoUrl = mediaUrl(demo.video_path);
  const posterUrl = mediaUrl(demo.poster_path);
  const outcome = safeJson<Record<string, unknown>>(demo.outcome_json);
  const failure = safeJson<DemoFailure>(demo.failure_json);
  const link = articleLink(articleForDemo(demo));
  const finished = demo.status === 'complete';

  const meta = [
    statusPill(demo.status),
    `<span>Recorded ${esc(formatDate(demo.finished_at ?? demo.created_at))}</span>`,
    `<span>Duration <strong>${esc(formatDuration(demo.duration_ms))}</strong></span>`
  ].join('\n    ');

  const stage = videoUrl
    ? `<div class="stage">
  <video controls preload="metadata" playsinline${posterUrl ? ` poster="${esc(posterUrl)}"` : ''}>
    <source src="${esc(videoUrl)}" type="video/mp4" />
    Your browser cannot play this MP4 — <a href="${esc(videoUrl)}">download it instead</a>.
  </video>
</div>`
    : posterUrl
      ? `<div class="stage"><img class="poster" src="${esc(posterUrl)}" alt="Poster frame for ${esc(demo.instruction)}" /></div>`
      : '';

  const failureNotice =
    demo.status === 'failed' && failure
      ? `<div class="notice"><strong>This run failed: ${esc(failure.code)}</strong>${esc(failure.message)}</div>`
      : '';

  const pendingNotice = finished
    ? ''
    : `<div class="notice"><strong>This demo is still ${esc(demo.status)}.</strong>Reload this link in a minute — the video appears here as soon as the render finishes.</div>`;

  const body = `<div class="brand"><span class="dot"></span> Reelforge demo</div>
<h1>${esc(demo.instruction)}</h1>
<div class="meta">
    ${meta}
</div>
${stage}
${failureNotice}
${pendingNotice}
<div class="grid">
  ${goalSummary(outcome) || '<div class="card"><h2>About</h2><p>This is a recorded walkthrough of a real product flow.</p></div>'}
  <div class="card">
    <h2>Keep going</h2>
    <p class="muted">${link ? 'The same recording powers a written, step-by-step guide.' : 'Every Reelforge recording is also turned into a Product Graph flow, a help-centre article and an in-app guide.'}</p>
    ${link ? `<a class="cta" href="${esc(link.href)}">${esc(link.label)} →</a>` : ''}
  </div>
</div>`;

  return pageShell({
    title: demo.instruction || 'Reelforge demo',
    description: `A ${formatDuration(demo.duration_ms)} recorded walkthrough of ${demo.target_url}.`,
    body
  });
}

function errorPage(title: string, message: string): string {
  return pageShell({
    title,
    body: `<div class="brand"><span class="dot"></span> Reelforge demo</div>
<h1>${esc(title)}</h1>
<div class="notice"><strong>${esc(title)}</strong>${esc(message)}</div>`
  });
}

/** GET /api/demos/:id/share payload (wire format frozen with the dashboard). */
export function shareLinkFor(demoId: string): { url: string; expiresAt: string } {
  const token = signShareToken(demoId);
  return {
    url: `${PUBLIC_BASE_URL}/api/share/${token}`,
    expiresAt: new Date(Date.now() + SHARE_TOKEN_TTL_MS).toISOString()
  };
}

export default async function shareRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/demos/:id/share', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    getDemoRow(auth, id); // 404s for another workspace's demo
    const link = shareLinkFor(id);
    return { message: 'Share link created — valid for 30 days.', data: link };
  });

  app.get('/api/share/:token', { config: { public: true } }, async (request, reply: FastifyReply) => {
    const { token } = request.params as { token: string };
    const verified = verifyShareToken(token);
    if (!verified) {
      reply.code(404).type(HTML_TYPE).header('cache-control', 'no-store');
      return reply.send(
        errorPage('This share link is invalid or has expired.', 'Ask the person who sent it for a fresh link — share links are valid for 30 days.')
      );
    }
    const demo = one<DemoRow>('SELECT * FROM demos WHERE id = ?', verified.demoId);
    if (!demo) {
      reply.code(404).type(HTML_TYPE).header('cache-control', 'no-store');
      return reply.send(errorPage('That demo is no longer available.', 'It may have been deleted from this Reelforge instance.'));
    }
    reply.type(HTML_TYPE).header('cache-control', 'no-store').header('x-robots-tag', 'noindex');
    return reply.send(renderSharePage(demo));
  });
}
