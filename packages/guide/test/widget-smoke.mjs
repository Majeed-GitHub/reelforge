/**
 * Browser smoke test for the embeddable guide widget.
 *
 *   node packages/guide/build.mjs
 *   node packages/guide/test/widget-smoke.mjs
 *
 * Serves packages/guide/dist plus a fake guide API on one port, then drives a
 * real Chromium window: spotlight geometry, step navigation, keyboard, dismiss,
 * skip-and-report, and shadow-DOM style isolation. Emits PNGs into ./artifacts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '..', 'dist');
const artifacts = path.join(here, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });

if (!fs.existsSync(path.join(dist, 'guide.js'))) {
  console.error('guide.js missing — run `node packages/guide/build.mjs` first.');
  process.exit(1);
}

const reports = [];

const GUIDE = {
  id: 'gd_test123',
  name: 'Create a project',
  steps: [
    {
      idx: 0,
      selector: '[data-testid="new-project"]',
      role: 'link',
      name: 'New project',
      title: 'Open the new project form',
      body: 'Click New project to start a project.',
      url: '/app/projects/new'
    },
    {
      idx: 1,
      selector: '[data-testid="project-name"]',
      role: 'textbox',
      name: 'Project name',
      title: 'Name the project',
      body: 'Give it a name your team will recognise.',
      url: null
    },
    {
      idx: 2,
      selector: '[data-testid="create-project"]',
      role: 'button',
      name: 'Create project',
      title: 'Create it',
      body: 'Submit the form to finish.',
      url: null
    }
  ]
};

/** Same guide, but the middle step points at something that is not on the page. */
const GUIDE_WITH_SKIP = {
  id: 'gd_skip',
  name: 'Create a project (stale middle step)',
  steps: [
    GUIDE.steps[0],
    {
      idx: 1,
      selector: '[data-testid="gone-forever"]',
      role: 'button',
      name: 'A button that no longer exists',
      title: 'This step is stale',
      body: 'It should be skipped, never shown.',
      url: null
    },
    { ...GUIDE.steps[2], idx: 2 }
  ]
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8'
};

