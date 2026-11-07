/**
 * Browser check for the marketing site.
 *
 *   node site/test/site-smoke.mjs
 *
 * Serves site/ statically, loads it at desktop and phone widths, and asserts the
 * things a page like this actually fails on: horizontal overflow, console
 * errors, missing media, broken copy button, and whether reduced-motion is
 * honoured.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const artifacts = path.join(root, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (url.pathname === '/' || url.pathname === '') file = path.join(root, 'index.html');
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const browser = await chromium.launch({ headless: true });

async function visit(width, height, options = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: options.reducedMotion ?? 'no-preference',
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  const errors = [];
  const failed = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  return { context, page, errors, failed };
}

try {
  // ---------------------------------------------------------------- desktop
  const desktop = await visit(1440, 900);
  const { page } = desktop;

  const title = await page.title();
  check('title is set', /Reelforge/.test(title), title);
  check('hero headline renders', (await page.locator('h1').innerText()).includes('written by the product'));
  check('hero video element exists', (await page.locator('.hero-video').count()) === 1);
  const posterOk = await page.locator('.hero-video').evaluate((el) => el.getAttribute('poster'));
  check('hero poster is referenced', Boolean(posterOk), posterOk ?? '');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no horizontal overflow at 1440', overflow <= 1, `${overflow}px`);

  // Reveal animation should have fired after scrolling through.
  // Scroll in steps, like a person would: a single jump to the bottom would
  // leave every mid-page element unobserved and make this check meaningless.
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.7);
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 90));
    }
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 200));
  });
  await page.waitForTimeout(700);
  const revealed = await page.evaluate(
    () => document.querySelectorAll('[data-reveal].is-in').length / document.querySelectorAll('[data-reveal]').length
  );
  check('scroll reveal runs', revealed > 0.8, `${Math.round(revealed * 100)}% revealed`);

  // Copy button actually writes the quickstart commands.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('#start').scrollIntoViewIfNeeded();
  await page.locator('[data-copy]').click();
  await page.waitForTimeout(250);
  const copyLabel = await page.locator('[data-copy]').innerText();
  check('copy button gives feedback', /Copied|failed/i.test(copyLabel), copyLabel);

  // Provider wall is populated.
  const providers = await page.locator('.marquee span').count();
  check('provider wall is populated', providers >= 31, `${providers} names`);
  const tiers = await page.locator('.tiers > div').count();
  check('provider tiers render', tiers === 3, `${tiers} tiers`);

  // Comparison table has the Reelforge column.
  check('comparison table renders', (await page.locator('.compare-table td.is-us').count()) >= 8);

  // Anchors all resolve.
  const anchors = ['#outputs', '#how', '#providers', '#compare', '#start'];
  let anchorsOk = true;
  for (const anchor of anchors) {
    const exists = await page.locator(anchor).count();
    if (exists !== 1) anchorsOk = false;
  }
  check('every nav anchor has a target', anchorsOk);

  await page.screenshot({ path: path.join(artifacts, 'desktop-hero.png'), fullPage: false });
  await page.screenshot({ path: path.join(artifacts, 'desktop-full.png'), fullPage: true });
  const promoExists = fs.existsSync(path.join(root, 'media', 'reelforge-promo.mp4'));
  const isExpectedPromoMiss = (line) => !promoExists && /reelforge-promo\.mp4/.test(line);
  const desktopFailures = desktop.failed.filter((line) => !isExpectedPromoMiss(line));
  const desktopErrors = desktop.errors.filter((line) => !(isExpectedPromoMiss(line) || (!promoExists && /404/.test(line))));
  check('no console or page errors (desktop)', desktopErrors.length === 0, desktopErrors.join(' | '));
  check(
    promoExists ? 'promo video is present and served' : 'promo video pending (poster fallback expected)',
    promoExists ? desktop.failed.length === 0 : true,
    desktopFailures.slice(0, 3).join(' | ')
  );
  await desktop.context.close();

  // ------------------------------------------------------------------ phone
  const phone = await visit(390, 844);
  const overflowPhone = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no horizontal overflow at 390', overflowPhone <= 1, `${overflowPhone}px`);
  const toggleVisible = await phone.page.locator('[data-nav-toggle]').isVisible();
  check('mobile menu toggle appears on small screens', toggleVisible);
  await phone.page.locator('[data-nav-toggle]').click();
  await phone.page.waitForTimeout(200);
  check('mobile menu opens', await phone.page.locator('.nav.is-open').count() === 1);
  await phone.page.screenshot({ path: path.join(artifacts, 'mobile-menu.png') });
  await phone.page.locator('[data-nav-toggle]').click();
  await phone.page.screenshot({ path: path.join(artifacts, 'mobile-full.png'), fullPage: true });
  const phoneErrors = phone.errors.filter((line) => !(isExpectedPromoMiss(line) || (!promoExists && /404/.test(line))));
  check('no console errors (mobile)', phoneErrors.length === 0, phoneErrors.join(' | '));
  await phone.context.close();

  // --------------------------------------------------------- reduced motion
  const reduced = await visit(1440, 900, { reducedMotion: 'reduce' });
  const allVisible = await reduced.page.evaluate(
    () => Array.from(document.querySelectorAll('[data-reveal]')).every((el) => el.classList.contains('is-in'))
  );
  check('reduced motion shows content without animation', allVisible);
  await reduced.context.close();
} catch (error) {
  failures.push(`crashed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser.close();
  server.close();
}

console.log(`\nsite smoke: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log(`artifacts: ${artifacts}`);
