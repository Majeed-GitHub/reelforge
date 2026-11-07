/**
 * Programmatic proof that the injected overlay is real, idempotent, survives
 * navigation, and lands in the recorded pixels.
 *
 *   node packages/agent/scripts/verify-overlay.ts
 *
 * Images cannot be eyeballed from CI, so every claim is checked twice:
 *   - in the DOM (host count, pointer transform, ripple node, focus styles)
 *   - in the pixels (a clipped screenshot of the pointer area changes after
 *     the mouse moves, and the click area changes on mousedown)
 */

import { chromium } from 'playwright';

import { CURSOR_INIT_SCRIPT } from '../src/injected.ts';
import { BASE_URL, resetDemoSite, startDemoSite, stopDemoSite, sleep } from './demo.ts';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const child = await startDemoSite();
  try {
    await resetDemoSite();

    const browser = await chromium.launch({ headless: true, args: ['--hide-scrollbars', '--mute-audio'] });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      await context.addInitScript({ content: CURSOR_INIT_SCRIPT });
      const page = await context.newPage();
      await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});

      console.log('\n[overlay] installation');
      const installed = await page.evaluate(() => Boolean((window as { __reelforgeCursorInstalled?: boolean }).__reelforgeCursorInstalled));
      const firstHosts = await page.evaluate(() => document.querySelectorAll('#__reelforge_cursor_host').length);
      check('init script ran in the page', installed === true);
      check('exactly one overlay host', firstHosts === 1, `${firstHosts} host(s)`);

      const stylePresent = await page.evaluate(() => Boolean(document.getElementById('__reelforge_cursor_style')));
      check('overlay stylesheet injected', stylePresent);

      console.log('\n[overlay] pointer + captured pixels');
      const initialOpacity = await page.evaluate(() => {
        const pointer = document.querySelector<HTMLElement>('#__reelforge_cursor_host .rf-pointer');
        return pointer ? getComputedStyle(pointer).opacity : null;
      });
      check('pointer starts hidden (no stray dot before any motion)', initialOpacity === '0', `opacity=${String(initialOpacity)}`);

      const clip = { x: 360, y: 260, width: 80, height: 80 };
      const before = await page.screenshot({ clip });
      await page.mouse.move(400, 300, { steps: 8 });
      await sleep(300); // let the 46ms transform transition settle
      const after = await page.screenshot({ clip });
      check('pointer is baked into the pixels (clipped screenshot changes)', before.equals(after) === false);

      const pointerState = await page.evaluate(() => {
        const pointer = document.querySelector<HTMLElement>('#__reelforge_cursor_host .rf-pointer');
        if (!pointer) return null;
        return { transform: pointer.style.transform, opacity: getComputedStyle(pointer).opacity };
      });
      check('pointer follows the mouse', /translate3d\(39[0-9.]+px,\s*29[0-9.]+px/.test(pointerState?.transform ?? ''), String(pointerState?.transform));
      check('pointer is visible after motion', pointerState?.opacity === '1', `opacity=${String(pointerState?.opacity)}`);

      console.log('\n[overlay] click ripple');
      const clipRipple = { x: 380, y: 280, width: 60, height: 60 };
      await page.mouse.move(410, 310, { steps: 4 });
      await sleep(120);
      const beforeClick = await page.screenshot({ clip: clipRipple });
      await page.mouse.down();
      const ripplesDuring = await page.evaluate(
        () => document.querySelectorAll('#__reelforge_cursor_host .rf-ripple').length
      );
      await sleep(120);
      const duringClick = await page.screenshot({ clip: clipRipple });
      await page.mouse.up();
      check('mousedown spawns a ripple', ripplesDuring >= 1, `${ripplesDuring} ripple node(s)`);
      check('ripple is visible in the pixels', beforeClick.equals(duringClick) === false);
      await sleep(1000);
      const ripplesAfter = await page.evaluate(
        () => document.querySelectorAll('#__reelforge_cursor_host .rf-ripple').length
      );
      check('ripple cleans itself up', ripplesAfter === 0, `${ripplesAfter} left behind`);

      console.log('\n[overlay] focus ring');
      await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('[data-testid="email"]');
        input?.focus();
      });
      const ring = await page.evaluate(() => {
        const input = document.querySelector<HTMLElement>('[data-testid="email"]');
        if (!input) return null;
        const style = getComputedStyle(input);
        return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor };
      });
      check('focused input gets the soft ring', ring?.style === 'solid' && ring?.width === '2px', JSON.stringify(ring));
      check('ring uses the accent colour', /rgba\(91,\s*140,\s*255/.test(ring?.color ?? ''), String(ring?.color));

      console.log('\n[overlay] navigation survival + idempotency');
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      const afterNav = await page.evaluate(() => ({
        installed: Boolean((window as { __reelforgeCursorInstalled?: boolean }).__reelforgeCursorInstalled),
        hosts: document.querySelectorAll('#__reelforge_cursor_host').length,
        styles: document.querySelectorAll('#__reelforge_cursor_style').length
      }));
      check('overlay re-installed on the new document', afterNav.installed === true && afterNav.hosts === 1, JSON.stringify(afterNav));
      check('stylesheet is not duplicated', afterNav.styles === 1, `${afterNav.styles} style tag(s)`);

      await page.addScriptTag({ content: CURSOR_INIT_SCRIPT });
      const afterReinject = await page.evaluate(() => document.querySelectorAll('#__reelforge_cursor_host').length);
      check('re-injection in the same document is a no-op', afterReinject === 1, `${afterReinject} host(s)`);

      await context.close();
    } finally {
      await browser.close();
    }

    if (failures > 0) {
      console.error(`\nOVERLAY FAIL: ${failures} check(s) failed`);
      process.exitCode = 1;
      return;
    }
    console.log('\nOVERLAY PASS: cursor, ripple and focus ring are real, idempotent and in the pixels');
  } finally {
    await stopDemoSite(child);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