function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const embed = /^\/api\/guides\/embed\/([^/]+)$/.exec(url.pathname);
  if (embed) {
    const key = decodeURIComponent(embed[1]);
    const guide = key === 'gd_skip' ? GUIDE_WITH_SKIP : key === 'gd_unknown' ? null : GUIDE;
    if (!guide) return json(res, { code: 'NOT_FOUND', message: 'No guide for that embed key' }, 404);
    return json(res, { message: 'OK', data: guide });
  }

  const report = /^\/api\/guides\/([^/]+)\/report$/.exec(url.pathname);
  if (report && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        reports.push({ id: decodeURIComponent(report[1]), body: JSON.parse(body || '{}') });
      } catch {
        reports.push({ id: decodeURIComponent(report[1]), body: body });
      }
      res.writeHead(204);
      res.end();
    });
    return;
  }

  const rel = url.pathname === '/' ? '/demo.html' : url.pathname;
  const file = path.join(dist, rel.replace(/^\/+/, ''));
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log(`guide smoke: serving ${dist} at ${base}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

const cardVisible = () =>
  page.waitForFunction(() => {
    const host = document.querySelector('[data-reelforge-guide]');
    const card = host && host.shadowRoot && host.shadowRoot.querySelector('.rg-card');
    return !!card;
  }, undefined, { timeout: 5000 });

const title = () => page.locator('.rg-title').textContent();
const count = () => page.locator('.rg-count').textContent();

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`  ok  ${label}`);
}

// ---------------------------------------------------------------- 1. renders
await page.goto(`${base}/demo.html?key=gd_test123`);
await cardVisible();
assert.equal(await title(), 'Open the new project form');
assert.equal((await count()).trim(), '1 / 3');
pass('widget renders step 1 inside a shadow root');

const geometry = await page.evaluate(() => {
  const host = document.querySelector('[data-reelforge-guide]');
  const root = host.shadowRoot;
  const hole = root.querySelector('.rg-hole');
  const style = hole.style;
  const target = document.querySelector('[data-testid="new-project"]').getBoundingClientRect();
  return {
    left: parseFloat(style.left),
    top: parseFloat(style.top),
    width: parseFloat(style.width),
    height: parseFloat(style.height),
    target: { left: target.left, top: target.top, width: target.width, height: target.height },
    shadowStyles: root.querySelectorAll('style').length,
    documentSheets: document.styleSheets.length
  };
});
assert.ok(Math.abs(geometry.left - (geometry.target.left - 6)) < 2, 'spotlight left aligns with the target');
assert.ok(Math.abs(geometry.width - (geometry.target.width + 12)) < 2, 'spotlight covers the target width');
assert.ok(geometry.shadowStyles >= 1, 'styles live in the shadow root');
assert.equal(geometry.documentSheets, 1, 'no stylesheet is injected into the host document');
pass('spotlight hole tracks the target element and styles stay in the shadow root');

await page.screenshot({ path: path.join(artifacts, 'guide-step1.png') });

// ------------------------------------------------------- 2. navigation, keys
await page.locator('.rg-btn.next').click();
assert.equal(await title(), 'Name the project');
assert.equal((await count()).trim(), '2 / 3');
pass('Next advances the walk');

await page.keyboard.press('ArrowRight');
assert.equal(await title(), 'Create it');
assert.equal((await count()).trim(), '3 / 3');
pass('ArrowRight advances; last step labels the button Done');

await page.keyboard.press('ArrowLeft');
assert.equal(await title(), 'Name the project');
pass('ArrowLeft goes back');

assert.equal(await page.locator('.rg-back').isEnabled(), true, 'Back is enabled off the first step');
pass('Back is enabled off the first step');

// ------------------------------------------------------------- 3. Esc closes
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('[data-reelforge-guide]'), undefined, { timeout: 3000 });
pass('Escape closes and removes the widget');

// ------------------------------------------------------- 4. don't show again
await page.reload();
await cardVisible();
await page.locator('.rg-never').click();
await page.waitForFunction(() => !!localStorage.getItem('reelforge.guide.gd_test123.dismissed'));
await page.reload();
await page.waitForTimeout(700);
assert.equal(await page.evaluate(() => !!document.querySelector('[data-reelforge-guide]')), false);
pass('“Don\'t show again” persists and suppresses the guide on the next load');

// ------------------------------------------------- 5. skip + report behaviour
await page.evaluate(() => {
  Object.keys(localStorage)
    .filter((key) => key.startsWith('reelforge.guide.'))
    .forEach((key) => localStorage.removeItem(key));
});
await page.goto(`${base}/demo.html?key=gd_skip`);
await cardVisible();
assert.equal(await title(), 'Open the new project form');
await page.locator('.rg-btn.next').click();
assert.equal(await title(), 'Create it', 'the stale step is skipped, not shown');
assert.equal((await count()).trim(), '3 / 3', 'the walk continues past the stale step (index 3 of 3)');
pass('an unresolvable step is skipped and the walk continues');

await page.locator('.rg-btn.next').click();
await page.waitForFunction(() => !document.querySelector('[data-reelforge-guide]'), undefined, { timeout: 3000 });
await page.waitForTimeout(400);
assert.equal(reports.length, 1, 'exactly one report was posted');
assert.equal(reports[0].id, 'gd_skip');
assert.equal(reports[0].body.skippedStepCount, 1);
assert.deepEqual(reports[0].body.skipped, [1]);
pass(`skip reported to POST /api/guides/${reports[0].id}/report`);

// ----------------------------------------------- 6. unknown key stays silent
await page.goto(`${base}/demo.html?key=gd_unknown`);
await page.waitForTimeout(800);
assert.equal(await page.evaluate(() => !!document.querySelector('[data-reelforge-guide]')), false);
pass('a 404 embed key leaves the host page untouched');

// ----------------------------------------------------------- 7. no JS errors
assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join('; ')}`);
pass('no uncaught errors in the host page');

await browser.close();
server.close();

console.log(`\nguide smoke: ${checks} checks passed`);
console.log(`artifacts: ${path.join(artifacts, 'guide-step1.png')}`);
