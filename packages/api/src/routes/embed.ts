/**
 * Embeddable player + view analytics.
 *
 *   GET /embed/:token                 (no auth)  iframe-able 16:9 player
 *   GET /api/demos/:id/embed          (auth)     { url, iframe }
 *   GET /api/demos/:id/analytics      (auth)     view counts
 *
 * This is the only route in the API that is allowed to be framed. The
 * permission is scoped to this one handler: it sends
 * `Content-Security-Policy: frame-ancestors *` and never touches
 * `X-Frame-Options` for any other route. `/app`, `/api/*` and the share page
 * keep their existing headers exactly as they were.
 *
 * The player is plain HTML + native `<video>`, no JavaScript: autoplay / muted /
 * loop are attributes, and `start=<seconds>` uses an MP4 media fragment
 * (`#t=`), so the page works even with scripting disabled and adds no runtime
 * download. Captions are a real `<track>` pointing at the demo's latest
 * completed WebVTT export when one exists.
 *
 * Every embed load is counted via services/analytics.ts (one row; no IP, no
 * User-Agent string, no cookie).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { PUBLIC_BASE_URL } from '../../../core/src/config.ts';
import { ok } from '../../../core/src/http.ts';
import type { DemoRow } from '../../../core/src/types.ts';
import { authOf } from '../auth.ts';
import { one } from '../dbq.ts';
import { getDemoAnalytics, recordView } from '../services/analytics.ts';
import { getDemoRow } from '../services/demos.ts';
import { mediaUrl, signEmbedToken, verifyEmbedToken } from '../signing.ts';

const HTML_TYPE = 'text/html; charset=utf-8';

/** Only /embed is frameable. Nothing else sets this header. */
const FRAME_CSP = 'frame-ancestors *';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function flag(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalised = value.trim().toLowerCase();
  return normalised === '1' || normalised === 'true' || normalised === 'yes' || normalised === 'on';
}

function offFlag(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalised = value.trim().toLowerCase();
  return normalised === '0' || normalised === 'false' || normalised === 'no' || normalised === 'off';
}

function clampedStart(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(Math.floor(seconds), 86_400);
}

type EmbedOptions = {
  autoplay: boolean;
  /** autoplay always implies muted — browsers block audible autoplay. */
  muted: boolean;
  loop: boolean;
  startSeconds: number | null;
  badge: boolean;
};

function parseEmbedOptions(query: Record<string, unknown>): EmbedOptions {
  const autoplay = flag(query.autoplay);
  return {
    autoplay,
    // autoplay implies muted (browsers block audible autoplay); otherwise muted=1.
    muted: autoplay ? true : flag(query.muted),
    loop: flag(query.loop),
    startSeconds: clampedStart(query.start),
    badge: query.badge === undefined ? true : !offFlag(query.badge)
  };
}

/** Latest completed WebVTT export for a demo, as a signed URL (or null). */
function latestVttUrl(demoId: string): string | null {
  try {
    const row = one<{ path: string | null }>(
      `SELECT path FROM demo_exports
        WHERE demo_id = ? AND kind = 'vtt' AND status = 'complete' AND path IS NOT NULL
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1`,
      demoId
    );
    return row?.path ? mediaUrl(row.path) : null;
  } catch {
    // The exports table may not exist in a partial deployment; captions are optional.
    return null;
  }
}

const EMBED_STYLE = `
html, body { height: 100%; margin: 0; background: #000; }
body {
  display: grid;
  place-items: center;
  overflow: hidden;
  color: #e8eefc;
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.rf-player { position: relative; width: 100%; height: 100%; display: grid; place-items: center; background: #000; }
.rf-player video {
  display: block;
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  aspect-ratio: 16 / 9;
  object-fit: contain;
  background: #000;
}
.rf-badge {
  position: absolute;
  right: 10px;
  bottom: 10px;
  z-index: 2;
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(11, 18, 32, .62);
  border: 1px solid rgba(147, 163, 196, .28);
  color: rgba(232, 238, 252, .82);
  font-size: 11.5px;
  letter-spacing: .02em;
  text-decoration: none;
  backdrop-filter: blur(6px);
  transition: opacity .15s ease;
}
.rf-badge:hover { color: #fff; background: rgba(11, 18, 32, .82); }
.rf-empty { max-width: 520px; margin: 0 auto; padding: 28px; text-align: center; color: #93a3c4; }
.rf-empty h1 { margin: 0 0 10px; font-size: 20px; color: #e8eefc; }
.rf-empty a { color: #5eead4; }
@media (prefers-reduced-motion: reduce) { .rf-badge { transition: none; } }
`;

