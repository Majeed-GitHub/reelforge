/**
 * Behavioural checks that the happy-path e2e does not cover:
 *
 *   - destructive actions stop the run unless confirmDestructive is set
 *   - options.maxSteps actually bounds the loop
 *   - a run with no target fails fast with TARGET_UNREACHABLE
 *   - the video is still finalised when the run stops early
 *   - LLM output parsing/repair/validation rejects bad JSON and bad refs
 *   - the instruction grammar parses the demo sentence into ordered intents
 *
 *   node packages/agent/scripts/verify-guards.ts
 */

import http from 'node:http';
import fs from 'node:fs';

import type { Observation, Planner, PlannedAction } from '../../core/src/types.ts';
import { runCapture } from '../src/runner.ts';
import { parseIntents, ScriptedPlanner } from '../src/planner/scripted.ts';
import { parseJsonObject, validateAction, LlmPlanner, PlannerError } from '../src/planner/llm.ts';
import { createPlanner } from '../src/planner/index.ts';
import { createNarrator } from '../src/narration.ts';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// A throwaway page with a destructive button and a harmless one
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Guard test</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;margin:40px;background:#0b0d10;color:#e8eaed}
  button{margin:8px 12px 8px 0;padding:10px 16px;border-radius:8px;border:1px solid #333;background:#1e242c;color:#e8eaed}
</style></head>
<body>
  <h1>Guard test page</h1>
  <input id="name" name="name" aria-label="Project name" placeholder="Name">
  <button data-testid="save">Save</button>
  <button data-testid="delete-account">Delete account</button>
</body></html>`;

function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(PAGE);
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

function replayPlanner(actions: PlannedAction[]): Planner {
  let index = 0;
  return {
    name: 'test-replay',
    async next() {
      return index < actions.length ? actions[index++] : { kind: 'done', narration: '' };
    }
  };
}

function foreverPlanner(selector: string): Planner {
  return {
    name: 'test-forever',
    async next() {
      return { kind: 'click', selector, narration: 'Click Save.' };
    }
  };
}

// ---------------------------------------------------------------------------
// Offline parser checks (no browser)
// ---------------------------------------------------------------------------

function checkParsers(): void {
  console.log('\n[guards] LLM output parsing + validation');
  const fenced = '```json\n{ "kind": "click", "ref": 2, "narration": "Click Save." }\n```';
  const parsed = parseJsonObject(fenced);
  check('strips markdown fences', parsed.kind === 'click' && parsed.ref === 2, JSON.stringify(parsed));

  const repaired = parseJsonObject('{ "kind": "type", "ref": 1, "value": "hello", }');
  check('repairs a trailing comma', repaired.kind === 'type' && repaired.value === 'hello');

  let threw = false;
  try {
    parseJsonObject('the model rambled instead');
  } catch {
    threw = true;
  }
  check('throws on prose instead of JSON', threw);

  const observation: Observation = {
    step: 0,
    url: 'http://example.test/',
    title: 'Example',
    domDigest: '',
    elements: [
      { ref: 0, role: 'button', name: 'Save', tag: 'button', selector: '[data-testid="save"]', box: { x: 0, y: 0, width: 10, height: 10 } }
    ],
    history: [],
    goal: 'save'
  };

  const action = validateAction({ kind: 'click', ref: 0, narration: 'Click Save.' }, observation);
  check('takes the selector from the observation, not the model', action.selector === '[data-testid="save"]', action.selector);

  let refThrew = false;
  try {
    validateAction({ kind: 'click', ref: 99 }, observation);
  } catch {
    refThrew = true;
  }
  check('rejects a hallucinated ref', refThrew);

  let kindThrew = false;
  try {
    validateAction({ kind: 'teleport' }, observation);
  } catch {
    kindThrew = true;
  }
  check('rejects an unknown action kind', kindThrew);

  let valueThrew = false;
  try {
    validateAction({ kind: 'type', ref: 0 }, observation);
  } catch {
    valueThrew = true;
  }
  check('rejects a type action without a value', valueThrew);
}

function checkGrammar(): void {
  console.log('\n[guards] offline instruction grammar');
  const instruction =
    'Sign in, create a project called Q4 Launch, invite sam@example.com to the team, then upgrade to the Team plan.';
  const intents = parseIntents(instruction);
  const kinds = intents.map((intent) => intent.kind);
  check('parses the four intents in order', JSON.stringify(kinds) === JSON.stringify(['signin', 'create_project', 'invite', 'upgrade']), JSON.stringify(kinds));
  check(
    'extracts the project name',
    intents.find((intent) => intent.kind === 'create_project')?.params.projectName === 'Q4 Launch',
    JSON.stringify(intents.find((intent) => intent.kind === 'create_project')?.params)
  );
  check(
    'extracts the invite email',
    intents.find((intent) => intent.kind === 'invite')?.params.email === 'sam@example.com',
    JSON.stringify(intents.find((intent) => intent.kind === 'invite')?.params)
  );
  check(
    'extracts the plan name',
    intents.find((intent) => intent.kind === 'upgrade')?.params.plan === 'Team',
    JSON.stringify(intents.find((intent) => intent.kind === 'upgrade')?.params)
  );
  const planner = new ScriptedPlanner({ instruction });
  check('scripted planner advertises its intents', planner.recognisableIntents.length === 4, planner.recognisableIntents.join(' | '));
}

// ---------------------------------------------------------------------------
// Browser-level guard checks
// ---------------------------------------------------------------------------

async function checkRunnerGuards(url: string): Promise<void> {
  console.log('\n[guards] destructive gate');

  const blocked = await runCapture({
    request: {
      instruction: 'Delete the account.',
      target: { type: 'url', url },
      options: { headless: true, maxSteps: 5 }
    },
    planner: replayPlanner([{ kind: 'click', selector: '[data-testid="delete-account"]', narration: 'Delete the account.' }])
  });
  check('stops before the destructive step', blocked.steps.length === 0, `${blocked.steps.length} step(s)`);
  check(
    'reports DESTRUCTIVE_ACTIONS_CONFIRMATION_REQUIRED',
    blocked.error?.code === 'DESTRUCTIVE_ACTIONS_CONFIRMATION_REQUIRED',
    `${blocked.error?.code}: ${blocked.error?.message}`
  );
  check('names the blocked target', blocked.stoppedBefore === 'Delete account', String(blocked.stoppedBefore));
  check('still finalises the video on the early-stop path', Boolean(blocked.videoPath && fs.existsSync(blocked.videoPath)), blocked.videoPath ?? 'none');

  const allowed = await runCapture({
    request: {
      instruction: 'Delete the account.',
      target: { type: 'url', url },
      confirmDestructive: true,
      options: { headless: true, maxSteps: 5 }
    },
    planner: replayPlanner([{ kind: 'click', selector: '[data-testid="delete-account"]', narration: 'Delete the account.' }])
  });
  check('confirmDestructive lets the step through', allowed.steps.length === 1 && !allowed.error, `${allowed.steps.length} step(s), error=${allowed.error?.code ?? 'none'}`);
  check('the destructive click has a box and a point', Boolean(allowed.steps[0]?.box && allowed.steps[0]?.point), JSON.stringify(allowed.steps[0]?.box));
  check('goalMet is true after the allowed step', allowed.goalMet === true);

  console.log('\n[guards] step budget');
  const budgeted = await runCapture({
    request: {
      instruction: 'Keep saving.',
      target: { type: 'url', url },
      options: { headless: true, maxSteps: 2 }
    },
    planner: foreverPlanner('[data-testid="save"]')
  });
  check('maxSteps is honoured', budgeted.steps.length === 2, `${budgeted.steps.length} step(s)`);
  check('budget exhaustion is not an error', !budgeted.error, budgeted.error?.code ?? 'none');
  check('goalMet stays false when the planner never finished', budgeted.goalMet === false);
  check(
    'timings are monotonic relative to recording start',
    budgeted.steps[1].startedAtMs >= budgeted.steps[0].endedAtMs,
    `${budgeted.steps[0].endedAtMs} -> ${budgeted.steps[1].startedAtMs}`
  );

  console.log('\n[guards] missing target');
  const noTarget = await runCapture({ request: { instruction: 'Do something.' } });
  check('fails fast with TARGET_UNREACHABLE', noTarget.error?.code === 'TARGET_UNREACHABLE', noTarget.error?.message);
  check('does not produce a video', !noTarget.videoPath);
}

// ---------------------------------------------------------------------------
// LLM planner against a local fake OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

type FakeReply = { status: number; body: string };

type FakeLlm = {
  baseUrl: string;
  requests: Array<{ authorization: string | undefined; body: Record<string, unknown> }>;
  reply: (next: FakeReply) => void;
  close: () => Promise<void>;
};

function startFakeLlm(initial: FakeReply): Promise<FakeLlm> {
  let current = initial;
  const requests: FakeLlm['requests'] = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      requests.push({ authorization: request.headers.authorization, body: parsed });
      response.writeHead(current.status, { 'Content-Type': 'application/json' });
      response.end(current.body);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        reply: (next): void => {
          current = next;
        },
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

function completion(content: string): FakeReply {
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }) };
}

async function checkLlmPlanner(): Promise<void> {
  console.log('\n[guards] LLM planner against a fake OpenAI-compatible endpoint');
  const observation: Observation = {
    step: 0,
    url: 'http://example.test/',
    title: 'Example',
    domDigest: 'URL: /\nTITLE: Example\n0 button "Save" [data-testid=save]',
    elements: [
      {
        ref: 0,
        role: 'button',
        name: 'Save',
        tag: 'button',
        selector: '[data-testid="save"]',
        box: { x: 10, y: 10, width: 80, height: 30 }
      }
    ],
    history: [],
    goal: 'Save the record.'
  };

  const fake = await startFakeLlm(completion('```json\n{ "kind": "click", "ref": 0, "narration": "Click Save.", "reason": "finish" }\n```'));
  try {
    const planner = new LlmPlanner({
      instruction: 'Save the record.',
      baseUrl: fake.baseUrl,
      apiKey: 'test-key',
      model: 'fake-model'
    });
    check('planner advertises itself as vision-capable', planner.wantsScreenshot === true);

    const action = await planner.next(observation);
    check('parses a fenced JSON action from the model', action.kind === 'click' && action.ref === 0, JSON.stringify(action));
    check('resolves the selector from the observation', action.selector === '[data-testid="save"]', action.selector);

    const sent = fake.requests.at(-1);
    check('sends the bearer token', sent?.authorization === 'Bearer test-key', String(sent?.authorization));
    check('sends the configured model', sent?.body.model === 'fake-model', String(sent?.body.model));
    const messages = Array.isArray(sent?.body.messages) ? (sent?.body.messages as Array<{ content?: unknown }>) : [];
    const prompt = JSON.stringify(messages);
    check('includes the goal and the element digest', prompt.includes('Save the record.') && prompt.includes('data-testid=save'));
    check('does not leak a selector the model could copy as truth', !prompt.includes('"selector"'));

    fake.reply({ status: 500, body: '{"error":"boom"}' });
    let httpCode = '';
    try {
      await planner.next(observation);
    } catch (error) {
      httpCode = error instanceof PlannerError ? error.code : `wrong-type:${String(error)}`;
    }
    check('throws a typed error on HTTP failure', httpCode === 'LLM_HTTP_ERROR', httpCode);

    fake.reply(completion('I would click the save button now.'));
    let parseCode = '';
    try {
      await planner.next(observation);
    } catch (error) {
      parseCode = error instanceof PlannerError ? error.code : `wrong-type:${String(error)}`;
    }
    check('throws a typed error on unparseable content', parseCode === 'LLM_INVALID_JSON', parseCode);

    // Factory + fallback: a broken endpoint must not kill the run.
    const resilient = createPlanner({
      instruction: 'Save the record.',
      llm: { baseUrl: fake.baseUrl, apiKey: 'test-key', model: 'fake-model', provider: 'auto' }
    });
    const fallbackAction = await resilient.next(observation);
    check('factory falls back to the scripted planner instead of throwing', typeof fallbackAction.kind === 'string', `kind=${fallbackAction.kind}, planner=${resilient.name}`);
    check('fallback marks itself as degraded', resilient.name.includes('fell back'), resilient.name);

    // Narrator: LLM line when usable, template when it is not.
    fake.reply(completion('The record is saved from the form.'));
    const narrator = createNarrator({ llm: { baseUrl: fake.baseUrl, apiKey: 'test-key', model: 'fake-model' } });
    const narrated = await narrator.narrate({ kind: 'click', selector: '[data-testid="save"]' }, observation.elements[0]);
    check('LLM narration is used when it is on-style', narrated === 'The record is saved from the form.', narrated);

    fake.reply(completion('I click the #save button with data-testid=save.'));
    const sanitized = await narrator.narrate({ kind: 'click', selector: '[data-testid="save"]' }, observation.elements[0]);
    check('narration falls back to the template when it breaks house style', sanitized === 'Click Save.', sanitized);
  } finally {
    await fake.close();
  }
}

async function main(): Promise<void> {
  checkParsers();
  checkGrammar();
  await checkLlmPlanner();

  const server = await serve();
  try {
    await checkRunnerGuards(server.url);
  } finally {
    await server.close();
  }

  if (failures > 0) {
    console.error(`\nGUARDS FAIL: ${failures} check(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log('\nGUARDS PASS: destructive gate, step budget, error envelope, planner parsers');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
