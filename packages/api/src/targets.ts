/**
 * Target reachability policy.
 *
 * Director refuses to record URLs that only resolve on your own machine: the
 * hosted browser cannot see them, so the run fails with TARGET_UNREACHABLE and
 * the documented remediation is "expose it with a tunnel".
 *
 * Reelforge runs the browser *locally*, so loopback is legitimate by default
 * (that is how `apps/demo-site` and `scripts/smoke.ts` are exercised). The
 * Director rule is kept for everything else: RFC1918 / link-local / ULA
 * addresses are still unreachable to a hosted recorder, and `tunnel` targets
 * must be public HTTPS.
 *
 *   REELFORGE_BLOCK_LOCAL=true  -> re-enable the strict rule for loopback.
 */

export type TargetClass = 'loopback' | 'private' | 'public' | 'invalid';

const LOOPBACK_HOSTS = new Set(['localhost', 'localhost.', '::1', '0:0:0:0:0:0:0:1', '127.0.0.1']);

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isLoopbackHost(host)) return false;
  if (host === '0.0.0.0' || host === '::' ) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host)) return true; // CGNAT
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true; // ULA fc00::/7
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true; // link-local fe80::/10
  return false;
}

export function classifyTarget(rawUrl: string): { class: TargetClass; host: string; url?: URL } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { class: 'invalid', host: '' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { class: 'invalid', host: url.hostname };
  }
  const host = url.hostname.toLowerCase();
  if (isLoopbackHost(host)) return { class: 'loopback', host, url };
  if (isPrivateHost(host)) return { class: 'private', host, url };
  return { class: 'public', host, url };
}

export function loopbackBlocked(): boolean {
  return (process.env.REELFORGE_BLOCK_LOCAL ?? 'false').toLowerCase() === 'true';
}

/** Comma-separated hard blocklist, checked before anything else. */
export function isBlockedHost(hostname: string): boolean {
  const raw = (process.env.REELFORGE_BLOCKED_HOSTS ?? '').trim();
  if (!raw) return false;
  const host = hostname.toLowerCase();
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => host === entry || host.endsWith(`.${entry}`));
}