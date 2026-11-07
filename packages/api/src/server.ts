import fs from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { API_PORT, PATHS, ROOT } from '../../core/src/config.ts';
import { closeDb, getDb } from '../../core/src/db.ts';
import { ApiError, err } from '../../core/src/http.ts';
import { attachAuth } from './auth.ts';
import { activeRuns, isWorkerRunning, startWorker, stopWorker, workerCapacity } from './queue.ts';
import articleRoutes from './routes/articles.ts';
import demoRoutes from './routes/demos.ts';
import exportRoutes from './routes/exports.ts';
import shareRoutes from './routes/share.ts';
import walkthroughRoutes from './routes/walkthrough.ts';
import embedRoutes from './routes/embed.ts';
import domainRoutes from './routes/domains.ts';
import environmentRoutes from './routes/environments.ts';
import fileRoutes from './routes/files.ts';
import graphRoutes from './routes/graph.ts';
import guideRoutes from './routes/guides.ts';
import healthRoutes, { FEATURES, SERVICE, VERSION } from './routes/health.ts';
import mcpRoutes from './routes/mcp.ts';
import presetRoutes from './routes/presets.ts';
import providerRoutes from './routes/providers.ts';
import settingsRoutes from './routes/settings.ts';
import { webhookRoutes } from './services/webhooks.ts';

/**
 * Reelforge API server.
 *
 *   node --env-file-if-exists=.env packages/api/src/server.ts
 *
 * Everything is in one process by default: Fastify + the in-process demo queue
 * (set REELFORGE_WORKER=off to run the API without a recorder, or use
 * `packages/api/src/worker/main.ts` standalone).
 */

const GUIDE_DIST = path.join(ROOT, 'packages', 'guide', 'dist');

export type BuildOptions = { logger?: boolean };

