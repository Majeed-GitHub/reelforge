/**
 * End-to-end evidence run for packages/agent.
 *
 *   node packages/agent/scripts/e2e.ts
 *
 * 1. starts apps/demo-site on port 4402 (unless one is already listening)
 * 2. GET /reset so the demo state is deterministic
 * 3. runCapture("Sign in, create a project called Q4 Launch, invite
 *    sam@example.com to the team, then upgrade to the Team plan.",
 *    { headless: true, maxSteps: 40 })
 * 4. asserts the capture: >= 6 steps, a viewport box on every click/type,
 *    a PNG per step, a .webm with a real duration (ffprobe), 1280x720
 * 5. reverifyFlow on the recorded selectors -> must be "fresh"
 * 6. corrupt one selector -> must be "stale"
 *
 * Exits non-zero (with a precise reason) if any assertion fails.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { PATHS, ROOT } from '../../core/src/config.ts';
import type { CaptureResult, StepRecord } from '../../core/src/types.ts';
import { runCapture } from '../src/runner.ts';
import type { StorageState } from '../src/runner.ts';
import { reverifyFlow } from '../src/reverify.ts';
import { BASE_URL, resetDemoSite, startDemoSite, stopDemoSite } from './demo.ts';
import { readPng } from './png.ts';

const require = createRequire(import.meta.url);

const INSTRUCTION =
  'Sign in, create a project called Q4 Launch, invite sam@example.com to the team, then upgrade to the Team plan.';

function rel(absolutePath: string): string {
  const relative = path.relative(ROOT, absolutePath);
  return relative.startsWith('..') ? absolutePath : relative.split(path.sep).join('/');
}

function fail(message: string): never {
  console.error(`\nFAIL: ${message}`);
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length))
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => (cell ?? '').padEnd(widths[column]))
      .join('  ')
      .trimEnd();
  const rule = widths.map((width) => '-'.repeat(width)).join('  ');
  return [line(headers), rule, ...rows.map((row) => line(row))].join('\n');
}

function ffprobe(videoPath: string): { durationSeconds: number; streams: Array<Record<string, unknown>> } | null {
  let ffprobePath = '';
  try {
    const mod = require('ffprobe-static') as { path?: string } | string;
    ffprobePath = typeof mod === 'string' ? mod : (mod.path ?? '');
  } catch {
    ffprobePath = '';
  }
  if (!ffprobePath || !fs.existsSync(ffprobePath)) {
    const fallback = path.join(ROOT, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe');
    if (!fs.existsSync(fallback)) {
      console.warn('[e2e] ffprobe not found; skipping duration probe');
      return null;
    }
    ffprobePath = fallback;
  }
  const result = spawnSync(
    ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', videoPath],
    { encoding: 'utf8', timeout: 30_000 }
  );
  if (result.status !== 0) {
    console.warn(`[e2e] ffprobe failed: ${(result.stderr || '').slice(0, 400)}`);
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      format?: { duration?: string };
      streams?: Array<Record<string, unknown>>;
    };
    return { durationSeconds: Number(parsed.format?.duration ?? 0), streams: parsed.streams ?? [] };
  } catch {
    return null;
  }
}

function assertCapture(capture: CaptureResult): void {
  console.log(
    `\n[e2e] capture: ${capture.steps.length} steps, goalMet=${capture.goalMet}, finalUrl=${capture.finalUrl}`
  );
  if (capture.error) fail(`capture returned an error: ${capture.error.code} ${capture.error.message}`);
  if (capture.steps.length < 6) fail(`expected >= 6 steps, got ${capture.steps.length}`);
  if (!capture.goalMet) fail('capture.goalMet is false');

  const withBox = capture.steps.filter((step) => step.kind === 'click' || step.kind === 'type');
  if (withBox.length < 4) fail(`expected >= 4 click/type steps, got ${withBox.length}`);
  for (const step of withBox) {
    const box = step.box;
    if (!box || box.width <= 0 || box.height <= 0) fail(`step ${step.index} (${step.kind}) has no usable box`);
    if (box.x + box.width <= 0 || box.y + box.height <= 0) fail(`step ${step.index} box is outside the viewport`);
    if (!step.point) fail(`step ${step.index} (${step.kind}) has no click point`);
    if (!step.narration) fail(`step ${step.index} (${step.kind}) has no narration`);
    if (/\bI\b/.test(step.narration)) fail(`step ${step.index} narration uses first person: ${step.narration}`);
    if (!step.role) fail(`step ${step.index} has no role`);
    if (!step.accessibleName) fail(`step ${step.index} has no accessible name`);
    if (!step.url) fail(`step ${step.index} has no url`);
  }

  for (const step of capture.steps) {
    if (!step.screenshotPath) fail(`step ${step.index} has no screenshotPath`);
    if (!fs.existsSync(step.screenshotPath)) fail(`step ${step.index} screenshot missing on disk: ${step.screenshotPath}`);
    if (fs.statSync(step.screenshotPath).size < 1000) fail(`step ${step.index} screenshot is suspiciously small`);
    if (step.endedAtMs < step.startedAtMs) fail(`step ${step.index} has inverted timings`);
  }

  if (!capture.videoPath) fail('no .webm was produced');
  if (!fs.existsSync(capture.videoPath)) fail(`video path does not exist: ${capture.videoPath}`);
  const videoSize = fs.statSync(capture.videoPath).size;
  if (videoSize < 10_000) fail(`video is too small to be real: ${videoSize} bytes`);
  console.log(`[e2e] video: ${rel(capture.videoPath)} (${videoSize} bytes)`);

  const probe = ffprobe(capture.videoPath);
  if (probe) {
    console.log(`[e2e] ffprobe: duration ${probe.durationSeconds.toFixed(2)}s, streams ${JSON.stringify(probe.streams)}`);
    if (probe.durationSeconds <= 0.5) fail(`video duration is ${probe.durationSeconds}s`);
    if (!probe.streams.some((stream) => stream.codec_type === 'video')) fail('video has no video stream');
    const stream = probe.streams.find((candidate) => candidate.codec_type === 'video');
    if (stream && stream.width !== 1280) fail(`video width is ${String(stream.width)}, expected 1280`);
    if (stream && stream.height !== 720) fail(`video height is ${String(stream.height)}, expected 720`);
  }
  if (capture.endedAtEpochMs - capture.startedAtEpochMs < 1500) fail('recording window is implausibly short');

  // Privacy redaction on the real flow: the sign-in form has a password field,
  // so it must be a redaction box, and the saved PNG must contain the black mask.
  const redactions = capture.redactions ?? [];
  if (redactions.length === 0) fail('expected the sign-in password field in capture.redactions');
  for (const entry of redactions) {
    if (!Number.isInteger(entry.stepIndex)) fail(`redaction without integer stepIndex: ${JSON.stringify(entry)}`);
    if (entry.width <= 0 || entry.height <= 0) fail(`redaction has an empty box: ${JSON.stringify(entry)}`);
    if (entry.x < 0 || entry.y < 0 || entry.x + entry.width > 1280.5 || entry.y + entry.height > 720.5) {
      fail(`redaction box is outside the 1280x720 viewport: ${JSON.stringify(entry)}`);
    }
  }
  let blackBoxes = 0;
  for (const entry of redactions) {
    const step = capture.steps[entry.stepIndex];
    if (!step?.screenshotPath) continue;
    const image = readPng(step.screenshotPath);
    if (image.isBlack(entry.x + entry.width / 2, entry.y + entry.height / 2)) blackBoxes += 1;
  }
  if (blackBoxes === 0) fail(`no redaction box is pure black in a saved PNG (checked ${redactions.length})`);
  console.log(
    `[e2e] redactions: ${redactions.length} box(es) ${JSON.stringify(redactions)}; ${blackBoxes}/${redactions.length} black in their step PNG`
  );
}

function printStepTable(capture: CaptureResult): void {
  const rows = capture.steps.map((step: StepRecord) => {
    const box = step.box
      ? `${Math.round(step.box.x)},${Math.round(step.box.y)} ${Math.round(step.box.width)}x${Math.round(step.box.height)}`
      : '—';
    const point = step.point ? `${Math.round(step.point.x)},${Math.round(step.point.y)}` : '—';
    return [
      String(step.index),
      step.kind,
      step.narration,
      step.selector ?? '—',
      box,
      point,
      `${step.startedAtMs}-${step.endedAtMs}ms`,
      step.screenshotPath ? rel(step.screenshotPath) : '—'
    ];
  });
  console.log(
    '\n' +
      table(['#', 'kind', 'narration', 'selector', 'box (x,y wxh)', 'point', 'timing', 'screenshot'], rows)
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  fs.mkdirSync(PATHS.screenshots, { recursive: true });
  fs.mkdirSync(PATHS.raw, { recursive: true });

  const child = await startDemoSite();
  try {
    await resetDemoSite();

    console.log(`\n[e2e] instruction: ${INSTRUCTION}`);
    const capture = await runCapture({
      request: {
        instruction: INSTRUCTION,
        target: { type: 'url', url: `${BASE_URL}/` },
        // No credentials: the demo sign-in form is prefilled, so the scripted
        // planner simply submits it — the sign-in is visible on camera.
        options: { headless: true, maxSteps: 40 }
      },
      onLog: (line) => {
        if (/video:|planner|step budget/.test(line)) console.log(line);
      }
    });

    assertCapture(capture);
    printStepTable(capture);
    const demoDir = capture.videoPath ? path.dirname(capture.videoPath) : '';
    if (demoDir) console.log(`\n[e2e] capture json: ${rel(path.join(demoDir, 'capture.json'))}`);

    // ---------------------------------------------------------------- reverify
    const sessionPath = demoDir ? path.join(demoDir, 'session.json') : '';
    let storageState: StorageState | undefined;
    if (sessionPath && fs.existsSync(sessionPath)) {
      try {
        storageState = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as StorageState;
      } catch {
        console.warn('[e2e] could not parse session.json; reverify will run signed out');
      }
    }
    console.log(`\n[e2e] storage state for reverify: ${storageState ? rel(sessionPath) : 'none'}`);

    // Put the product back to its seeded state so the flow's selectors exist again.
    await resetDemoSite();

    const fresh = await reverifyFlow({
      baseUrl: BASE_URL,
      steps: capture.steps,
      storageState,
      headless: true,
      onLog: (line) => {
        if (/opened|failed/.test(line)) console.log(line);
      }
    });
    console.log(`[e2e] reverify (unchanged steps): status=${fresh.status} checked=${fresh.checkedSteps}`);
    if (fresh.error) fail(`reverify returned an error: ${fresh.error}`);
    if (fresh.status !== 'fresh') {
      fail(`expected reverify fresh, got ${fresh.status}: ${JSON.stringify(fresh.staleSteps, null, 2)}`);
    }

    // Deliberately corrupt one selector: a valid-but-absent test id.
    const corruptIndex = capture.steps.findIndex((step) => step.selector && /data-testid=/.test(step.selector));
    if (corruptIndex === -1) fail('no data-testid selector to corrupt');
    const corrupted = capture.steps.map((step, index) => {
      if (index !== corruptIndex) return step;
      const selector = String(step.selector);
      return {
        ...step,
        selector: selector.includes('data-testid=')
          ? selector.replace(/data-testid="([^"]+)"/, 'data-testid="$1-DOES-NOT-EXIST"')
          : `${selector}[data-corrupt="1"]`
      };
    });
    console.log(
      `\n[e2e] corrupting step ${corruptIndex}: ${capture.steps[corruptIndex].selector} -> ${corrupted[corruptIndex].selector}`
    );

    const stale = await reverifyFlow({ baseUrl: BASE_URL, steps: corrupted, storageState, headless: true });
    console.log(`[e2e] reverify (corrupted step): status=${stale.status} staleSteps=${JSON.stringify(stale.staleSteps)}`);
    if (stale.status !== 'stale') fail(`expected reverify stale on the corrupted selector, got ${stale.status}`);
    if (!stale.staleSteps.some((step) => step.idx === corruptIndex)) {
      fail(`corrupted step ${corruptIndex} was not reported stale`);
    }

    if (!fresh.checkedAt) fail('reverify did not stamp checkedAt');

    console.log('\nE2E PASS');
    console.log(`  steps:        ${capture.steps.length} (>= 6 required)`);
    console.log(
      `  click/type:   ${capture.steps.filter((s) => s.kind === 'click' || s.kind === 'type').length} with viewport boxes`
    );
    console.log(`  video:        ${capture.videoPath ? rel(capture.videoPath) : '—'}`);
    console.log(
      `  screenshots:  ${capture.steps.filter((s) => s.screenshotPath).length} PNGs in ${rel(path.join(PATHS.screenshots, path.basename(demoDir)))}`
    );
    console.log(`  reverify:     fresh -> ${fresh.staleSteps.length} stale; corrupted -> ${stale.staleSteps.length} stale`);
    console.log(
      `  redactions:   ${(capture.redactions ?? []).length} box(es) in capture.json (login password field), verified black in the PNG`
    );
  } finally {
    await stopDemoSite(child);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
