import type { FastifyInstance } from 'fastify';

export const VERSION = '0.1.0';
export const SERVICE = 'reelforge';
/** The CLI feature-gates itself on this list (Director parity). */
export const FEATURES = ['environments', 'login-codes', 'graph', 'guides', 'mcp'] as const;

/**
 * Director's `/health` is a bare object — the CLI reads `features` at the top
 * level to feature-gate itself. Dashboards in this repo read `data.*`. The
 * response carries both so neither client has to special-case it.
 */
function healthPayload(): Record<string, unknown> {
  const payload = { version: VERSION, service: SERVICE, features: [...FEATURES] };
  return { ...payload, message: 'OK', data: payload };
}

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  const handler = async () => healthPayload();
  // Director's base URL already contains /api, so both spellings are served.
  app.get('/api/health', { config: { public: true } }, handler);
  app.get('/health', { config: { public: true } }, handler);
}