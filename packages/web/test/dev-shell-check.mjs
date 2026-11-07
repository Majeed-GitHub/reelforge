/**
 * Dev-server sanity check (`npm run web`, API deliberately absent).
 *
 *   npx vite --config packages/web/vite.config.ts   # terminal 1
 *   node packages/web/test/dev-shell-check.mjs      # terminal 2
 *
 * Proves the shell renders from Vite's dev pipeline with no API running: the
 * onboarding panel for a browser with no key, and a clear error state (never a
 * blank page) on every route once a key is present. The dev server proxies /api
 * to :4400, which refuses the connection — exactly the failure mode we care
 * about.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(here, 'artifacts');
const ORIGIN = process.env.REELFORGE_WEB_URL || 'http://127.0.0.1:4401';

const browser = await chromium.launch();
const errors = [];
let checks = 0;

function pass(label) {
  checks += 1;
  console.log(`  ok  ${label}`);
}

try {
  // ------------------------------------------------------------ first run
  const firstRun = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await firstRun.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Connect this dashboard to your API').waitFor({ timeout: 15000 });
  const onboarding = await page.locator('.onboard-card').innerText();
  assert.ok(onboarding.includes('npm run seed'), 'seed hint is on the first-run panel');
  pass('dev server: onboarding panel renders with the seed hint');
  await page.screenshot({ path: path.join(artifacts, 'dev-onboarding.png') });

  // ------------------------------------------- key present, shell must render
  const withKey = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await withKey.addInitScript(() => {
    localStorage.setItem('reelforge.apiKey', 'rg_dev_check_0123456789');
    localStorage.setItem('reelforge.onboarded', '1');
  });
  const shell = await withKey.newPage();
  shell.on('pageerror', (error) => errors.push(error.message));
  await shell.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await shell.locator('.topbar').waitFor({ timeout: 15000 });
  await shell.waitForFunction(() => location.hash.includes('demos'), undefined, { timeout: 8000 });
  await shell.waitForFunction(() => (document.querySelector('main')?.innerText ?? '').trim().length > 40, undefined, {
    timeout: 15000
  });
  assert.equal(await shell.locator('.sidebar .nav-item').count(), 6, 'six sidebar entries render');
  assert.equal(await shell.locator('.topbar').count(), 1, 'top bar renders');
  pass('dev server: shell renders (demos screen shows data, an empty state, or an API error panel)');

  for (const route of ['demos', 'demos/new', 'graph', 'articles', 'guides', 'environments', 'settings']) {
    await shell.goto(`${ORIGIN}/#/${route}`, { waitUntil: 'domcontentloaded' });
    await shell.waitForTimeout(700);
    const body = (await shell.locator('main').innerText()).trim();
    assert.ok(body.length > 40, `#/${route} rendered ${body.length} chars`);
    assert.equal(await shell.locator('main').count(), 1, 'one main landmark');
  }
  pass('dev server: every route renders content');
  await shell.screenshot({ path: path.join(artifacts, 'dev-shell.png') });
  await firstRun.close();
  await withKey.close();
} finally {
  await browser.close();
}

assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
console.log(`\ndev shell check: ${checks} checks passed against ${ORIGIN}`);
console.log(`artifacts: ${artifacts}`);
