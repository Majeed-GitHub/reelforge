/**
 * Flow reverification without recording.
 *
 * A recorded flow is a list of `StepRecord`s. To answer "does this flow still
 * work?", replay it cheaply: re-open the page each step came from and check its
 * selector still resolves to a visible element. No video, no cursor overlay,
 * no screenshots — this is the Product Graph's health check, so it must be fast
 * and it must NEVER throw (the worker stores `{status, staleSteps, checkedAt}`).
 */

import { chromium } from 'playwright';
import type { Page } from 'playwright';

import { VIEWPORT } from '../../core/src/config.ts';
import { nowIso } from '../../core/src/ids.ts';
import type { StepRecord } from '../../core/src/types.ts';
import type { StorageState } from './runner.ts';

export type StaleStep = {
  /** StepRecord.index of the step that no longer resolves. */
  idx: number;
  selector: string;
  reason: string;
};

export type ReverifyResult = {
  status: 'fresh' | 'stale';
  staleSteps: StaleStep[];
  /** ISO timestamp of this check. */
  checkedAt: string;
  /** How many selector-bearing steps were checked. */
  checkedSteps: number;
  /** Set when the check itself could not run (browser launch, network, ...). */
  error?: string;
};

export type ReverifyInput = {
  baseUrl: string;
  steps: StepRecord[];
  storageState?: StorageState | string;
  headless?: boolean;
  /** Per-step visibility timeout (default 8000 ms). */
  timeoutMs?: number;
  onLog?: (line: string) => void;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function absoluteUrl(stepUrl: string | undefined, baseUrl: string): string {
  const raw = (stepUrl ?? '').trim();
  if (!raw) return baseUrl;
  try {
    return new URL(raw).toString();
  } catch {
    // Relative URL recorded against a base.
    try {
      const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
      return new URL(raw.replace(/^\/+/, ''), base).toString();
    } catch {
      return baseUrl;
    }
  }
}

function sameUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = '';
    right.hash = '';
    return left.toString() === right.toString();
  } catch {
    return a === b;
  }
}

/**
 * Check each recorded selector in a real browser. Returns a result, never throws.
 */
export async function reverifyFlow(input: ReverifyInput): Promise<ReverifyResult> {
  const checkedAt = nowIso();
  const staleSteps: StaleStep[] = [];
  const timeoutMs = input.timeoutMs ?? 8000;
  const log = (line: string): void => input.onLog?.(line);

  const candidates = input.steps.filter((step) => Boolean(step.selector && step.selector.trim()));
  if (candidates.length === 0) {
    return { status: 'fresh', staleSteps, checkedAt, checkedSteps: 0 };
  }

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({
      headless: input.headless !== false,
      args: ['--hide-scrollbars', '--mute-audio', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext({
      viewport: { ...VIEWPORT },
      deviceScaleFactor: 1,
      locale: 'en-US',
      ...(input.storageState ? { storageState: input.storageState as never } : {})
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(30_000);

    let currentUrl = '';
    for (const step of candidates) {
      const selector = String(step.selector);
      const stepUrl = absoluteUrl(step.url, input.baseUrl);

      try {
        if (!currentUrl || !sameUrl(currentUrl, stepUrl)) {
          await page.goto(stepUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await page.waitForLoadState('load', { timeout: 6000 }).catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
          currentUrl = page.url();
          log(`[reverify] opened ${stepUrl}`);
        }
      } catch (error) {
        staleSteps.push({ idx: step.index, selector, reason: `page ${stepUrl} did not load: ${errorMessage(error)}` });
        currentUrl = '';
        continue;
      }

      const reason = await checkSelector(page, selector, timeoutMs);
      if (reason) staleSteps.push({ idx: step.index, selector, reason });
      else log(`[reverify] step ${step.index} ok: ${selector}`);
    }

    await context.close().catch(() => {});
  } catch (error) {
    const message = errorMessage(error);
    log(`[reverify] failed: ${message}`);
    return { status: 'stale', staleSteps, checkedAt, checkedSteps: candidates.length, error: message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return {
    status: staleSteps.length === 0 ? 'fresh' : 'stale',
    staleSteps,
    checkedAt,
    checkedSteps: candidates.length
  };
}

/** Resolve and prove visibility. Returns a reason string when stale, else null. */
async function checkSelector(page: Page, selector: string, timeoutMs: number): Promise<string | null> {
  let count = 0;
  try {
    count = await page.locator(selector).count();
  } catch (error) {
    return `invalid selector (${errorMessage(error)})`;
  }
  if (count === 0) return 'selector matched no elements';
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    return `selector matched ${count} element(s) but none became visible`;
  }
  return null;
}

/** Convenience wrapper used by the API layer. */
export function reverifyFlowSync(input: ReverifyInput): Promise<ReverifyResult> {
  return reverifyFlow(input);
}
