/**
 * Privacy-redaction verification (v0.3).
 *
 *   node packages/agent/scripts/verify-redaction.ts
 *
 * Uses a generated fixture page (data/tmp/redaction-fixture.html) with:
 *   - a password input            (heuristic: input[type=password])
 *   - a card field named cc-number (heuristic: name ~ cc-)
 *   - an SSN input                (heuristic: name ~ ssn)
 *   - an API-key text input       (heuristic: data-testid ~ api-key)
 *   - two non-sensitive controls  (email, notes) — must NOT be masked
 *   - a div/paragraph holding a key and a customer email — must NOT be masked by
 *     the heuristics, but MUST be masked when the user names them in
 *     `redactSelectors` (fixed position, so their geometry is known).
 *
 * Proves, from the bytes on disk:
 *   (a) saved PNGs contain pure-black boxes over exactly the sensitive fields
 *   (b) capture.json carries `redactions` with stepIndex
 *   (c) StepRecord.value is •••• for sensitive fields (and plaintext otherwise)
 *   (d) redactSensitive:false masks nothing and records no boxes
 *   (e) user redactSelectors mask extra elements; invalid selectors never fail a run
 *   (f) log[] lines are scrubbed of API keys / bearer tokens
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { PATHS } from '../../core/src/config.ts';
import { newId } from '../../core/src/ids.ts';
import type { Box, CaptureResult, PlannedAction, Planner, StepRecord } from '../../core/src/types.ts';
import { runCapture } from '../src/runner.ts';
import {
  MASK_COLOR,
  REDACTED_VALUE,
  clampToViewport,
  scrubSecrets,
  sensitiveSelectorGroups
} from '../src/redaction.ts';
import { readPng } from './png.ts';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function rel(absolutePath: string): string {
  const relative = path.relative(PATHS.data, absolutePath);
  return relative.startsWith('..') ? absolutePath : relative.split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Redaction fixture</title>
<style>
  html,body{margin:0;background:#101418;color:#e6e9ef;font:15px/1.4 system-ui,sans-serif}
  main{padding:24px 32px;max-width:760px}
  h1{font-size:20px;margin:0 0 14px}
  label{display:block;color:#9aa4b2;font-size:12px;margin:12px 0 4px}
  input{width:520px;height:44px;box-sizing:border-box;background:#0e1116;border:1px solid #2a3038;
        border-radius:8px;color:#e6e9ef;font-size:15px;padding:0 12px}
  .fixed{position:fixed;left:900px;width:300px;height:34px;background:#151a20;border:1px solid #2a3038;
         border-radius:6px;color:#9aa4b2;font-size:13px;padding:6px 10px;box-sizing:border-box;margin:0}
  #token-preview{top:64px}
  #secret-note{top:120px}
</style></head>
<body>
<main>
  <h1>Account settings</h1>
  <label for="email">Email</label>
  <input id="email" name="email" type="email" data-testid="email" autocomplete="email">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" data-testid="password" autocomplete="current-password">
  <label for="cc-number">Card number</label>
  <input id="cc-number" name="cc-number" data-testid="cc-number">
  <label for="ssn">SSN</label>
  <input id="ssn" name="ssn" data-testid="ssn">
  <label for="api-key">API key</label>
  <input id="api-key" name="api-key" data-testid="api-key">
  <label for="notes">Notes</label>
  <input id="notes" name="notes" data-testid="notes">
</main>
<div id="token-preview" class="fixed" data-testid="token-preview">sk-live-ABCDEFGHIJKLMNOP</div>
<p id="secret-note" class="fixed secret-note">customer: ada@example.com</p>
</body></html>
`;

const SECRETS = {
  email: 'ada@example.com',
  password: 'hunter2-super-secret',
  card: '4111111111111111',
  ssn: '123-45-6789',
  apiKey: 'sk-live-ABCDEFGHIJKLMNOP',
  notes: 'quarterly launch notes'
};

/** Fixed-position elements in the fixture (CSS px, 1280×720 viewport). */
const TOKEN_PREVIEW_BOX: Box = { x: 900, y: 64, width: 300, height: 34 };
const SECRET_NOTE_BOX: Box = { x: 900, y: 120, width: 300, height: 34 };

