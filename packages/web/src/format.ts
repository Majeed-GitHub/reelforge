/**
 * Small, dependency-free formatting helpers.
 *
 * Everything is defensive: the API is a separate process that is frequently
 * down or mid-restart while you are developing, so formatters never throw on a
 * missing/odd value.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "just now" · "42s ago" · "7m ago" · "3h ago" · "5d ago" · "Mar 2". */
export function formatRelative(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  const diff = Date.now() - date.getTime();
  if (diff < 0) return 'just now';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** "6 Nov, 22:41" — local time, scan-friendly. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getDate()} ${MONTHS[date.getMonth()]}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatClock(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 42_000ms -> "0:42"; 3_723_000 -> "1:02:03". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Milliseconds in a transcript: "0:04.2" is too noisy, so "0:04". */
export function formatMsClock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

export function truncate(text: string, max: number): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** "http://127.0.0.1:4402/app" -> "127.0.0.1:4402". */
export function hostOf(url: string | null | undefined): string {
  if (!url) return '—';
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0] || url;
  }
}

export function pathOf(url: string | null | undefined): string {
  if (!url) return '/';
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** Never throw while reading a JSON column the API may hand back as a string. */
export function parseJsonField<T>(value: unknown): T | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return value as T;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return (parsed ?? null) as T | null;
  } catch {
    return null;
  }
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** "manage_billing", "Session expired" -> "Session expired". */
export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

export function channelLabel(channel: string | null | undefined): string {
  if (channel === 'help_center') return 'Help centre';
  if (channel === 'internal_training') return 'Internal training';
  return humanize(channel);
}

/** Progress is stored 0–100 (or occasionally 0–1); normalise either. */
export function toPercent(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 0;
  const n = value as number;
  const scaled = n > 0 && n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

/** The pipeline has three visible phases; map progress onto a human stage. */
export function pipelineStage(status: string, progress: number): string {
  if (status === 'queued') return 'Queued for a worker';
  if (status === 'complete') return 'Published';
  if (status === 'failed') return 'Failed';
  if (status === 'cancelled') return 'Cancelled';
  if (progress < 8) return 'Validating target';
  if (progress < 70) return 'Driving the browser';
  if (progress < 92) return 'Narrating and rendering';
  return 'Writing article and guide';
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
}
