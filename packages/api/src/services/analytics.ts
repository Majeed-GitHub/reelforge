/**
 * Privacy-respecting view analytics.
 *
 * One row per page load of a public surface (`share`, `embed`, `walkthrough`)
 * plus the reserved `dashboard` surface. That is deliberately all the data
 * there is:
 *
 *   demo_views (id, demo_id, surface, day, created_at)
 *
 * No IP address, no user-agent string, no cookie, no referrer, no third-party
 * call. The request's `User-Agent` header is read transiently and reduced to
 * `bot | human | unknown`; obvious crawlers are not counted as views and the
 * classification is never persisted either. `day` is the UTC calendar date
 * (`YYYY-MM-DD`) so rollups need no timestamps at all.
 *
 * The table is created here with `CREATE TABLE IF NOT EXISTS` (no core/db.ts
 * change): analytics is an API-surface concern, like the exports table.
 */
import { getDb } from '../../../core/src/db.ts';
import { newId, nowIso } from '../../../core/src/ids.ts';
import { many, one, run } from '../dbq.ts';

export const VIEW_SURFACES = ['share', 'embed', 'walkthrough', 'dashboard'] as const;
export type ViewSurface = (typeof VIEW_SURFACES)[number];

const ANALYTICS_DDL = `
CREATE TABLE IF NOT EXISTS demo_views (
  id TEXT PRIMARY KEY,
  demo_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  day TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demo_views_demo ON demo_views(demo_id, created_at DESC);
`;

getDb().exec(ANALYTICS_DDL);

export type ClientKind = 'bot' | 'human' | 'unknown';

/** Crawlers, link unfurlers, screenshot/uptime services. */
const BOT_PATTERN =
  /bot|crawl|spider|slurp|headlesschrome|phantomjs|facebookexternalhit|embedly|pinterest|vkshare|discordbot|telegrambot|whatsapp|slackbot|twitterbot|linkedinbot|preview|lighthouse|pagespeed|pingdom|uptimerobot|statuscake|monitor/i;

/** Programmatic clients that are not browsers but are not crawlers either. */
const PROGRAMMATIC_PATTERN = /^(node|undici|curl|wget|python-requests|python-httpx|httpie|go-http-client|java\/|axios|okhttp|libwww|powershell)/i;

function headerString(value: string | string[] | null | undefined): string {
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : '';
}

/**
 * Read a User-Agent just far enough to bucket it. The string never reaches the
 * database — callers pass it in, `recordView` uses the returned kind only.
 */
export function classifyClient(userAgent: string | string[] | null | undefined): ClientKind {
  const ua = headerString(userAgent).trim();
  if (!ua) return 'unknown';
  if (BOT_PATTERN.test(ua)) return 'bot';
  if (PROGRAMMATIC_PATTERN.test(ua)) return 'unknown';
  return 'human';
}

/** UTC calendar day, `YYYY-MM-DD`. */
export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function dayOffset(days: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return utcDay(date);
}

/**
 * Record one view. Bots are dropped (a crawl is not a view); everything else
 * gets exactly one row. Never throws — analytics must never break a page.
 * Returns whether a row was written (handy for tests).
 */
export function recordView(
  demoId: string,
  surface: ViewSurface,
  userAgent: string | string[] | null | undefined
): boolean {
  if (!demoId) return false;
  if ((VIEW_SURFACES as readonly string[]).includes(surface) === false) return false;
  if (classifyClient(userAgent) === 'bot') return false;
  try {
    run(
      'INSERT INTO demo_views (id, demo_id, surface, day, created_at) VALUES (?, ?, ?, ?, ?)',
      newId('view'),
      demoId,
      surface,
      utcDay(),
      nowIso()
    );
    return true;
  } catch (error) {
    console.error(`[analytics] could not record a ${surface} view: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export type DemoAnalytics = {
  views: {
    total: number;
    today: number;
    last7: number;
    bySurface: Record<string, number>;
  };
  firstViewedAt: string | null;
  lastViewedAt: string | null;
};

/** Aggregate the counters for one demo (UTC days; `last7` includes today). */
export function getDemoAnalytics(demoId: string): DemoAnalytics {
  const today = utcDay();
  const windowStart = dayOffset(6);

  const total = Number(one<{ n: number }>('SELECT COUNT(*) AS n FROM demo_views WHERE demo_id = ?', demoId)?.n ?? 0);
  const todayCount = Number(
    one<{ n: number }>('SELECT COUNT(*) AS n FROM demo_views WHERE demo_id = ? AND day = ?', demoId, today)?.n ?? 0
  );
  const last7 = Number(
    one<{ n: number }>('SELECT COUNT(*) AS n FROM demo_views WHERE demo_id = ? AND day >= ?', demoId, windowStart)?.n ?? 0
  );

  const bySurface: Record<string, number> = {};
  for (const row of many<{ surface: string; n: number }>(
    'SELECT surface, COUNT(*) AS n FROM demo_views WHERE demo_id = ? GROUP BY surface',
    demoId
  )) {
    const count = Number(row.n);
    if (count > 0) bySurface[row.surface] = count;
  }

  const first = one<{ at: string | null }>('SELECT MIN(created_at) AS at FROM demo_views WHERE demo_id = ?', demoId);
  const last = one<{ at: string | null }>('SELECT MAX(created_at) AS at FROM demo_views WHERE demo_id = ?', demoId);

  return {
    views: { total, today: todayCount, last7, bySurface },
    firstViewedAt: first?.at ?? null,
    lastViewedAt: last?.at ?? null
  };
}