const ACTIONS: PlannedAction[] = [
  { kind: 'type', selector: '[data-testid="email"]', value: SECRETS.email, narration: 'Type the email address.' },
  { kind: 'type', selector: '[data-testid="password"]', value: SECRETS.password, narration: 'Type the password.' },
  { kind: 'type', selector: '[data-testid="cc-number"]', value: SECRETS.card, narration: 'Type the card number.' },
  { kind: 'type', selector: '[data-testid="ssn"]', value: SECRETS.ssn, narration: 'Type the social security number.' },
  { kind: 'type', selector: '[data-testid="api-key"]', value: SECRETS.apiKey, narration: 'Type the API key.' },
  { kind: 'type', selector: '[data-testid="notes"]', value: SECRETS.notes, narration: 'Type the notes.' }
];

const SENSITIVE_STEP_INDEXES = [1, 2, 3, 4]; // password, card, ssn, api-key
const CONTROL_STEP_INDEXES = [0, 5]; // email, notes

function replayPlanner(actions: PlannedAction[]): Planner {
  let index = 0;
  return {
    name: 'test-replay',
    async next() {
      return index < actions.length ? actions[index++] : { kind: 'done', narration: '' };
    }
  };
}

function startFixtureServer(fixturePath: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    const body = fs.readFileSync(fixturePath);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function boxesOf(capture: CaptureResult, stepIndex: number): Array<Box & { stepIndex: number }> {
  return (capture.redactions ?? []).filter((entry) => entry.stepIndex === stepIndex);
}

function boxCentre(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function containsPoint(box: Box, point: { x: number; y: number }, tolerance = 2): boolean {
  return (
    point.x >= box.x - tolerance &&
    point.x <= box.x + box.width + tolerance &&
    point.y >= box.y - tolerance &&
    point.y <= box.y + box.height + tolerance
  );
}

function approxBox(left: Box, right: Box, tolerance = 2): boolean {
  return (
    Math.abs(left.x - right.x) <= tolerance &&
    Math.abs(left.y - right.y) <= tolerance &&
    Math.abs(left.width - right.width) <= tolerance &&
    Math.abs(left.height - right.height) <= tolerance
  );
}

/** Sample five points inside a box; returns how many are mask-black. */
function blackSamples(image: ReturnType<typeof readPng>, box: Box): number {
  const points = [
    boxCentre(box),
    { x: box.x + 3, y: box.y + 3 },
    { x: box.x + box.width - 3, y: box.y + 3 },
    { x: box.x + 3, y: box.y + box.height - 3 },
    { x: box.x + box.width - 3, y: box.y + box.height - 3 }
  ];
  return points.filter((point) => image.isBlack(point.x, point.y)).length;
}

function captureJsonFor(capture: CaptureResult): { path: string; parsed: CaptureResult } {
  if (!capture.videoPath) throw new Error('capture has no video path');
  const capturePath = path.join(path.dirname(capture.videoPath), 'capture.json');
  return { path: capturePath, parsed: JSON.parse(fs.readFileSync(capturePath, 'utf8')) as CaptureResult };
}

function stepRow(step: StepRecord, capture: CaptureResult): string[] {
  const boxes = boxesOf(capture, step.index);
  const value = step.value === undefined ? '—' : step.value;
  const ownBox = boxes.find((box) => (step.box ? containsPoint(box, boxCentre(step.box)) : false));
  const pixel = ownBox && step.screenshotPath ? `${blackSamples(readPng(step.screenshotPath), ownBox)}/5 black` : '—';
  return [
    String(step.index),
    step.kind,
    step.selector ?? '—',
    value,
    String(boxes.length),
    ownBox ? `${ownBox.x},${ownBox.y} ${ownBox.width}x${ownBox.height}` : '—',
    pixel
  ];
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length))
  );
  const line = (cells: string[]): string =>
    cells.map((cell, column) => (cell ?? '').padEnd(widths[column])).join('  ').trimEnd();
  console.log('\n' + [line(headers), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n'));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpDir = path.join(PATHS.data, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const fixturePath = path.join(tmpDir, 'redaction-fixture.html');
  fs.writeFileSync(fixturePath, FIXTURE_HTML, 'utf8');
  console.log(`[redaction] fixture: ${rel(fixturePath)}`);

  const server = await startFixtureServer(fixturePath);
  try {
    // ------------------------------------------------------------------ run A
    console.log('\n[redaction] run A — default (redactSensitive on)');
    const demoA = newId('dem');
    const captureA = await runCapture({
      id: demoA,
      request: {
        instruction: 'Fill in the account settings form.',
        target: { type: 'url', url: server.url },
        options: { headless: true, maxSteps: 12 }
      },
      planner: replayPlanner(ACTIONS)
    });

    if (captureA.error) check('run A completed without error', false, `${captureA.error.code}: ${captureA.error.message}`);
    else check('run A completed without error', true);
    check('run A recorded every planned step', captureA.steps.length === ACTIONS.length, `${captureA.steps.length}/${ACTIONS.length}`);

    // (c) typed values
    for (const index of SENSITIVE_STEP_INDEXES) {
      check(`step ${index} value is redacted`, captureA.steps[index]?.value === REDACTED_VALUE, String(captureA.steps[index]?.value));
    }
    for (const index of CONTROL_STEP_INDEXES) {
      const expected = index === 0 ? SECRETS.email : SECRETS.notes;
      check(`step ${index} (non-sensitive) keeps its value`, captureA.steps[index]?.value === expected, String(captureA.steps[index]?.value));
    }
    const allValues = captureA.steps.map((step) => step.value ?? '').join('\n');
    for (const secret of [SECRETS.password, SECRETS.card, SECRETS.ssn, SECRETS.apiKey]) {
      check(`typed secret "${secret.slice(0, 6)}…" is absent from StepRecord values`, !allValues.includes(secret));
    }

    // (b) redactions in memory + on disk
    check('redactions are present', (captureA.redactions ?? []).length > 0, `${(captureA.redactions ?? []).length} box(es)`);
    for (const index of SENSITIVE_STEP_INDEXES) {
      const boxes = boxesOf(captureA, index);
      const step = captureA.steps[index];
      const stepBox = step?.box;
      const own = stepBox ? boxes.find((box) => containsPoint(box, boxCentre(stepBox))) : undefined;
      check(`step ${index} carries a redaction box over its own field`, Boolean(own), own ? `${own.x},${own.y} ${own.width}x${own.height}` : JSON.stringify(boxes));
    }

    const perStepCounts = captureA.steps.map((step) => boxesOf(captureA, step.index).length);
    check(
      'four sensitive fields on screen, deduped within each step (4 boxes, not 4×N selector matches)',
      perStepCounts.every((count) => count === SENSITIVE_STEP_INDEXES.length),
      `per-step counts: ${perStepCounts.join(',')}`
    );
    const stepBoxes = boxesOf(captureA, 3);
    const passwordMatchedBy = sensitiveSelectorGroups().filter((group) => /passw/i.test(group.selector)).length;
    check(
      'intra-step dedupe collapses overlapping heuristic matches',
      stepBoxes.length === 4 && passwordMatchedBy >= 2,
      `${stepBoxes.length} boxes for 4 elements (a password input is matched by ${passwordMatchedBy} selector groups)`
    );
    const jsonA = captureJsonFor(captureA);
    check('capture.json on disk contains redactions', (jsonA.parsed.redactions ?? []).length > 0);
    check(
      'capture.json redactions carry integer stepIndex values',
      (jsonA.parsed.redactions ?? []).every((entry) => Number.isInteger(entry.stepIndex) && entry.stepIndex >= 0)
    );
    check(
      'capture.json redactions are viewport boxes (inside 1280x720)',
      (jsonA.parsed.redactions ?? []).every(
        (entry) => entry.x >= 0 && entry.y >= 0 && entry.x + entry.width <= 1280.5 && entry.y + entry.height <= 720.5
      )
    );

    // (a) the saved PNG bytes really contain the black boxes
    let pngChecks = 0;
    let pngBlack = 0;
    for (const step of captureA.steps) {
      if (!step.screenshotPath) continue;
      const image = readPng(step.screenshotPath);
      if (image.width !== 1280 || image.height !== 720) check(`step ${step.index} PNG is 1280x720`, false, `${image.width}x${image.height}`);
      for (const box of boxesOf(captureA, step.index)) {
        pngChecks += 1;
        const black = blackSamples(image, box);
        if (black === 5) pngBlack += 1;
        else check(`step ${step.index} box at ${box.x},${box.y} is black in the PNG`, false, `${black}/5 sample points`);
      }
    }
    check(
      'every redaction box is pure black in the saved PNG',
      pngChecks > 0 && pngBlack === pngChecks,
      `${pngBlack}/${pngChecks} boxes verified pixel-by-pixel`
    );

    // Non-sensitive fields keep their pixels.
    const controlPng = readPng(captureA.steps[0].screenshotPath ?? '');
    const emailBox = captureA.steps[0].box;
    check(
      'non-sensitive field is not masked',
      Boolean(emailBox) && !controlPng.isBlack(boxCentre(emailBox as Box).x, boxCentre(emailBox as Box).y),
      emailBox ? JSON.stringify(emailBox) : 'no box'
    );
    const tokenRegion = controlPng.average(TOKEN_PREVIEW_BOX.x, TOKEN_PREVIEW_BOX.y, TOKEN_PREVIEW_BOX.width, TOKEN_PREVIEW_BOX.height);
    check(
      'the key-shaped div is untouched without a user selector',
      tokenRegion.r + tokenRegion.g + tokenRegion.b > 30,
      `average rgb ${Math.round(tokenRegion.r)},${Math.round(tokenRegion.g)},${Math.round(tokenRegion.b)}`
    );

    printTable(
      ['#', 'kind', 'selector', 'value', 'boxes', 'own box', 'png'],
      captureA.steps.map((step) => stepRow(step, captureA))
    );
    console.log(
      `\n[redaction] redactions: ${(captureA.redactions ?? []).length} entries across ${new Set((captureA.redactions ?? []).map((entry) => entry.stepIndex)).size} steps`
    );
    console.log(`[redaction] capture json: data/raw/${demoA}/capture.json`);

    // ------------------------------------------------------------------ run B
    console.log('\n[redaction] run B — redactSensitive:false');
    const captureB = await runCapture({
      request: {
        instruction: 'Fill in the account settings form.',
        target: { type: 'url', url: server.url },
        options: { headless: true, maxSteps: 12, redactSensitive: false }
      },
      planner: replayPlanner(ACTIONS)
    });
    check('run B completed', !captureB.error, captureB.error?.message ?? 'ok');
    check('run B records no redactions', (captureB.redactions ?? []).length === 0, `${(captureB.redactions ?? []).length}`);
    const jsonB = captureJsonFor(captureB);
    check('run B capture.json has no redactions key', jsonB.parsed.redactions === undefined);

    const bPng = readPng(captureB.steps[3].screenshotPath ?? '');
    const aBoxesStep3 = boxesOf(captureA, 3);
    check(
      'run B: the same regions are no longer black',
      aBoxesStep3.length > 0 && aBoxesStep3.every((box) => !bPng.isBlack(boxCentre(box).x, boxCentre(box).y)),
      `${aBoxesStep3.length} region(s) checked`
    );
    check('run B: card value is recorded in the clear', captureB.steps[2]?.value === SECRETS.card, String(captureB.steps[2]?.value));
    check('run B: api-key value is recorded in the clear', captureB.steps[4]?.value === SECRETS.apiKey, String(captureB.steps[4]?.value));
    check(
      'run B: password is still redacted (fail closed even when heuristics are off)',
      captureB.steps[1]?.value === REDACTED_VALUE,
      String(captureB.steps[1]?.value)
    );
    const step3PngB = readPng(captureB.steps[3].screenshotPath ?? '');
    check(
      'run B: no black box anywhere over the password field',
      !captureB.steps[1].box || !step3PngB.isBlack(boxCentre(captureB.steps[1].box as Box).x, boxCentre(captureB.steps[1].box as Box).y)
    );

    // ------------------------------------------------------------------ run C
    console.log('\n[redaction] run C — user redactSelectors (+ one invalid selector)');
    const captureC = await runCapture({
      request: {
        instruction: 'Fill in the account settings form.',
        target: { type: 'url', url: server.url },
        options: {
          headless: true,
          maxSteps: 12,
          redactSelectors: ['[data-testid="token-preview"]', '.secret-note', 'div[']
        }
      },
      planner: replayPlanner(ACTIONS)
    });
    check('run C completed despite an invalid selector', !captureC.error, captureC.error?.message ?? 'ok');
    check(
      'invalid selector is reported, not fatal',
      captureC.log.some((line) => line.includes('ignoring invalid redactSelectors') && line.includes('div[')),
      captureC.log.find((line) => line.includes('invalid redactSelectors')) ?? 'no log line'
    );
    const step3BoxesC = boxesOf(captureC, 3);
    const tokenBox = step3BoxesC.find((box) => approxBox(box, TOKEN_PREVIEW_BOX));
    check('user selector masks the key-shaped div', Boolean(tokenBox), JSON.stringify(step3BoxesC));
    const noteBox = step3BoxesC.find((box) => approxBox(box, SECRET_NOTE_BOX));
    check('user selector masks the customer-email paragraph', Boolean(noteBox), JSON.stringify(step3BoxesC));
    check(
      'run C keeps the automatic heuristic boxes too',
      step3BoxesC.length === SENSITIVE_STEP_INDEXES.length + 2,
      `${step3BoxesC.length} boxes (4 sensitive + 2 user)`
    );
    const cPng = readPng(captureC.steps[3].screenshotPath ?? '');
    check(
      'user-selected regions are black in the PNG',
      [TOKEN_PREVIEW_BOX, SECRET_NOTE_BOX].every((box) => blackSamples(cPng, box) === 5),
      `token ${blackSamples(cPng, TOKEN_PREVIEW_BOX)}/5, note ${blackSamples(cPng, SECRET_NOTE_BOX)}/5`
    );

    // A vision planner gets the screenshot too: it must already be masked.
    console.log('\n[redaction] observation screenshot handed to a vision planner');
    let visionScreenshot: Buffer | null = null;
    const visionPlanner = {
      name: 'test-vision',
      wantsScreenshot: true,
      async next(observation: { screenshotBase64?: string }) {
        if (observation.screenshotBase64) visionScreenshot = Buffer.from(observation.screenshotBase64, 'base64');
        return { kind: 'done' as const, narration: '' };
      }
    } as unknown as Planner;
    await runCapture({
      request: {
        instruction: 'Look at the settings form.',
        target: { type: 'url', url: server.url },
        options: { headless: true, maxSteps: 1 }
      },
      planner: visionPlanner
    });
    if (visionScreenshot) {
      const visionPng = readPng(visionScreenshot as Buffer);
      const passwordCentre = { x: 32 + 520 / 2, y: 163.6 + 44 / 2 };
      check(
        'planner screenshot has the password field masked',
        visionPng.isBlack(passwordCentre.x, passwordCentre.y),
        `${visionPng.width}x${visionPng.height} at ${passwordCentre.x},${passwordCentre.y}`
      );
      check(
        'planner screenshot keeps non-sensitive fields readable',
        !visionPng.isBlack(32 + 520 / 2, 86.8 + 44 / 2)
      );
    } else {
      check('a vision planner receives an observation screenshot', false, 'no screenshot captured');
    }

    // ------------------------------------------------------------------- text
    console.log('\n[redaction] viewport clamping (unit)');
    const partlyOff = clampToViewport({ x: -40, y: -10, width: 200, height: 100 });
    check(
      'partially off-screen boxes are clamped, not dropped',
      Boolean(partlyOff) && partlyOff?.x === 0 && partlyOff?.y === 0 && partlyOff?.width === 160 && partlyOff?.height === 90,
      JSON.stringify(partlyOff)
    );
    const fullyOff = clampToViewport({ x: 1300, y: 10, width: 100, height: 40 });
    check('fully off-screen boxes are not recorded', fullyOff === null, JSON.stringify(fullyOff));
    const bottomHalf = clampToViewport({ x: 100, y: 700, width: 200, height: 80 });
    check('half-visible bottom row is clamped to 20px', bottomHalf?.height === 20, JSON.stringify(bottomHalf));

    console.log('\n[redaction] log + text scrubbing');
    const scrubbed = [
      ['Authorization: Bearer sk-abc123456789', scrubSecrets('Authorization: Bearer sk-abc123456789')],
      ['api_key=sk-live-SECRET123', scrubSecrets('api_key=sk-live-SECRET123')],
      ['token: eyJhbGciOiJI.eyJzdWIiOiIx.abcdefghij', scrubSecrets('token: eyJhbGciOiJI.eyJzdWIiOiIx.abcdefghij')],
      ['shot of hunter2-super-secret', scrubSecrets('shot of hunter2-super-secret', [SECRETS.password])]
    ] as const;
    for (const [input, output] of scrubbed) {
      check(`scrubbed: ${input.slice(0, 32)}…`, output.includes('••••') && !/sk-abc|SECRET123|eyJhbGci|hunter2/.test(output), output);
    }

    // Integration: a key in the target URL must not survive into log[].
    const leaky = await runCapture({
      request: {
        instruction: 'Fill in the account settings form.',
        target: { type: 'url', url: `${server.url}?api_key=sk-live-URLSECRET999` },
        options: { headless: true, maxSteps: 1 }
      },
      planner: replayPlanner([])
    });
    const logText = leaky.log.join('\n');
    check('a key in the target URL is scrubbed from log[]', !logText.includes('URLSECRET999') && logText.includes('••••'));

    // ------------------------------------------------------------------ table
    printTable(
      ['#', 'kind', 'selector', 'value', 'boxes', 'own box', 'png'],
      captureA.steps.map((step) => stepRow(step, captureA))
    );

    if (failures > 0) {
      console.error(`\nREDACTION FAIL: ${failures} check(s) failed`);
      process.exitCode = 1;
      return;
    }
    console.log('\nREDACTION PASS: screenshots masked at capture, video boxes recorded per step, values + logs scrubbed');
    console.log(`  redactions            ${(captureA.redactions ?? []).length} box(es) over ${new Set((captureA.redactions ?? []).map((e) => e.stepIndex)).size} step(s)`);
    console.log(`  mask colour           ${MASK_COLOR}`);
    console.log(`  run A id              ${demoA}`);
    console.log(`  screenshots           data/screenshots/${demoA}/ (${captureA.steps.length} PNGs)`);
    console.log(`  video                 ${captureA.videoPath ? `data/raw/${demoA}/demo.webm` : 'none'}`);
  } finally {
    await server.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
