/**
 * Credentials path: when `request.credentials` is supplied, the scripted
 * planner types the email and password into the sign-in form (instead of just
 * submitting a prefilled form) — and the password must never leak into the
 * capture artefacts.
 *
 *   node packages/agent/scripts/verify-credentials.ts
 */

import fs from 'node:fs';
import path from 'node:path';

import { PATHS, ROOT } from '../../core/src/config.ts';
import type { CaptureResult } from '../../core/src/types.ts';
import { runCapture } from '../src/runner.ts';
import { REDACTED_VALUE } from '../src/redaction.ts';
import { readPng } from './png.ts';
import { BASE_URL, resetDemoSite, startDemoSite, stopDemoSite } from './demo.ts';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function rel(absolutePath: string): string {
  const relative = path.relative(ROOT, absolutePath);
  return relative.startsWith('..') ? absolutePath : relative.split(path.sep).join('/');
}

const INSTRUCTION =
  'Sign in, create a project called Q4 Launch, invite sam@example.com to the team, then upgrade to the Team plan.';

async function main(): Promise<void> {
  const child = await startDemoSite();
  try {
    await resetDemoSite();

    const capture: CaptureResult = await runCapture({
      request: {
        instruction: INSTRUCTION,
        target: { type: 'url', url: `${BASE_URL}/` },
        credentials: { username: 'ada@example.com', password: 'northwind' },
        options: { headless: true, maxSteps: 40 }
      }
    });

    console.log(`[credentials] steps=${capture.steps.length} goalMet=${capture.goalMet} finalUrl=${capture.finalUrl}`);
    if (capture.error) check('no capture error', false, `${capture.error.code}: ${capture.error.message}`);
    else check('no capture error', true);

    check('goal reached', capture.goalMet === true);
    check('landed on the upgraded billing page', (capture.finalUrl ?? '').includes('/app/billing?upgraded=1'), capture.finalUrl);

    const emailStep = capture.steps.find((step) => step.kind === 'type' && /email/i.test(step.selector ?? ''));
    const passwordStep = capture.steps.find((step) => step.kind === 'type' && /password/i.test(step.selector ?? ''));
    check('typed the email into the form', Boolean(emailStep), emailStep?.selector);
    check('typed the password into the form', Boolean(passwordStep), passwordStep?.selector);
    check('email value is recorded', emailStep?.value === 'ada@example.com', String(emailStep?.value));
    check('password value is redacted in the step record', passwordStep?.value === REDACTED_VALUE, String(passwordStep?.value));
    check(
      'both sign-in fields have viewport boxes',
      Boolean(emailStep?.box && passwordStep?.box),
      JSON.stringify([emailStep?.box, passwordStep?.box])
    );

    // Redaction on the real demo flow: the password field is on screen when the
    // sign-in form is observed, so it must be a redaction box and black in pixels.
    const signInStepIndexes = new Set(
      [passwordStep?.index, emailStep?.index].filter((index): index is number => typeof index === 'number')
    );
    const passwordBoxes = (capture.redactions ?? []).filter((entry) => signInStepIndexes.has(entry.stepIndex));
    check('the sign-in password field is recorded as a redaction box', passwordBoxes.length > 0, JSON.stringify(passwordBoxes));
    if (passwordStep?.screenshotPath && passwordStep.box) {
      const png = readPng(passwordStep.screenshotPath);
      const centre = { x: passwordStep.box.x + passwordStep.box.width / 2, y: passwordStep.box.y + passwordStep.box.height / 2 };
      check('the password field is black in the step PNG', png.isBlack(centre.x, centre.y));
      check(
        'the email field on the same PNG is not masked',
        Boolean(emailStep?.box) && !png.isBlack(emailStep!.box!.x + emailStep!.box!.width / 2, emailStep!.box!.y + emailStep!.box!.height / 2)
      );
    }

    const demoDir = capture.videoPath ? path.dirname(capture.videoPath) : '';
    const captureJson = demoDir ? fs.readFileSync(path.join(demoDir, 'capture.json'), 'utf8') : '';
    check('the password never appears in capture.json', captureJson.length > 0 && !captureJson.includes('northwind'));
    check('video exists', Boolean(capture.videoPath && fs.existsSync(capture.videoPath)), capture.videoPath ? rel(capture.videoPath) : 'none');
    check(
      'screenshots exist for every step',
      capture.steps.every((step) => step.screenshotPath && fs.existsSync(step.screenshotPath)),
      `${capture.steps.filter((step) => step.screenshotPath && fs.existsSync(step.screenshotPath)).length}/${capture.steps.length}`
    );

    if (capture.videoPath) {
      const demoId = path.basename(path.dirname(capture.videoPath));
      console.log(`[credentials] demoId=${demoId} video=${rel(capture.videoPath)} (${fs.statSync(capture.videoPath).size} bytes)`);
      console.log(`[credentials] screenshots: ${rel(path.join(PATHS.screenshots, demoId))}`);
      console.log(`[credentials] narrations: ${capture.steps.map((step) => `"${step.narration}"`).join(' | ')}`);
    }

    if (failures > 0) {
      console.error(`\nCREDENTIALS FAIL: ${failures} check(s) failed`);
      process.exitCode = 1;
      return;
    }
    console.log('\nCREDENTIALS PASS: credentials are typed on camera and redacted in the record');
  } finally {
    await stopDemoSite(child);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
