/**
 * Clickable walkthrough routes.
 *
 *   POST /api/demos/:id/walkthrough   (auth) -> { url, bytes, steps }
 *   GET  /api/walkthrough/:token      (public) -> the self-contained HTML file
 *
 * Generation is synchronous (string building + a few file reads); the output is
 * recorded in `demo_exports` with kind `walkthrough`, so
 * `GET /api/demos/:id/exports` lists it next to GIF/VTT and the dashboard can
 * open it like any other export (signed `/api/files/<token>` URL; `.html` is
 * mapped to `text/html` in signing.ts).
 *
 * The public URL is HMAC-signed over the export id (90-day TTL) so it can be
 * pasted anywhere, but the file itself is the real deliverable: it works with
 * no server at all once saved.
 */
import fs from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { PUBLIC_BASE_URL, absoluteFromData } from '../../../core/src/config.ts';
import { ok } from '../../../core/src/http.ts';
import type { DemoRow } from '../../../core/src/types.ts';
import { authOf } from '../auth.ts';
import { one } from '../dbq.ts';
import { recordView } from '../services/analytics.ts';
import { getDemoRow } from '../services/demos.ts';
import { generateWalkthrough } from '../services/walkthrough.ts';
import { signWalkthroughToken, verifyWalkthroughToken } from '../signing.ts';

const HTML_TYPE = 'text/html; charset=utf-8';

/** Minimal self-contained error page (same no-external-assets rule as the output). */
function errorPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${title.replace(/[<>&"]/g, '')}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1220; color: #e8eefc;
         font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 24px; }
  main { max-width: 560px; border: 1px solid #24314d; border-radius: 16px; background: #121a2b; padding: 32px; }
  h1 { margin: 0 0 12px; font-size: 24px; }
  p { margin: 0; color: #93a3c4; }
</style>
</head>
<body><main><h1>${title}</h1><p>${message}</p></main></body>
</html>`;
}

export default async function walkthroughRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/demos/:id/walkthrough', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    const demo: DemoRow = getDemoRow(auth, id);
    const generated = generateWalkthrough(demo);
    const token = signWalkthroughToken(generated.id);
    return ok(
      {
        url: `${PUBLIC_BASE_URL}/api/walkthrough/${token}`,
        bytes: generated.bytes,
        steps: generated.steps
      },
      `Walkthrough generated — ${generated.steps} steps, ${(generated.bytes / 1024).toFixed(0)} KB, one self-contained file.`
    );
  });

  app.get('/api/walkthrough/:token', { config: { public: true } }, async (request, reply: FastifyReply) => {
    const { token } = request.params as { token: string };
    const verified = verifyWalkthroughToken(token);
    if (!verified) {
      reply.code(404).type(HTML_TYPE).header('cache-control', 'no-store');
      return reply.send(
        errorPage('This walkthrough link is invalid or has expired.', 'Ask the person who shared it for a fresh link.')
      );
    }

    const row = one<{ id: string; demo_id: string; path: string | null; status: string }>(
      "SELECT id, demo_id, path, status FROM demo_exports WHERE id = ? AND kind = 'walkthrough'",
      verified.exportId
    );
    const absPath = row?.path ? absoluteFromData(row.path) : null;
    if (!row || row.status !== 'complete' || !absPath || !fs.existsSync(absPath)) {
      reply.code(404).type(HTML_TYPE).header('cache-control', 'no-store');
      return reply.send(
        errorPage('That walkthrough is no longer available.', 'The generated file may have been deleted from this Reelforge instance.')
      );
    }

    // One analytics row per walkthrough load (no IP, no User-Agent stored).
    recordView(row.demo_id, 'walkthrough', request.headers['user-agent']);

    reply
      .type(HTML_TYPE)
      .header('cache-control', 'private, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .header('x-robots-tag', 'noindex');
    return reply.send(fs.createReadStream(absPath));
  });
}
