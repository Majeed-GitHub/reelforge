/**
 * runCapture: the browser-agent loop.
 *
 *   resolve target → launch Chromium (1280×720, video on) → inject the cursor
 *   → goto + settle → loop { observe → plan → act → screenshot } → close
 *   → data/raw/<id>/demo.webm
 *
 * Everything a downstream consumer needs is recorded per step: selector, role,
 * accessible name, viewport-relative box (CSS px), click point, and monotonic
 * timings relative to recording start — because the renderer's auto-zoom
 * timeline is built from exactly those numbers (docs/ARCHITECTURE.md §5.2).
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page, Video, Response as PlaywrightResponse } from 'playwright';

import { PATHS, VIEWPORT, ensureDirs } from '../../core/src/config.ts';
import { newId } from '../../core/src/ids.ts';
import type {
  Box,
  CaptureResult,
  DemoFailure,
  DemoRequest,
  ElementRef,
  PlannedAction,
  Planner,
  StepRecord
} from '../../core/src/types.ts';
import { CURSOR_INIT_SCRIPT } from './injected.ts';
import { observe } from './observer.ts';
import { cleanNarration, createNarrator } from './narration.ts';
import { createPlanner } from './planner/index.ts';

/** Best-effort loop budget: options.maxSteps is honoured, the cap is not negotiable. */
export const MAX_STEPS_HARD_CAP = 60;
export const DEFAULT_MAX_STEPS = 40;

export type StorageState = {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>;
  origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
};

export type RunCaptureInput = {
  /** Optional pre-allocated demo id; one is generated otherwise. */
  id?: string;
  request: DemoRequest;
  /** Saved product: base URL + captured Playwright session (skips sign-in). */
  environment?: { id?: string; baseUrl: string; storageState?: StorageState | string };
  /** Injected planner, for tests. Defaults to `createPlanner`. */
  planner?: Planner;
  /** Extra log sink (the demo worker streams these). */
  onLog?: (line: string) => void;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value: number): number => Math.round(value * 10) / 10;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function makeFailure(code: string, message: string, action?: string, hint?: string): DemoFailure {
  const out: DemoFailure = { code, message };
  out.remediation = {
    action: action ?? 'Check the target and the instruction, then run the demo again.',
    ...(hint ? { hint } : {})
  };
  return out;
}

/** request.target.url, else environment base URL + path. */
export function resolveTargetUrl(request: Pick<DemoRequest, 'target' | 'path'>, baseUrl?: string): string | null {
  const direct = request.target?.url?.trim();
  if (direct) return direct;
  if (baseUrl?.trim()) {
    const base = baseUrl.trim().endsWith('/') ? baseUrl.trim() : `${baseUrl.trim()}/`;
    try {
      return new URL(request.path?.trim() || '/', base).toString();
    } catch {
      return null;
    }
  }
  return null;
}

function centerOf(box: Box): { x: number; y: number } {
  return { x: round(box.x + box.width / 2), y: round(box.y + box.height / 2) };
}

const DESTRUCTIVE_NAME =
  /(^|[^a-z])(delete|remove|revoke|pay|pays|purchase|charge|refund|deactivate|destroy|downgrade|cancel subscription)([^a-z]|$)/i;

function isDestructiveName(name: string | undefined): boolean {
  return Boolean(name && DESTRUCTIVE_NAME.test(name));
}

function isSecretField(element: ElementRef | undefined, selector: string | undefined): boolean {
  const haystack = `${element?.name ?? ''} ${selector ?? ''}`;
  return /password|passcode|secret|token|api[-_ ]?key/i.test(haystack);
}

/** options.language ("en", "es-MX") -> a Chromium locale; demos default to en-US. */
function browserLocale(language: string | undefined): string {
  const raw = (language ?? '').trim();
  if (/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(raw)) return raw;
  return 'en-US';
}

function wantsScreenshot(planner: Planner): boolean {
  return (planner as Planner & { wantsScreenshot?: boolean }).wantsScreenshot === true;
}

