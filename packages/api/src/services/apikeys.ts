import { ApiError } from '../../../core/src/http.ts';
import { newId, nowIso } from '../../../core/src/ids.ts';
import type { ApiKeyRow } from '../../../core/src/types.ts';
import { generateApiKey, type AuthContext } from '../auth.ts';
import { many, one, run } from '../dbq.ts';
import { notFound } from '../util.ts';

export type ApiKeyView = Omit<ApiKeyRow, 'key_hash'>;

function toView(row: ApiKeyRow): ApiKeyView {
  const { key_hash: _hash, ...rest } = row;
  return rest;
}

export function listApiKeys(auth: AuthContext): ApiKeyView[] {
  return many<ApiKeyRow>(
    'SELECT * FROM api_keys WHERE workspace_id = ? ORDER BY created_at ASC, rowid ASC',
    auth.workspaceId
  ).map(toView);
}

/** The plaintext key is returned exactly once; only its sha256 is stored. */
export function createApiKey(auth: AuthContext, name: string): ApiKeyView & {
  key: string;
  plaintext: string;
  apiKey: string;
} {
  const generated = generateApiKey();
  const id = newId('key');
  const ts = nowIso();
  run(
    'INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)',
    id,
    auth.workspaceId,
    name,
    generated.prefix,
    generated.hash,
    ts
  );
  const row = one<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ?', id);
  if (!row) throw new ApiError('INTERNAL_ERROR', 'API key insert failed.');
  return { ...toView(row), key: generated.key, plaintext: generated.key, apiKey: generated.key };
}

export function revokeApiKey(auth: AuthContext, id: string): { id: string; revokedAt: string; revoked: true } {
  const row = one<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ? AND workspace_id = ?', id, auth.workspaceId);
  if (!row) throw notFound('api key', id);
  if (row.id === auth.apiKeyId) {
    throw new ApiError('VALIDATION_ERROR', 'You cannot revoke the key you are currently authenticated with.', {
      action: 'use_other_key',
      hint: 'Sign in with another key and revoke this one from there.'
    });
  }
  const ts = nowIso();
  run('UPDATE api_keys SET revoked_at = ? WHERE id = ?', ts, id);
  return { id, revokedAt: ts, revoked: true };
}