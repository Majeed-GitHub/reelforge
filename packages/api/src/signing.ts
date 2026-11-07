import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, PUBLIC_BASE_URL, absoluteFromData, relativeToData } from '../../core/src/config.ts';
import { secretKey } from '../../core/src/crypto.ts';

/**
 * Signed, expiring media URLs.
 *
 * Director hands the dashboard a plain video URL; self-hosted Reelforge can't
 * rely on auth headers for `<video src>` / `<img src>`, so media is served from
 * `GET /api/files/:token` where the token is an HMAC-SHA256 claim over
 * { path, expiry } signed with the same local secret that encrypts sessions.
 * No auth header, no public bucket, 1 hour TTL.
 */

const TOKEN_TTL_MS = 60 * 60 * 1000;

type FileClaims = { p: string; e: number };

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function hmac(payload: string): string {
  return crypto.createHmac('sha256', secretKey()).update(payload).digest('hex');
}

/** Absolute path (inside data/) -> token. Path is stored relative to data/. */
export function signFileToken(absPath: string, ttlMs: number = TOKEN_TTL_MS): string {
  const rel = relativeToData(absPath) ?? absPath;
  const claims: FileClaims = { p: rel.split(path.sep).join('/'), e: Date.now() + ttlMs };
  const payload = b64url(JSON.stringify(claims));
  return `${payload}.${hmac(payload)}`;
}

export type VerifiedToken = { absPath: string; relPath: string };

export function verifyFileToken(token: string): VerifiedToken | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = hmac(payload);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'))) return null;
  let claims: FileClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as FileClaims;
  } catch {
    return null;
  }
  if (!claims || typeof claims.p !== 'string' || typeof claims.e !== 'number') return null;
  if (Date.now() > claims.e) return null;
  const absPath = path.resolve(absoluteFromData(claims.p) ?? '');
  // Containment: a signed token must never escape the data directory.
  const root = path.resolve(PATHS.data);
  const rel = path.relative(root, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return { absPath, relPath: claims.p };
}

/** Public URL for a stored media path (absolute or data-relative), or null. */
export function mediaUrl(storedPath: string | null | undefined): string | null {
  if (!storedPath) return null;
  const abs = absoluteFromData(storedPath);
  if (!abs) return null;
  if (!fs.existsSync(abs)) return null;
  return `${PUBLIC_BASE_URL}/api/files/${signFileToken(abs)}`;
}

export const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

export function mimeForPath(absPath: string): string {
  return MIME_BY_EXT[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
}

export { TOKEN_TTL_MS };