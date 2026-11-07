import type { z } from 'zod';
import { ApiError } from '../../core/src/http.ts';

/** Zod -> Director's VALIDATION_ERROR envelope. */
export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const hint = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
      .join('; ');
    throw new ApiError('VALIDATION_ERROR', `Invalid request body: ${hint}`, {
      action: 'fix_request',
      hint
    });
  }
  return result.data as z.infer<S>;
}

/** Cheap query-param coercion. */
export function intParam(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function safeJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Guard for values that must exist; throws Director's NOT_FOUND code. */
export function notFound(what: string, id?: string): ApiError {
  return new ApiError('NOT_FOUND', id ? `${what} ${id} was not found.` : `${what} was not found.`, {
    action: 'list_resources',
    hint: id ? `Check the id — GET /api/${what.toLowerCase()}s lists what your workspace owns.` : undefined
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural check for a Playwright storageState blob (no browser involved). */
export function validateStorageState(state: unknown): { ok: boolean; problem?: string } {
  if (!isRecord(state)) return { ok: false, problem: 'storageState must be a JSON object' };
  const cookies = state.cookies;
  const origins = state.origins;
  if (cookies === undefined && origins === undefined) {
    return { ok: false, problem: 'storageState needs a `cookies` and/or `origins` array' };
  }
  if (cookies !== undefined && !Array.isArray(cookies)) {
    return { ok: false, problem: 'storageState.cookies must be an array' };
  }
  if (origins !== undefined && !Array.isArray(origins)) {
    return { ok: false, problem: 'storageState.origins must be an array' };
  }
  const cookieList = Array.isArray(cookies) ? cookies : [];
  for (const cookie of cookieList) {
    if (!isRecord(cookie) || typeof cookie.name !== 'string') {
      return { ok: false, problem: 'each cookie needs a `name`' };
    }
  }
  const originList = Array.isArray(origins) ? origins : [];
  for (const origin of originList) {
    if (!isRecord(origin) || typeof origin.origin !== 'string') {
      return { ok: false, problem: 'each origin needs an `origin` string' };
    }
  }
  if (cookieList.length === 0 && originList.length === 0) {
    return { ok: false, problem: 'storageState has no cookies or origins to replay' };
  }
  return { ok: true };
}
