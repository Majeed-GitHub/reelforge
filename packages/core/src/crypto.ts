import crypto from 'node:crypto';
import fs from 'node:fs';
import { PATHS, ensureDirs } from './config.ts';

let cachedKey: Buffer | null = null;

/**
 * Local secret used to encrypt stored sign-ins (cookies/localStorage) and
 * one-off credentials. Self-hosted: a 32-byte keyfile under data/.
 */
export function secretKey(): Buffer {
  if (cachedKey) return cachedKey;
  ensureDirs();
  if (fs.existsSync(PATHS.secret)) {
    cachedKey = Buffer.from(fs.readFileSync(PATHS.secret, 'utf8').trim(), 'hex');
    if (cachedKey.length === 32) return cachedKey;
  }
  cachedKey = crypto.randomBytes(32);
  fs.writeFileSync(PATHS.secret, cachedKey.toString('hex'), { mode: 0o600 });
  return cachedKey;
}

/** AES-256-GCM encrypt -> "v1.<iv>.<tag>.<ciphertext>" (all base64url). */
export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptJson<T>(blob: string): T {
  const [version, ivB64, tagB64, ctB64] = blob.split('.');
  if (version !== 'v1') throw new Error('unsupported ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]);
  return JSON.parse(pt.toString('utf8')) as T;
}
