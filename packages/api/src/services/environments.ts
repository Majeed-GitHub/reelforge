import fs from 'node:fs';
import { encryptJson, decryptJson } from '../../../core/src/crypto.ts';
import { ApiError } from '../../../core/src/http.ts';
import { newId, newLoginCode, nowIso } from '../../../core/src/ids.ts';
import type { EnvironmentRow, LoginCodeRow, SignInMode } from '../../../core/src/types.ts';
import type { AuthContext } from '../auth.ts';
import { many, one, run } from '../dbq.ts';
import type { SessionBody } from '../schemas.ts';
import { notFound, validateStorageState } from '../util.ts';

const LOGIN_CODE_TTL_MS = 30 * 60 * 1000;

export type SecretRow = {
  environment_id: string;
  credentials: string | null;
  storage_state: string | null;
  captured_at: string | null;
};

export type EnvironmentView = EnvironmentRow & {
  hasSession: boolean;
  hasCredentials: boolean;
  capturedAt: string | null;
  flowCount: number;
  guideCount: number;
};

function toView(row: EnvironmentRow): EnvironmentView {
  const secret = one<SecretRow>('SELECT * FROM environment_secrets WHERE environment_id = ?', row.id);
  const flowCount = one<{ n: number }>('SELECT COUNT(*) AS n FROM flows WHERE environment_id = ?', row.id)?.n ?? 0;
  const guideCount = one<{ n: number }>('SELECT COUNT(*) AS n FROM guides WHERE environment_id = ?', row.id)?.n ?? 0;
  return {
    ...row,
    hasSession: Boolean(secret?.storage_state),
    hasCredentials: Boolean(secret?.credentials),
    capturedAt: secret?.captured_at ?? null,
    flowCount: Number(flowCount),
    guideCount: Number(guideCount)
  };
}

export function getEnvironmentRow(auth: AuthContext, id: string): EnvironmentRow {
  const row = one<EnvironmentRow>(
    'SELECT * FROM environments WHERE id = ? AND workspace_id = ?',
    id,
    auth.workspaceId
  );
  if (!row) throw notFound('environment', id);
  return row;
}

export function listEnvironments(auth: AuthContext): EnvironmentView[] {
  const rows = many<EnvironmentRow>(
    'SELECT * FROM environments WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC',
    auth.workspaceId
  );
  return rows.map(toView);
}

export function getEnvironment(auth: AuthContext, id: string): EnvironmentView & {
  screens: Array<{ id: string; url_path: string; title: string }>;
} {
  const row = getEnvironmentRow(auth, id);
  const screens = many<{ id: string; url_path: string; title: string }>(
    'SELECT id, url_path, title FROM screens WHERE environment_id = ? ORDER BY url_path ASC',
    id
  );
  return { ...toView(row), screens };
}