export async function buildServer(options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: process.env.REELFORGE_LOG_LEVEL ?? 'info'
          },
    bodyLimit: 8 * 1024 * 1024,
    // Signed media tokens are base64url claims + HMAC (~200 chars), far past
    // Fastify's 100-char default, so raise the param cap for /api/files/:token.
    // (routerOptions is the non-deprecated spelling; the top-level form emits
    // FSTDEP022 on Fastify 5.12+.)
    routerOptions: { maxParamLength: 3000 }
  });

  // Bodyless POSTs (reverify, cancel, publish, verify) are normal, but clients
  // still send `Content-Type: application/json` with no body â€” Fastify's stock
  // parser rejects that with FST_ERR_CTP_EMPTY_JSON_BODY. Treat an empty body
  // as `{}`; anything else is still parsed strictly.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (text === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      const parseError = Object.assign(new Error('Body is not valid JSON.'), {
        statusCode: 400,
        code: 'FST_ERR_CTP_INVALID_JSON_BODY'
      });
      done(parseError);
    }
  });

  await app.register(cors, {
    origin: true,
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: [
      'content-type',
      'accept',
      'x-api-key',
      'authorization',
      'mcp-protocol-version',
      'mcp-session-id',
      'last-event-id'
    ],
    exposedHeaders: ['mcp-session-id', 'content-range', 'accept-ranges'],
    maxAge: 86400
  });

  // --- error envelope: { code, message, remediation } -----------------------
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) {
      reply.code(error.status).send(err(error.code, error.message, error.remediation));
      return;
    }
    const failure = error as { statusCode?: unknown; code?: string; message?: string };
    const statusCode = typeof failure.statusCode === 'number' ? failure.statusCode : 500;
    const code = failure.code;
    const message =
      typeof failure.message === 'string' && failure.message.trim() ? failure.message : 'Request failed.';

    if (
      code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
      code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE'
    ) {
      reply.code(400).send(
        err('VALIDATION_ERROR', 'The request body is not valid JSON.', {
          action: 'fix_request',
          hint: 'Send `Content-Type: application/json` with a JSON object body.'
        })
      );
      return;
    }
    if (code === 'FST_ERR_VALIDATION') {
      reply
        .code(400)
        .send(err('VALIDATION_ERROR', message, { action: 'fix_request', hint: message }));
      return;
    }
    if (code === 'FST_ERR_BAD_URL') {
      reply.code(400).send(err('VALIDATION_ERROR', 'Malformed URL in the request path.', { action: 'fix_request' }));
      return;
    }
    if (statusCode >= 500) request.log.error({ err: error }, 'unhandled error');
    reply.code(statusCode).send(
      err(statusCode >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR', message, {
        action: statusCode >= 500 ? 'retry' : 'fix_request',
        hint: statusCode >= 500 ? 'Check the server log; retry the request.' : undefined
      })
    );
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(
      err('NOT_FOUND', `No route matches ${request.method} ${request.url}.`, {
        action: 'list_endpoints',
        hint: `GET /api/health lists features (${FEATURES.join(', ')}); docs live in docs/ARCHITECTURE.md.`
      })
    );
  });

  // --- auth (all routes private unless they opt out) ------------------------
  attachAuth(app);

  // --- REST surface ---------------------------------------------------------
  await app.register(healthRoutes);
  await app.register(demoRoutes);
  // v0.2 outputs: GIF/VTT exports, public share pages, webhook config + delivery
  await app.register(exportRoutes);
  await app.register(shareRoutes);
  // Interactive walkthrough output: one self-contained HTML file per demo.
  await app.register(walkthroughRoutes);
  // Embeddable player (/embed/:token) + per-demo analytics.
  await app.register(embedRoutes);
  await app.register(webhookRoutes);
  await app.register(environmentRoutes);
  await app.register(domainRoutes);
  await app.register(graphRoutes);
  await app.register(articleRoutes);
  await app.register(guideRoutes);
  await app.register(presetRoutes);
  await app.register(settingsRoutes);
  // v0.2 BYOK: provider catalog, encrypted workspace keys, model discovery, probes
  await app.register(providerRoutes);
  await app.register(fileRoutes);
  await app.register(mcpRoutes);

  // --- static: dashboard at /app, embed widget at /g -----------------------
  const mountStatic = async (): Promise<void> => {
    if (fs.existsSync(PATHS.webDist)) {
      await app.register(fastifyStatic, {
        root: PATHS.webDist,
        prefix: '/app/',
        decorateReply: false,
        index: ['index.html'],
        wildcard: true
      });
      // Bare /app -> /app/ so the assets' absolute /app/... base resolves.
      app.get('/app', async (_request, reply) => reply.redirect('/app/', 302));
    } else {
      const placeholder = async () => ({
        message: 'The dashboard has not been built yet.',
        data: {
          hint: 'Build packages/web (vite build), then restart the API â€” the API itself is fully functional.',
          expectedDir: PATHS.webDist
        }
      });
      app.get('/app', placeholder);
      app.get('/app/*', placeholder);
    }

    if (fs.existsSync(GUIDE_DIST)) {
      await app.register(fastifyStatic, {
        root: GUIDE_DIST,
        prefix: '/g/',
        decorateReply: false,
        index: ['demo.html'],
        wildcard: true
      });
      app.get('/g', async (_request, reply) => reply.redirect('/g/demo.html', 302));
    } else {
      const placeholder = async () => ({
        message: 'The embeddable guide widget has not been built yet.',
        data: { hint: 'Run `node packages/guide/build.mjs`, then restart the API.', expectedDir: GUIDE_DIST }
      });
      app.get('/g', placeholder);
      app.get('/g/*', placeholder);
    }
  };
  await mountStatic();

  // --- liveness ------------------------------------------------------------
  app.get('/api/status', async () => ({
    message: 'OK',
    data: {
      service: SERVICE,
      version: VERSION,
      worker: { running: isWorkerRunning(), concurrency: workerCapacity(), active: activeRuns() },
      features: [...FEATURES]
    }
  }));

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  getDb();
  const app = await buildServer();
  const host = process.env.REELFORGE_HOST ?? '127.0.0.1';

  await app.listen({ port: API_PORT, host });

  const workerEnabled = (process.env.REELFORGE_WORKER ?? 'on').toLowerCase() !== 'off';
  if (workerEnabled) startWorker();
  else console.log('[api] worker disabled (REELFORGE_WORKER=off) â€” run packages/api/src/worker/main.ts separately');

  console.log(`[api] Reelforge ${VERSION} listening on http://${host}:${API_PORT} (base ${`http://${host}:${API_PORT}`}/api)`);
  console.log(`[api] data dir: ${PATHS.data}`);
  console.log(`[api] dashboard: ${fs.existsSync(PATHS.webDist) ? '/app' : '/app (not built yet)'} Â· guide widget: ${fs.existsSync(GUIDE_DIST) ? '/g/demo.html' : '/g (not built yet)'}`);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`[api] ${signal} received â€” shutting down`);
    await stopWorker();
    await app.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return app;
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (invokedDirectly) {
  startServer().catch((error: unknown) => {
    console.error('[api] failed to start:', error);
    process.exit(1);
  });
}