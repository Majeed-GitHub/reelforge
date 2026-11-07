/**
 * Build the embeddable guide widget.
 *
 *   node packages/guide/build.mjs
 *
 * Emits packages/guide/dist/guide.js (IIFE, minified, es2020) plus a copy of
 * demo.html so the API can serve both from /g/. Fails the build if the bundle
 * stops fitting the advertised budget (< 6 KB gzip).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'dist');
const outFile = path.join(outDir, 'guide.js');
const GZIP_BUDGET_BYTES = 6 * 1024;

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const started = Date.now();

await build({
  entryPoints: [path.join(here, 'src', 'guide.ts')],
  outfile: outFile,
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  platform: 'browser',
  charset: 'utf8',
  legalComments: 'none',
  banner: {
    js: '/*! Reelforge in-app guide — self-hosted Director. Embed with <script src="…/g/guide.js" data-guide="embed_key" async></script> */'
  }
});

const demoSource = path.join(here, 'demo.html');
if (fs.existsSync(demoSource)) fs.copyFileSync(demoSource, path.join(outDir, 'demo.html'));

const raw = fs.readFileSync(outFile);
const gzip = zlib.gzipSync(raw, { level: 9 });
const brotli = zlib.brotliCompressSync(raw);

const kb = (bytes) => `${(bytes / 1024).toFixed(2)} KB`;
const overBudget = gzip.length > GZIP_BUDGET_BYTES;

console.log('');
console.log('reelforge guide widget');
console.log(`  entry    packages/guide/src/guide.ts`);
console.log(`  output   packages/guide/dist/guide.js`);
console.log(`  raw      ${kb(raw.length)} (${raw.length} bytes)`);
console.log(`  gzip     ${kb(gzip.length)} (${gzip.length} bytes)`);
console.log(`  brotli   ${kb(brotli.length)} (${brotli.length} bytes)`);
console.log(`  budget   ${kb(GZIP_BUDGET_BYTES)} gzip — ${overBudget ? 'OVER' : 'ok'}`);
console.log(`  built in ${Date.now() - started}ms`);
console.log('');

if (overBudget) {
  console.error(`Guide bundle exceeds the gzip budget: ${kb(gzip.length)} > ${kb(GZIP_BUDGET_BYTES)}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(outDir, 'demo.html'))) {
  console.warn('demo.html was not copied — the manual test harness will 404 at /g/demo.html');
}