export function createEnvironment(
  auth: AuthContext,
  body: { name: string; baseUrl: string; signInMode?: SignInMode; credentials?: { username: string; password: string }; storageState?: unknown }
): EnvironmentView {
  let parsed: URL;
  try {
    parsed = new URL(body.baseUrl);
  } catch {
    throw new ApiError('VALIDATION_ERROR', '`baseUrl` must be an absolute URL, e.g. https://app.example.com', {
      action: 'fix_request',
      hint: 'baseUrl: absolute http(s) URL'
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError('VALIDATION_ERROR', '`baseUrl` must be http or https.', { action: 'fix_request' });
  }

  let signInMode: SignInMode = body.signInMode ?? 'none';
  if (body.credentials) signInMode = signInMode === 'none' ? 'password' : signInMode;
  if (body.storageState !== undefined) {
    const check = validateStorageState(body.storageState);
    if (!check.ok) {
      throw new ApiError('VALIDATION_ERROR', `Invalid storageState: ${check.problem}`, {
        action: 'fix_request',
        hint: 'Send a Playwright storageState object: { cookies: [...], origins: [...] }'
      });
    }
    signInMode = 'session';
  }

  const id = newId('env');
  const ts = nowIso();
  run(
    `INSERT INTO environments (id, workspace_id, name, base_url, sign_in_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    auth.workspaceId,
    body.name,
    parsed.toString(),
    signInMode,
    ts,
    ts
  );

  if (body.credentials || body.storageState !== undefined) {
    run(
      `INSERT INTO environment_secrets (environment_id, credentials, storage_state, captured_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(environment_id) DO UPDATE SET
         credentials = excluded.credentials,
         storage_state = excluded.storage_state,
         captured_at = excluded.captured_at`,
      id,
      body.credentials ? encryptJson(body.credentials) : null,
      body.storageState !== undefined ? encryptJson(body.storageState) : null,
      body.storageState !== undefined ? ts : null
    );
  }

  return toView(getEnvironmentRow(auth, id));
}

export function patchEnvironment(
  auth: AuthContext,
  id: string,
  body: { name?: string; baseUrl?: string; signInMode?: SignInMode }
): EnvironmentView {
  const current = getEnvironmentRow(auth, id);
  const name = body.name ?? current.name;
  const baseUrl = body.baseUrl ?? current.base_url;
  const signInMode = body.signInMode ?? current.sign_in_mode;
  if (body.baseUrl !== undefined) {
    try {
      const parsed = new URL(body.baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
    } catch {
      throw new ApiError('VALIDATION_ERROR', '`baseUrl` must be an absolute http(s) URL.', { action: 'fix_request' });
    }
  }
  run(
    'UPDATE environments SET name = ?, base_url = ?, sign_in_mode = ?, updated_at = ? WHERE id = ?',
    name,
    body.baseUrl ?? baseUrl,
    signInMode,
    nowIso(),
    id
  );
  return toView(getEnvironmentRow(auth, id));
}

/** Encrypt-and-store a captured Playwright storageState. */
export function setEnvironmentSession(auth: AuthContext, id: string, body: SessionBody): {
  ok: true;
  environmentId: string;
  signInMode: 'session';
  capturedAt: string;
  cookies: number;
  origins: number;
} {
  getEnvironmentRow(auth, id);
  const check = validateStorageState(body.storageState);
  if (!check.ok) {
    throw new ApiError('VALIDATION_ERROR', `Invalid storageState: ${check.problem}`, {
      action: 'fix_request',
      hint: 'Send { storageState: { cookies: [...], origins: [...] } } as captured by Playwright context.storageState({ indexedDB: true }).'
    });
  }
  const state = body.storageState as { cookies?: unknown[]; origins?: unknown[] };
  const ts = nowIso();
  run(
    `INSERT INTO environment_secrets (environment_id, credentials, storage_state, captured_at)
     VALUES (?, NULL, ?, ?)
     ON CONFLICT(environment_id) DO UPDATE SET storage_state = excluded.storage_state, captured_at = excluded.captured_at`,
    id,
    encryptJson(body.storageState),
    ts
  );
  run("UPDATE environments SET sign_in_mode = 'session', updated_at = ? WHERE id = ?", ts, id);
  return {
    ok: true,
    environmentId: id,
    signInMode: 'session',
    capturedAt: ts,
    cookies: Array.isArray(state.cookies) ? state.cookies.length : 0,
    origins: Array.isArray(state.origins) ? state.origins.length : 0
  };
}

/**
 * Structural verification only — deliberately does not launch a browser
 * (Director's `verify` documents the same cheap check; the recorder is the
 * thing that actually replays the session).
 */
export function verifyEnvironment(auth: AuthContext, id: string): {
  ok: boolean;
  environmentId: string;
  signInMode: SignInMode;
  checkedAt: string;
  cookies?: number;
  origins?: number;
  reason?: string;
} {
  const env = getEnvironmentRow(auth, id);
  const secret = one<SecretRow>('SELECT * FROM environment_secrets WHERE environment_id = ?', id);
  const checkedAt = nowIso();

  if (env.sign_in_mode === 'none') {
    return { ok: true, environmentId: id, signInMode: 'none', checkedAt, reason: 'No sign-in required.' };
  }
  if (!secret) {
    return {
      ok: false,
      environmentId: id,
      signInMode: env.sign_in_mode,
      checkedAt,
      reason: 'No stored session or credentials for this environment.'
    };
  }
  if (env.sign_in_mode === 'session') {
    if (!secret.storage_state) {
      return { ok: false, environmentId: id, signInMode: 'session', checkedAt, reason: 'No captured storageState.' };
    }
    try {
      const state = decryptJson<{ cookies?: unknown[]; origins?: unknown[] }>(secret.storage_state);
      const check = validateStorageState(state);
      if (!check.ok) {
        return { ok: false, environmentId: id, signInMode: 'session', checkedAt, reason: `Stored session is unusable: ${check.problem}` };
      }
      return {
        ok: true,
        environmentId: id,
        signInMode: 'session',
        checkedAt,
        cookies: Array.isArray(state.cookies) ? state.cookies.length : 0,
        origins: Array.isArray(state.origins) ? state.origins.length : 0
      };
    } catch {
      return {
        ok: false,
        environmentId: id,
        signInMode: 'session',
        checkedAt,
        reason: 'Stored session could not be decrypted (data/.secret may have changed). Capture a new session.'
      };
    }
  }
  if (!secret.credentials) {
    return { ok: false, environmentId: id, signInMode: env.sign_in_mode, checkedAt, reason: 'No stored credentials.' };
  }
  try {
    const creds = decryptJson<{ username?: string; password?: string }>(secret.credentials);
    if (!creds.username || !creds.password) {
      return { ok: false, environmentId: id, signInMode: env.sign_in_mode, checkedAt, reason: 'Stored credentials are incomplete.' };
    }
    return { ok: true, environmentId: id, signInMode: env.sign_in_mode, checkedAt };
  } catch {
    return {
      ok: false,
      environmentId: id,
      signInMode: env.sign_in_mode,
      checkedAt,
      reason: 'Stored credentials could not be decrypted (data/.secret may have changed).'
    };
  }
}

/** DIR-XXXX-XXXX-XXXX, single use, 30 minutes — the CLI capture handoff. */
export function createLoginCode(auth: AuthContext, id: string): { code: string; expiresAt: string; environmentId: string } {
  getEnvironmentRow(auth, id);
  const now = Date.now();
  run('DELETE FROM login_codes WHERE expires_at < ?', new Date(now).toISOString());
  const code = newLoginCode();
  const expiresAt = new Date(now + LOGIN_CODE_TTL_MS).toISOString();
  run('INSERT INTO login_codes (code, environment_id, expires_at, used_at) VALUES (?, ?, ?, NULL)', code, id, expiresAt);
  return { code, expiresAt, environmentId: id };
}

type PublicEnvironment = { environmentId: string; name: string; baseUrl: string; signInMode: SignInMode; expiresAt: string };

function resolveCode(code: string): { row: LoginCodeRow; env: EnvironmentRow } {
  const row = one<LoginCodeRow>('SELECT * FROM login_codes WHERE code = ?', code);
  if (!row) {
    throw new ApiError('NOT_FOUND', `Login code ${code} was not found.`, {
      action: 'create_login_code',
      hint: 'Codes are created per environment with POST /api/environments/:id/login-code.'
    });
  }
  const expired = Date.parse(row.expires_at) < Date.now();
  if (row.used_at || expired) {
    throw new ApiError(
      'ENVIRONMENT_SESSION_EXPIRED',
      row.used_at ? `Login code ${code} was already used.` : `Login code ${code} expired.`,
      { action: 'create_login_code', hint: 'Login codes are single use and expire after 30 minutes.' }
    );
  }
  const env = one<EnvironmentRow>('SELECT * FROM environments WHERE id = ?', row.environment_id);
  if (!env) throw notFound('environment', row.environment_id);
  return { row, env };
}

/** PUBLIC: the Director CLI resolves a code to the product it should capture. */
export function resolveLoginCode(code: string): PublicEnvironment {
  const { row, env } = resolveCode(code);
  return {
    environmentId: env.id,
    name: env.name,
    baseUrl: env.base_url,
    signInMode: env.sign_in_mode,
    expiresAt: row.expires_at
  };
}

/** PUBLIC: the Director CLI attaches the captured session, burning the code. */
export function redeemLoginCodeSession(code: string, body: SessionBody): {
  ok: true;
  environmentId: string;
  signInMode: 'session';
  capturedAt: string;
  cookies: number;
  origins: number;
} {
  const { row, env } = resolveCode(code);
  const check = validateStorageState(body.storageState);
  if (!check.ok) {
    throw new ApiError('VALIDATION_ERROR', `Invalid storageState: ${check.problem}`, {
      action: 'fix_request',
      hint: 'Send { storageState: { cookies: [...], origins: [...] }, indexedDB: true }'
    });
  }
  const state = body.storageState as { cookies?: unknown[]; origins?: unknown[] };
  const ts = nowIso();
  run(
    `INSERT INTO environment_secrets (environment_id, credentials, storage_state, captured_at)
     VALUES (?, NULL, ?, ?)
     ON CONFLICT(environment_id) DO UPDATE SET storage_state = excluded.storage_state, captured_at = excluded.captured_at`,
    env.id,
    encryptJson(body.storageState),
    ts
  );
  run("UPDATE environments SET sign_in_mode = 'session', updated_at = ? WHERE id = ?", ts, env.id);
  run('UPDATE login_codes SET used_at = ? WHERE code = ?', ts, row.code);
  return {
    ok: true,
    environmentId: env.id,
    signInMode: 'session',
    capturedAt: ts,
    cookies: Array.isArray(state.cookies) ? state.cookies.length : 0,
    origins: Array.isArray(state.origins) ? state.origins.length : 0
  };
}

/** The recorder needs the decrypted session; never exposed over HTTP. */
export function loadSignIn(auth: { workspaceId: string }, environmentId: string): {
  storageState?: unknown;
  credentials?: { username: string; password: string };
} {
  const env = one<EnvironmentRow>(
    'SELECT * FROM environments WHERE id = ? AND workspace_id = ?',
    environmentId,
    auth.workspaceId
  );
  if (!env) throw notFound('environment', environmentId);
  const secret = one<SecretRow>('SELECT * FROM environment_secrets WHERE environment_id = ?', environmentId);
  if (!secret) return {};
  const out: { storageState?: unknown; credentials?: { username: string; password: string } } = {};
  if (secret.storage_state) {
    try {
      out.storageState = decryptJson(secret.storage_state);
    } catch {
      /* corrupt secret: recorder falls back to the run's own credentials */
    }
  }
  if (secret.credentials) {
    try {
      out.credentials = decryptJson(secret.credentials);
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function environmentExists(workspaceId: string, id: string): EnvironmentRow | undefined {
  return one<EnvironmentRow>('SELECT * FROM environments WHERE id = ? AND workspace_id = ?', id, workspaceId);
}

export function dataDirHasSecretFile(): boolean {
  try {
    return fs.existsSync(new URL('../../../data/.secret', import.meta.url));
  } catch {
    return false;
  }
}