import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getDb } from '../../core/src/db.ts';
import { ApiError } from '../../core/src/http.ts';
import { nowIso, sha256 } from '../../core/src/ids.ts';
import type { ApiKeyRow } from '../../core/src/types.ts';

/**
 * API-key auth, Director-style: `X-API-Key: rg_<32 hex>` (or a Bearer token).
 * Only the sha256 of the key is stored; the plaintext exists exactly once, at
 * creation time, and is printed by `provisionApiKey`.
 */

export const KEY_PREFIX = 'rg_';
const KEY_RE = /^rg_[0-9a-f]{32}$/;

export type AuthContext = {
  workspaceId: string;
  apiKeyId: string;
  keyName: string;
  prefix: string;
};

export type AuthedRequest = FastifyRequest & { auth?: AuthContext };

export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = `${KEY_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
  return { key, hash: sha256(key), prefix: key.slice(0, 10) };
}

export function keyFromHeaders(headers: Record<string, unknown>): string | null {
  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  const authz = headers['authorization'];
  if (typeof authz === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authz.trim());
    if (match) return match[1].trim();
  }
  return null;
}

export function authenticate(headers: Record<string, unknown>): AuthContext {
  const key = keyFromHeaders(headers);
  if (!key) {
    throw new ApiError(
      'UNAUTHORIZED',
      'Missing API key. Send `X-API-Key: rg_…` or `Authorization: Bearer rg_…`.',
      { action: 'provide_api_key', hint: 'Create a key with POST /api/api-keys, or run `node packages/api/src/seed.ts`.' }
    );
  }
  if (!KEY_RE.test(key)) {
    throw new ApiError('UNAUTHORIZED', 'The API key is malformed — Reelforge keys look like rg_<32 hex>.', {
      action: 'provide_api_key',
      hint: 'Use the whole key, including the rg_ prefix; do not send a prefix or hash.'
    });
  }
  const row = getDb()
    .prepare('SELECT * FROM api_keys WHERE key_hash = ?')
    .get(sha256(key)) as unknown as ApiKeyRow | undefined;
  if (!row) {
    throw new ApiError('UNAUTHORIZED', 'That API key does not exist or does not belong to a workspace.', {
      action: 'provide_api_key',
      hint: 'Keys are shown once at creation. Create a new one with POST /api/api-keys.'
    });
  }
  if (row.revoked_at) {
    throw new ApiError('UNAUTHORIZED', 'That API key was revoked.', {
      action: 'create_api_key',
      hint: 'POST /api/api-keys to mint a replacement.'
    });
  }
  getDb().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
  return { workspaceId: row.workspace_id, apiKeyId: row.id, keyName: row.name, prefix: row.prefix };
}

/**
 * Global preHandler: every /api route is private unless it opts out with
 * `{ config: { public: true } }` (health, embed widget, CLI code redemption,
 * signed media). Non-/api paths are static assets (/app, /g) and are never
 * key-gated — a browser cannot attach headers to a `<script src>`.
 */
export function attachAuth(app: FastifyInstance): void {
  app.addHook('preHandler', async (request) => {
    const pathname = (request.url ?? '').split('?')[0];
    const isApiRoute = pathname === '/api' || pathname.startsWith('/api/');
    if (!isApiRoute) return;
    const config = (request.routeOptions?.config ?? {}) as { public?: boolean };
    if (config.public) return;
    (request as AuthedRequest).auth = authenticate(request.headers as Record<string, unknown>);
  });
}

export function authOf(request: FastifyRequest): AuthContext {
  const ctx = (request as AuthedRequest).auth;
  if (!ctx) {
    throw new ApiError('UNAUTHORIZED', 'This route requires an API key.', { action: 'provide_api_key' });
  }
  return ctx;
}