import crypto from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Prefixed, URL-safe, sortable-ish id: dem_l8x2k9q3. */
export function newId(prefix: string): string {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** DIR-XXXX-XXXX-XXXX style login code, single use, 30 minute expiry. */
export function newLoginCode(): string {
  const block = () => crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
  return `DIR-${block()}-${block()}-${block()}`;
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
