/** Finds which element causes horizontal overflow at a given width. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  let file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (file.endsWith(path.sep) || req.url === '/') file = path.join(root, 'index.html');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true });
for (const width of [390, 1440]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const report = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const offenders = [];
    const scrollAncestor = (el) => {
      let node = el.parentElement;
      while (node) {
        const ox = getComputedStyle(node).overflowX;
        if (ox !== 'visible') return node;
        node = node.parentElement;
      }
      return null;
    };
    document.querySelectorAll('*').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return;
      if (scrollAncestor(el)) return;
      if (rect.right > vw + 1 || rect.left < -1) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 40),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          overflowX: getComputedStyle(el).overflowX
        });
      }
    });
    return { vw, scrollWidth: document.documentElement.scrollWidth, offenders: offenders.slice(0, 14) };
  });
  console.log(`\n=== width ${width} === scrollWidth ${report.scrollWidth} clientWidth ${report.vw}`);
  for (const o of report.offenders) console.log(`  ${o.tag}.${o.cls} left=${o.left} right=${o.right} w=${o.width} overflow-x=${o.overflowX}`);
  await page.close();
}
await browser.close();
server.close();