// ---------------------------------------------------------------------------
// Browser motions
// ---------------------------------------------------------------------------

/** Eased glide, ~12 moves by default: real motion, visible in the recording. */
async function glide(
  page: Page,
  mouse: { x: number; y: number },
  target: { x: number; y: number },
  moves = 12
): Promise<void> {
  const fromX = mouse.x;
  const fromY = mouse.y;
  const steps = Math.max(4, moves);
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const x = fromX + (target.x - fromX) * eased;
    const y = fromY + (target.y - fromY) * eased;
    await page.mouse.move(round(x), round(y));
    mouse.x = round(x);
    mouse.y = round(y);
    if (index < steps) await sleep(13);
  }
  await sleep(30);
}

async function settle(page: Page, pauseMs = 220): Promise<void> {
  // Give a click-triggered navigation a moment to commit before waiting on it.
  await sleep(110);
  await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  await sleep(pauseMs);
}

async function gotoAndSettle(page: Page, url: string): Promise<PlaywrightResponse | null> {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  await sleep(320);
  return response;
}

/** Measure the live element (after scrolling it into view), falling back to the observed box. */
async function measureBox(page: Page, selector: string | undefined, fallback?: Box): Promise<Box | undefined> {
  if (selector) {
    try {
      const locator = page.locator(selector).first();
      await locator.scrollIntoViewIfNeeded({ timeout: 4000 });
      const box = await locator.boundingBox({ timeout: 4000 });
      if (box) return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) };
    } catch {
      // fall through to the observed box
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// runCapture
// ---------------------------------------------------------------------------

export async function runCapture(input: RunCaptureInput): Promise<CaptureResult> {
  const request = input.request;
  const instruction = (request.instruction ?? '').trim();
  const options = request.options ?? {};
  const headless = options.headless !== false;
  const requestedSteps = Number.isFinite(options.maxSteps) ? Number(options.maxSteps) : DEFAULT_MAX_STEPS;
  const maxSteps = Math.max(1, Math.min(Math.trunc(requestedSteps), MAX_STEPS_HARD_CAP));
  const demoId = input.id ?? newId('dem');

  const rawDir = path.join(PATHS.raw, demoId);
  const shotsDir = path.join(PATHS.screenshots, demoId);
  const demoVideoPath = path.join(rawDir, 'demo.webm');

  const log: string[] = [];
  const push = (line: string): void => {
    const entry = `${new Date().toISOString()} ${line}`;
    log.push(entry);
    input.onLog?.(entry);
  };

  const steps: StepRecord[] = [];
  let goalMet = false;
  let stoppedBefore: string | undefined;
  let failure: DemoFailure | undefined;
  let videoPath: string | undefined;
  let finalUrl = '';
  let startedAtEpochMs = Date.now();
  let endedAtEpochMs = startedAtEpochMs;

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let video: Video | null = null;

  const targetUrl = resolveTargetUrl(request, input.environment?.baseUrl);
  if (!targetUrl) {
    failure = makeFailure(
      'TARGET_UNREACHABLE',
      'No target URL: provide request.target.url or an environment baseUrl.',
      'Supply target.url (or environmentId with a saved base URL) and retry.'
    );
    push('[agent] no target url resolved; aborting before launch');
    endedAtEpochMs = Date.now();
    return {
      steps,
      viewport: { ...VIEWPORT },
      startedAtEpochMs,
      endedAtEpochMs,
      goalMet: false,
      finalUrl: '',
      error: failure,
      log
    };
  }

  ensureDirs();
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  push(`[agent] demo ${demoId}: capture ${targetUrl} (headless=${headless}, maxSteps=${maxSteps})`);
  push(`[agent] instruction: ${instruction}`);

  const planner =
    input.planner ??
    createPlanner({
      instruction,
      credentials: request.credentials,
      onLog: push
    });
  push(`[agent] planner: ${planner.name}`);

  const narrator = createNarrator({ instruction });
  const mouse = { x: Math.round(VIEWPORT.width / 2), y: Math.round(VIEWPORT.height / 2) };

  try {
    browser = await chromium.launch({
      headless,
      args: ['--hide-scrollbars', '--mute-audio', '--disable-dev-shm-usage', '--force-color-profile=srgb']
    });

    const storageState = input.environment?.storageState;
    context = await browser.newContext({
      viewport: { ...VIEWPORT },
      deviceScaleFactor: 1,
      locale: browserLocale(options.language),
      recordVideo: { dir: rawDir, size: { ...VIEWPORT } },
      ...(storageState ? { storageState: storageState as never } : {})
    });
    await context.addInitScript({ content: CURSOR_INIT_SCRIPT });
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);

    // Video recording starts with the first page; timings are relative to now.
    startedAtEpochMs = Date.now();
    page = await context.newPage();
    video = page.video();

    try {
      const response = await gotoAndSettle(page, targetUrl);
      if (response && !response.ok()) {
        push(`[agent] target responded HTTP ${response.status()} — continuing (the demo may still be valid)`);
      }
    } catch (error) {
      failure = makeFailure(
        'TARGET_UNREACHABLE',
        `Could not open ${targetUrl}: ${errorMessage(error)}`,
        'Confirm the URL is reachable from the machine running Reelforge, then retry.'
      );
      push(`[agent] ${failure.message}`);
    }

    // Let the injected pointer appear on camera before the first action.
    await page.mouse.move(mouse.x, mouse.y, { steps: 4 }).catch(() => {});

    if (!failure) {
      const history: PlannedAction[] = [];
      let plannerDone = false;
      let consecutiveErrors = 0;

      for (let index = 0; index < maxSteps; index += 1) {
        if (!page || page.isClosed()) {
          failure = makeFailure('INTERNAL_ERROR', 'The page was closed while the demo was running.');
          push(`[agent] ${failure.message}`);
          break;
        }

        let observation;
        try {
          observation = await observe(page, {
            step: index,
            goal: instruction,
            history: [...history],
            screenshot: wantsScreenshot(planner)
          });
        } catch (error) {
          failure = makeFailure('INTERNAL_ERROR', `Observation failed on step ${index}: ${errorMessage(error)}`);
          push(`[agent] ${failure.message}`);
          break;
        }

        let action: PlannedAction;
        try {
          action = await planner.next(observation);
        } catch (error) {
          failure = makeFailure(
            'INTERNAL_ERROR',
            `The planner failed on step ${index}: ${errorMessage(error)}`,
            'Check the planner/LLM configuration, or unset the LLM key to use the offline planner.'
          );
          push(`[agent] ${failure.message}`);
          break;
        }

        // A blocked action may use any kind; the block wins over the kind.
        if (action.blocked) {
          stoppedBefore = action.blocked.why;
          failure = action.blocked.needsConfirmation
            ? makeFailure(
                'DESTRUCTIVE_ACTIONS_CONFIRMATION_REQUIRED',
                action.blocked.why,
                'Re-run with confirmDestructive: true if you own the data being deleted.'
              )
            : makeFailure('INTERNAL_ERROR', action.blocked.why, 'Review the instruction and the target page.');
          push(`[agent] planner blocked: ${action.blocked.why}`);
          break;
        }

        if (action.kind === 'done') {
          plannerDone = true;
          goalMet = steps.length > 0;
          push(`[agent] planner finished after ${steps.length} step(s): ${action.reason ?? 'goal reached'}`);
          break;
        }

        const element =
          (action.ref !== undefined ? observation.elements.find((candidate) => candidate.ref === action.ref) : undefined) ??
          (action.selector ? observation.elements.find((candidate) => candidate.selector === action.selector) : undefined);
        const selector = element?.selector ?? action.selector;

        const destructive = Boolean(element?.destructive) || (!element && isDestructiveName(action.narration));
        if (destructive && !request.confirmDestructive) {
          stoppedBefore = element?.name ?? action.selector ?? action.narration ?? 'a destructive action';
          failure = makeFailure(
            'DESTRUCTIVE_ACTIONS_CONFIRMATION_REQUIRED',
            `Step ${index} (${action.kind} ${stoppedBefore}) would perform a destructive action.`,
            'Re-run with request.confirmDestructive: true to allow delete/remove/revoke/pay steps.'
          );
          push(`[agent] stopped before destructive step: ${stoppedBefore}`);
          break;
        }

        // Narration: planner-provided first, template/LLM otherwise.
        const narration = cleanNarration(action.narration) || (await narrator.narrate(action, element, history, instruction));

        const record: StepRecord = {
          index,
          kind: action.kind,
          narration,
          startedAtMs: Date.now() - startedAtEpochMs,
          endedAtMs: Date.now() - startedAtEpochMs,
          url: page.url(),
          reason: action.reason
        };
        if (element) {
          record.selector = element.selector;
          record.role = element.role;
          record.accessibleName = element.name;
          record.box = element.box;
        } else if (action.selector) {
          record.selector = action.selector;
        }

        try {
          await performAction({ page, action, element, selector, record, mouse, startedAtEpochMs });
        } catch (error) {
          record.error = errorMessage(error);
          consecutiveErrors += 1;
          push(`[agent] step ${index} (${action.kind}) failed: ${record.error}`);
        }
        record.endedAtMs = Date.now() - startedAtEpochMs;

        if (action.kind === 'goto' && action.url) {
          record.url = action.url;
        }

        try {
          const shotPath = path.join(shotsDir, `${index}.png`);
          await page.screenshot({ path: shotPath, type: 'png' });
          record.screenshotPath = shotPath;
        } catch (error) {
          push(`[agent] screenshot for step ${index} failed: ${errorMessage(error)}`);
        }

        steps.push(record);
        history.push(action);
        if (!record.error) consecutiveErrors = 0;
        push(
          `[agent] step ${index} ${action.kind}${record.selector ? ` ${record.selector}` : ''} ` +
            `(${record.startedAtMs}–${record.endedAtMs}ms) ${record.error ? `ERROR ${record.error}` : 'ok'} — ${narration}`
        );

        if (consecutiveErrors >= 3) {
          failure = makeFailure(
            'INTERNAL_ERROR',
            `Aborted after ${consecutiveErrors} consecutive failed steps (last: ${record.error ?? 'unknown'}).`,
            'Check the recorded selectors and that the page is still responding.'
          );
          push(`[agent] ${failure.message}`);
          break;
        }
      }

      if (!plannerDone && !failure && steps.length >= maxSteps) {
        push(`[agent] step budget of ${maxSteps} reached — ending the run`);
      }
    }

    finalUrl = page.url();
  } catch (error) {
    if (!failure) {
      const message = errorMessage(error);
      const likelyBrowser = /Executable doesn't exist|browserType\.launch|Failed to launch/i.test(message);
      failure = makeFailure(
        'INTERNAL_ERROR',
        likelyBrowser
          ? `Could not launch Chromium: ${message}`
          : `The browser session failed: ${message}`,
        likelyBrowser ? 'Run `npx playwright install chromium` once, then retry.' : undefined
      );
    }
    push(`[agent] ${failure.message}`);
  } finally {
    endedAtEpochMs = Date.now();

    // Capture the session before closing so environments can reuse it later.
    if (context) {
      try {
        const state = await context.storageState();
        fs.writeFileSync(path.join(rawDir, 'session.json'), JSON.stringify(state, null, 2));
      } catch {
        // A session is a nice-to-have; the video matters more.
      }
    }

    try {
      if (context) await context.close();
    } catch (error) {
      push(`[agent] closing the browser context failed: ${errorMessage(error)}`);
    }

    try {
      if (video) {
        const source = await video.path();
        if (source && fs.existsSync(source)) {
          if (path.resolve(source) !== path.resolve(demoVideoPath)) {
            try {
              await fs.promises.rename(source, demoVideoPath);
            } catch {
              await fs.promises.copyFile(source, demoVideoPath);
              await fs.promises.unlink(source).catch(() => {});
            }
          }
          videoPath = demoVideoPath;
        }
      }
    } catch (error) {
      push(`[agent] could not finalise the video: ${errorMessage(error)}`);
    }

    try {
      if (browser) await browser.close();
    } catch {
      // ignore
    }

    if (videoPath) {
      const size = fs.existsSync(videoPath) ? fs.statSync(videoPath).size : 0;
      push(`[agent] video: ${videoPath} (${size} bytes)`);
    } else {
      push('[agent] no video was produced');
    }
  }

  const result: CaptureResult = {
    steps,
    viewport: { ...VIEWPORT },
    videoPath,
    startedAtEpochMs,
    endedAtEpochMs,
    goalMet,
    finalUrl,
    ...(stoppedBefore ? { stoppedBefore } : {}),
    ...(failure ? { error: failure } : {}),
    log
  };

  try {
    fs.writeFileSync(path.join(rawDir, 'capture.json'), JSON.stringify(result, null, 2));
  } catch {
    // ignore
  }

  return result;
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

type PerformInput = {
  page: Page;
  action: PlannedAction;
  element?: ElementRef;
  selector?: string;
  record: StepRecord;
  mouse: { x: number; y: number };
  startedAtEpochMs: number;
};

async function performAction(input: PerformInput): Promise<void> {
  const { page, action, element, selector, record, mouse } = input;

  switch (action.kind) {
    case 'click': {
      const box = await measureBox(page, selector, element?.box);
      if (!box) throw new Error(`could not locate ${selector ?? 'the target element'} on the page`);
      record.box = box;
      const point = centerOf(box);
      record.point = point;
      await glide(page, mouse, point, 12);
      await sleep(110);
      await page.mouse.down();
      await sleep(75);
      await page.mouse.up();
      await settle(page, 240);
      return;
    }

    case 'type': {
      if (!selector) throw new Error('a type action needs a selector');
      const box = await measureBox(page, selector, element?.box);
      if (!box) throw new Error(`could not locate ${selector} on the page`);
      record.box = box;
      const point = centerOf(box);
      record.point = point;
      await glide(page, mouse, point, 10);
      await page.mouse.down();
      await sleep(40);
      await page.mouse.up();
      await sleep(60);

      const locator = page.locator(selector).first();
      const existing = await locator.inputValue({ timeout: 3000 }).catch(() => '');
      if (existing) {
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
        await sleep(40);
      }
      const value = action.value ?? '';
      await page.keyboard.type(value, { delay: 45 });
      record.value = isSecretField(element, selector) ? '[redacted]' : value;
      await settle(page, 180);
      return;
    }

    case 'goto': {
      const url = action.url;
      if (!url) throw new Error('a goto action needs a url');
      await gotoAndSettle(page, url);
      await page.mouse.move(mouse.x, mouse.y, { steps: 2 }).catch(() => {});
      return;
    }

    case 'scroll': {
      record.point = { x: mouse.x, y: mouse.y };
      const delta = Math.max(120, Math.min(3000, Number(action.value) || 600));
      for (let chunk = 0; chunk < 3; chunk += 1) {
        await page.mouse.wheel(0, round(delta / 3));
        await sleep(120);
      }
      await settle(page, 160);
      return;
    }

    case 'key': {
      const key = action.value || 'Enter';
      if (selector) {
        const box = await measureBox(page, selector, element?.box);
        if (box) {
          record.box = box;
          const point = centerOf(box);
          record.point = point;
          await glide(page, mouse, point, 8);
          await page.mouse.down();
          await sleep(40);
          await page.mouse.up();
          await sleep(60);
        }
      }
      await page.keyboard.press(key);
      await settle(page, 200);
      return;
    }

    case 'wait': {
      const ms = Math.max(120, Math.min(5000, Number(action.value) || 600));
      await sleep(ms);
      return;
    }

    case 'done':
      return;

    default:
      throw new Error(`unsupported action kind: ${String(action.kind)}`);
  }
}
