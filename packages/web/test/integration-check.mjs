/**
 * Read-only integration check against a *live* Reelforge API + seeded data.
 *
 *   npm run api                  # terminal 1 (or wherever the API is running)
 *   node packages/web/test/integration-check.mjs
 *
 * Uses data/dev-api-key.txt (or REELFORGE_API_KEY), browses the real dashboard
 * served at /app, and opens the real embeddable guide at /g/demo.html. It never
 * mutates the workspace: only GETs are issued, and the guide's skip report is
 * intercepted.
 *
 * Skips (exit 0) when the API is down or has no completed demo yet, so it can
 * sit in the dev workflow without being brittle.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const artifacts = path.join(here, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });

const ORIGIN = (process.env.REELFORGE_API_URL || 'http://127.0.0.1:4400').replace(/\/$/, '');

function readKey() {
  if (process.env.REELFORGE_API_KEY) return process.env.REELFORGE_API_KEY.trim();
  const file = path.join(repoRoot, 'data', 'dev-api-key.txt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return '';
}

const KEY = readKey();
if (!KEY) {
  console.log('integration check: no API key (data/dev-api-key.txt or REELFORGE_API_KEY) — skipping');
  process.exit(0);
}

async function apiGet(routePath) {
  const response = await fetch(`${ORIGIN}/api${routePath}`, {
    headers: { 'X-API-Key': KEY, accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`GET ${routePath} -> ${response.status}`);
  const payload = await response.json();
  return payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
}

let demos;
try {
  demos = await apiGet('/demos');
} catch (error) {
  console.log(`integration check: API not reachable at ${ORIGIN} (${error.message}) — skipping`);
  process.exit(0);
}

const complete = (Array.isArray(demos) ? demos : []).find((demo) => demo.status === 'complete');
if (!complete) {
  console.log('integration check: no completed demo in the workspace — skipping');
  process.exit(0);
}

const [detail, workspace, environments, articles, guides] = await Promise.all([
  apiGet(`/demos/${complete.id}`),
  apiGet('/workspace').catch(() => ({ name: 'Personal' })),
  apiGet('/environments').catch(() => []),
  apiGet('/articles').catch(() => []),
  apiGet('/guides').catch(() => [])
]);

const guide = (Array.isArray(guides) ? guides : []).find((item) => item.status === 'live') ?? guides[0];
const environmentList = Array.isArray(environments) ? environments : [];
// Prefer the environment the demo recorded against; otherwise the first one
// that actually has flows (other agents share this workspace).
let graphEnv = environmentList.find((item) => item.id === complete.environment_id) ?? null;
let flows = graphEnv ? await apiGet(`/environments/${graphEnv.id}/graph/flows`).catch(() => []) : [];
if (!Array.isArray(flows) || flows.length === 0) {
  for (const candidate of environmentList) {
    const candidateFlows = await apiGet(`/environments/${candidate.id}/graph/flows`).catch(() => []);
    if (Array.isArray(candidateFlows) && candidateFlows.length > 0) {
      graphEnv = candidate;
      flows = candidateFlows;
      break;
    }
  }
}
const transcript = await apiGet(`/demos/${complete.id}/transcript`).catch(() => ({ lines: [] }));
const lines = Array.isArray(transcript.lines) ? transcript.lines : [];
const steps = Array.isArray(detail.steps) ? detail.steps : [];
const flow = (Array.isArray(flows) ? flows : [])[0];
const article = (Array.isArray(articles) ? articles : [])[0];

console.log(`integration check: ${ORIGIN}`);
console.log(`  workspace ${workspace.name} · demo ${complete.id} · ${steps.length} steps · ${lines.length} transcript lines`);
console.log(`  environment ${graphEnv?.name ?? '(none)'} · flow ${flow?.name ?? '(none)'} · article ${article?.id ?? '(none)'} · guide ${guide?.id ?? '(none)'}\n`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
await context.addInitScript((key) => {
  localStorage.setItem('reelforge.apiKey', key);
  localStorage.setItem('reelforge.onboarded', '1');
}, KEY);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

let checks = 0;
const failures = [];
async function check(label, fn) {
  try {
    await fn();
    checks += 1;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`  FAIL ${label} — ${error.message}`);
  }
}

try {
  // ------------------------------------------------------------- demos list
  await page.goto(`${ORIGIN}/app/`);
  await page.waitForSelector('.topbar', { timeout: 15000 });

  await check('real workspace + API-online state render', async () => {
    await page.getByText(workspace.name).first().waitFor();
    await page.getByText('API online').first().waitFor();
  });

  await check('real demos table renders the recorded demo', async () => {
    await page.getByText('Complete').first().waitFor();
    const body = await page.locator('tbody').innerText();
    const snippet = complete.instruction.slice(0, 28);
    assert.ok(body.includes(snippet), `table shows ${JSON.stringify(snippet)}`);
    assert.ok(
      body.includes('one-off URL') || environmentList.some((item) => body.includes(item.name)),
      'environment column resolves'
    );
  });

  await page.screenshot({ path: path.join(artifacts, 'real-demos.png') });

  // ----------------------------------------------------------- demo detail
  await page.getByText(complete.instruction.slice(0, 28)).first().click();
  await page.waitForFunction(() => location.hash.includes('dem_'), undefined, { timeout: 10000 });

  await check('real demo detail: player, outcome, every recorded step', async () => {
    await page.getByRole('heading', { name: complete.instruction }).waitFor({ timeout: 15000 });
    await page.getByText('Goal met').first().waitFor();
    assert.equal(await page.locator('video').count(), 1, 'video player with a signed URL');
    assert.equal(await page.locator('a.thumb img').count(), steps.length, 'one screenshot per step');
    const body = await page.locator('main').innerText();
    assert.ok(/what was shown/i.test(body), 'outcome list renders');
    assert.ok(body.includes(complete.outcome_json ? JSON.parse(complete.outcome_json).whatWasShown[0] : 'Open'), 'first shown item renders');
  });

  await check('real transcript lines render with timestamps', async () => {
    await page.getByRole('tab', { name: /Transcript/ }).click();
    await page.waitForFunction((count) => document.querySelectorAll('.transcript-line').length === count, lines.length, {
      timeout: 10000
    });
    const body = await page.locator('.transcript').innerText();
    assert.ok(body.includes(lines[0].text), 'first narration line renders');
    assert.match(body, /\d:\d\d/, 'timestamps render');
  });

  await page.screenshot({ path: path.join(artifacts, 'real-demo-detail.png') });

  await check('real raw tab exposes the API payload', async () => {
    await page.getByRole('tab', { name: 'Raw' }).click();
    const raw = await page.locator('.code-block pre').first().innerText();
    assert.ok(raw.includes(complete.id), 'raw JSON includes the demo id');
  });

  // ---------------------------------------------------------------- graph
  if (graphEnv) await page.goto(`${ORIGIN}/app/#/graph/${graphEnv.id}`);
  else await page.goto(`${ORIGIN}/app/#/graph`);
  await check('real Product Graph: flow with steps and verification state', async () => {
    await page.locator('#env-select').waitFor({ timeout: 15000 });
    if (!graphEnv) return;
    const selected = await page.locator('#env-select').inputValue();
    assert.equal(selected, graphEnv.id, 'the environment selector points at the recorded environment');
    if (!flow) return;
    await page.getByText(flow.name).first().waitFor({ timeout: 15000 });
    const body = await page.locator('main').innerText();
    assert.ok(body.includes('Fresh') || body.includes('Stale'), 'flow status badge renders');
    assert.ok(body.includes('signature'), 'signature is surfaced');
    await page.waitForFunction(() => document.querySelectorAll('.step-row').length > 0, undefined, { timeout: 10000 });
    const stepRows = await page.locator('.step-row').count();
    assert.ok(stepRows > 0, `flow steps render (${stepRows})`);
  });

  await page.screenshot({ path: path.join(artifacts, 'real-graph.png') });

  // ------------------------------------------------------------- articles
  await page.goto(`${ORIGIN}/app/#/articles`);
  await check('real article renders as markdown', async () => {
    if (!article) return;
    await page.getByText(article.title).first().waitFor({ timeout: 15000 });
    await page.waitForSelector('.md h1', { timeout: 10000 });
    const md = await page.locator('.md').innerText();
    assert.ok(md.length > 80, 'article body renders');
  });

  await page.screenshot({ path: path.join(artifacts, 'real-articles.png') });

  // --------------------------------------------------------------- guides
  await page.goto(`${ORIGIN}/app/#/guides`);
  await check('real guide shows its embed snippet and steps', async () => {
    if (!guide) return;
    await page.getByText(guide.name).first().waitFor({ timeout: 15000 });
    const snippet = await page.locator('.code-block pre').first().innerText();
    assert.ok(snippet.includes('/g/guide.js'), 'snippet points at the served bundle');
    assert.ok(snippet.includes(guide.embed_key), 'snippet carries the real embed key');
  });

  await page.screenshot({ path: path.join(artifacts, 'real-guides.png') });

  // --------------------------------------------------------- environments
  await page.goto(`${ORIGIN}/app/#/environments`);
  await check('real environment renders with its sign-in state', async () => {
    const env = graphEnv ?? environmentList[0];
    if (!env) return;
    await page.getByRole('heading', { name: env.name }).waitFor({ timeout: 15000 });
    const body = await page.locator('main').innerText();
    assert.ok(body.includes(env.base_url.replace(/\/$/, '')), 'base URL renders');
  });

  // -------------------------------------------------------------- settings
  await page.goto(`${ORIGIN}/app/#/settings`);
  await check('settings renders snippets for this deployment', async () => {
    await page.getByRole('heading', { name: 'API keys' }).waitFor({ timeout: 15000 });
    const body = await page.locator('main').innerText();
    assert.ok(body.includes('/api/mcp'), 'MCP snippet renders');
    assert.ok(body.includes('/api/demos'), 'curl snippet renders');
  });

  await page.screenshot({ path: path.join(artifacts, 'real-settings.png') });

  // ------------------------------------------- embeddable widget, live data
  if (guide) {
    const widgetPage = await context.newPage();
    widgetPage.on('pageerror', (error) => errors.push(error.message));
    await widgetPage.route('**/api/guides/*/report', (route) => route.abort());
    await widgetPage.goto(`${ORIGIN}/g/demo.html?key=${encodeURIComponent(guide.embed_key)}`);

    await check('live guide widget walks real recorded steps on a third-party page', async () => {
      await widgetPage.waitForFunction(
        () => {
          const host = document.querySelector('[data-reelforge-guide]');
          return !!(host && host.shadowRoot && host.shadowRoot.querySelector('.rg-card'));
        },
        undefined,
        { timeout: 12000 }
      );
      const firstCount = (await widgetPage.locator('.rg-count').textContent()).trim();
      assert.match(firstCount, /^\d+ \/ \d+$/, 'step counter renders');
      await widgetPage.screenshot({ path: path.join(artifacts, 'real-guide-widget.png') });
      await widgetPage.locator('.rg-btn.next').click();
      await widgetPage.waitForFunction(
        (first) => document.querySelector('[data-reelforge-guide]').shadowRoot.querySelector('.rg-count').textContent.trim() !== first,
        firstCount,
        { timeout: 5000 }
      );
      await widgetPage.keyboard.press('Escape');
      await widgetPage.waitForFunction(() => !document.querySelector('[data-reelforge-guide]'), undefined, { timeout: 5000 });
    });
    await widgetPage.close();
  }

  await check('no uncaught page errors on real data', async () => {
    assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
  });
} finally {
  await browser.close();
}

console.log('');
if (failures.length > 0) {
  console.error(`integration check: ${failures.length} failed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`integration check: ${checks} checks passed against the live API`);
console.log(`artifacts: ${artifacts}`);
