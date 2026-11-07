import crypto from 'node:crypto';
import { ApiError } from '../../../core/src/http.ts';
import { newId, nowIso } from '../../../core/src/ids.ts';
import type { DomainRow } from '../../../core/src/types.ts';
import type { AuthContext } from '../auth.ts';
import { many, one, run } from '../dbq.ts';
import { notFound } from '../util.ts';

const TXT_PREFIX = '_reelforge-challenge';

function newVerificationToken(): string {
  return crypto.randomBytes(12).toString('hex');
}

export type DomainView = DomainRow & {
  attested: boolean;
  verified: boolean;
  verificationRecord: { type: 'TXT'; name: string; value: string };
};

function toView(row: DomainRow): DomainView {
  return {
    ...row,
    attested: Boolean(row.attested_at),
    verified: Boolean(row.verified_at),
    verificationRecord: { type: 'TXT', name: `${TXT_PREFIX}.${row.host}`, value: row.verification_token }
  };
}

export function normalizeHost(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new ApiError('VALIDATION_ERROR', 'A host is required.', { action: 'fix_request', hint: 'e.g. "app.example.com"' });
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    throw new ApiError('VALIDATION_ERROR', `\`${raw}\` is not a valid host.`, { action: 'fix_request', hint: 'e.g. "app.example.com"' });
  }
}

export function listDomains(auth: AuthContext): DomainView[] {
  return many<DomainRow>(
    'SELECT * FROM domains WHERE workspace_id = ? ORDER BY host ASC',
    auth.workspaceId
  ).map(toView);
}

/** POST /api/domains/attest — the one-time "I may record this" confirmation. */
export function attestDomain(auth: AuthContext, input: { host: string; authorized?: boolean }): DomainView {
  const host = normalizeHost(input.host);
  const ts = nowIso();
  const existing = one<DomainRow>('SELECT * FROM domains WHERE workspace_id = ? AND host = ?', auth.workspaceId, host);
  if (existing) {
    run('UPDATE domains SET attested_at = COALESCE(attested_at, ?) WHERE id = ?', ts, existing.id);
    return toView(one<DomainRow>('SELECT * FROM domains WHERE id = ?', existing.id)!);
  }
  const id = newId('dom');
  run(
    'INSERT INTO domains (id, workspace_id, host, attested_at, verification_token, verified_at) VALUES (?, ?, ?, ?, ?, NULL)',
    id,
    auth.workspaceId,
    host,
    input.authorized === false ? null : ts,
    newVerificationToken()
  );
  return toView(one<DomainRow>('SELECT * FROM domains WHERE id = ?', id)!);
}

/** POST /api/domains/verification — mint (or return) the DNS TXT challenge. */
export function startDomainVerification(auth: AuthContext, input: { host: string }): DomainView & { instructions: string } {
  const host = normalizeHost(input.host);
  let row = one<DomainRow>('SELECT * FROM domains WHERE workspace_id = ? AND host = ?', auth.workspaceId, host);
  if (!row) {
    const id = newId('dom');
    run(
      'INSERT INTO domains (id, workspace_id, host, attested_at, verification_token, verified_at) VALUES (?, ?, ?, NULL, ?, NULL)',
      id,
      auth.workspaceId,
      host,
      newVerificationToken()
    );
    row = one<DomainRow>('SELECT * FROM domains WHERE id = ?', id)!;
  }
  return {
    ...toView(row),
    instructions: `Publish a DNS TXT record: ${TXT_PREFIX}.${row.host} = ${row.verification_token}, then POST /api/domains/verification/check {"host":"${host}"}.`
  };
}

/**
 * POST /api/domains/verification/check — real DNS lookup, tolerant of offline
 * installs: if the lookup fails we report verified:false with the exact record
 * instead of throwing, so the dashboard can show what is missing.
 */
export async function checkDomainVerification(
  auth: AuthContext,
  input: { host: string; token?: string }
): Promise<{ ok: boolean; host: string; verified: boolean; checkedAt: string; record: { type: 'TXT'; name: string; value: string }; detail: string }> {
  const host = normalizeHost(input.host);
  const row = one<DomainRow>('SELECT * FROM domains WHERE workspace_id = ? AND host = ?', auth.workspaceId, host);
  if (!row) {
    throw new ApiError('NOT_FOUND', `Domain ${host} is not registered for this workspace.`, {
      action: 'start_verification',
      hint: 'POST /api/domains/verification {"host":"…"} first.'
    });
  }
  const expected = input.token ?? row.verification_token;
  const record = { type: 'TXT' as const, name: `${TXT_PREFIX}.${row.host}`, value: expected };
  const checkedAt = nowIso();

  if (input.token && input.token !== row.verification_token) {
    return { ok: false, host, verified: false, checkedAt, record, detail: 'The supplied token does not match the challenge for this host.' };
  }

  let records: string[][] = [];
  let lookupError = '';
  try {
    const dns = await import('node:dns/promises');
    const timeout = new Promise<string[][]>((_resolve, reject) => {
      setTimeout(() => reject(new Error('DNS lookup timed out')), 4000).unref?.();
    });
    records = await Promise.race([dns.resolveTxt(record.name), timeout]);
  } catch (error) {
    lookupError = error instanceof Error ? error.message : String(error);
  }

  const values = records.map((chunks) => chunks.join(''));
  const verified = values.includes(expected);
  if (verified) {
    run('UPDATE domains SET verified_at = ?, attested_at = COALESCE(attested_at, ?) WHERE id = ?', checkedAt, checkedAt, row.id);
  }
  return {
    ok: verified,
    host,
    verified,
    checkedAt,
    record,
    detail: verified
      ? 'TXT record matched — domain ownership verified.'
      : lookupError
        ? `Could not read ${record.name} (${lookupError}). Publish the record above and retry.`
        : `Found ${values.length} TXT record(s) at ${record.name}, none matching the challenge.`
  };
}

export function requireDomain(auth: AuthContext, host: string): DomainRow {
  const row = one<DomainRow>('SELECT * FROM domains WHERE workspace_id = ? AND host = ?', auth.workspaceId, host);
  if (!row) throw notFound('domain', host);
  return row;
}