function pageShell(opts: { title: string; body: string; extraHead?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(opts.title)}</title>
<style>${EMBED_STYLE}</style>
${opts.extraHead ?? ''}
</head>
<body>
${opts.body}
</body>
</html>`;
}

function errorPage(title: string, message: string): string {
  return pageShell({
    title,
    body: `<div class="rf-empty"><h1>${esc(title)}</h1><p>${esc(message)}</p></div>`
  });
}

/** Render the framed player for one demo. */
export function renderEmbedPage(
  demo: DemoRow,
  options: EmbedOptions,
  captionsUrl: string | null
): string {
  const videoUrl = mediaUrl(demo.video_path);
  const posterUrl = mediaUrl(demo.poster_path);
  const title = String(demo.instruction ?? '').trim() || 'Reelforge demo';

  if (!videoUrl) {
    const poster = posterUrl
      ? `<img src="${esc(posterUrl)}" alt="${esc(title)}" style="max-width:100%;height:auto;border-radius:12px" />`
      : '';
    return pageShell({
      title,
      body: `<div class="rf-empty"><h1>${esc(title)}</h1><p>This demo is not ready yet — the recording is still ${esc(demo.status)}.</p>${poster}</div>`
    });
  }

  const startSrc = options.startSeconds !== null ? `${videoUrl}#t=${options.startSeconds}` : videoUrl;
  const track = captionsUrl
    ? `\n      <track kind="captions" src="${esc(captionsUrl)}" srclang="en" label="English" default />`
    : '';
  const badge = options.badge
    ? `\n    <a class="rf-badge" href="${esc(PUBLIC_BASE_URL)}" target="_blank" rel="noopener noreferrer">Made with Reelforge</a>`
    : '';

  return pageShell({
    title,
    extraHead: `<meta name="description" content="${esc(title)}" />`,
    body: `<div class="rf-player">
    <video id="rf-demo" aria-label="${esc(title)}" controls playsinline preload="metadata" crossorigin="anonymous"${posterUrl ? ` poster="${esc(posterUrl)}"` : ''}${options.autoplay ? ' autoplay' : ''}${options.muted ? ' muted' : ''}${options.loop ? ' loop' : ''}>
      <source src="${esc(startSrc)}" type="video/mp4" />${track}
      <p>Your browser cannot play this video. <a href="${esc(videoUrl)}">Download the MP4</a>.</p>
    </video>${badge}
  </div>`
  });
}

export default async function embedRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Public, iframe-able player
  // -------------------------------------------------------------------------
  app.get('/embed/:token', async (request, reply: FastifyReply) => {
    const { token } = request.params as { token: string };
    const verified = verifyEmbedToken(token);

    // Framing is allowed even for error pages: an embedding site should show a
    // readable message instead of a broken iframe. Scoped to this route only.
    reply.header('content-security-policy', FRAME_CSP).header('x-content-type-options', 'nosniff').header('x-robots-tag', 'noindex');

    if (!verified) {
      reply.code(404).type(HTML_TYPE).header('cache-control', 'no-store');
      return reply.send(
        errorPage('This embed link is invalid or has expired.', 'Ask the person who shared it for a fresh embed code.')
      );
    }

    const demo = one<DemoRow>('SELECT * FROM demos WHERE id = ?', verified.demoId);
    if (!demo) {
      reply.code(404).type(HTML_TYPE).header('cache-control', 'no-store');
      return reply.send(errorPage('That demo is no longer available.', 'It may have been deleted from this Reelforge instance.'));
    }

    // One row per load; bots are dropped inside analytics. Never blocks the page.
    recordView(demo.id, 'embed', request.headers['user-agent']);

    reply.type(HTML_TYPE).header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    return reply.send(renderEmbedPage(demo, parseEmbedOptions(request.query as Record<string, unknown>), latestVttUrl(demo.id)));
  });

  // -------------------------------------------------------------------------
  // Embed code for the owner
  // -------------------------------------------------------------------------
  app.get('/api/demos/:id/embed', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    const demo = getDemoRow(auth, id);
    const url = `${PUBLIC_BASE_URL}/embed/${signEmbedToken(demo.id)}`;
    const title = esc(demo.instruction || 'Reelforge demo');
    const iframe =
      `<iframe src="${esc(url)}" width="640" height="360" title="${title}" loading="lazy" ` +
      `allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen ` +
      `referrerpolicy="no-referrer" style="border:0;width:100%;max-width:960px;aspect-ratio:16/9"></iframe>`;
    return ok({ url, iframe }, 'Embed ready — paste the iframe snippet wherever the demo should appear.');
  });

  // -------------------------------------------------------------------------
  // View counts for the owner
  // -------------------------------------------------------------------------
  app.get('/api/demos/:id/analytics', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    const demo = getDemoRow(auth, id);
    return ok(getDemoAnalytics(demo.id), 'OK');
  });
}
