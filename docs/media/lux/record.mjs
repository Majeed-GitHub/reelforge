/**
 * Record and encode the luxury promo.
 *
 *   node docs/media/lux/audio/build-audio.mjs   # narration + sfx + mix (once)
 *   node docs/media/lux/record.mjs              # renders 16:9, 9:16 and 1:1
 *
 * The composition is played in headless Chromium at the target resolution and
 * captured, then muxed with the pre-mixed audio and normalised. Vertical and
 * square versions reuse the same soundtrack, so they stay in sync.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const media = path.resolve(here, '..');
const audioMix = path.join(here, 'audio', 'mix.wav');
const workDir = path.join(here, '.work');

const mediaTools = await import('../../../packages/render/src/ffmpeg.ts');
const FFMPEG = mediaTools.ffmpegPath();
const FFPROBE = mediaTools.ffprobePath();

if (!fs.existsSync(audioMix)) {
  console.error('Missing docs/media/lux/audio/mix.wav — run:\n  node docs/media/lux/audio/build-audio.mjs');
  process.exit(1);
}

const DURATION = 30;
const LEAD_TRIM = Number(process.env.LUX_LEAD_TRIM ?? 0.35);

const FORMATS = [
  { id: '16x9', width: 1920, height: 1080, out: 'reelforge-promo-lux.mp4' },
  { id: '9x16', width: 1080, height: 1920, out: 'reelforge-promo-lux-9x16.mp4' },
  { id: '1x1', width: 1080, height: 1080, out: 'reelforge-promo-lux-1x1.mp4' }
];

function run(bin, args, label) {
  const result = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    console.error(`\n✖ ${label}\n${(result.stderr || '').slice(-2000)}`);
    process.exit(1);
  }
  return result;
}

function probe(file) {
  const out = run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,codec_type,width,height,avg_frame_rate', '-of', 'json', file], `probe ${path.basename(file)}`).stdout;
  return JSON.parse(out);
}

function lumaAt(file, seconds) {
  const out = spawnSync(
    FFMPEG,
    ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 }
  );
  const buf = out.stdout;
  if (!buf || buf.length === 0) return 0;
  let sum = 0;
  for (const value of buf) sum += value;
  return sum / buf.length;
}

fs.mkdirSync(workDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];

for (const format of FORMATS) {
  const recordDir = path.join(workDir, format.id);
  fs.rmSync(recordDir, { recursive: true, force: true });
  fs.mkdirSync(recordDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: format.width, height: format.height },
    deviceScaleFactor: 1,
    recordVideo: { dir: recordDir, size: { width: format.width, height: format.height } }
  });
  const page = await context.newPage();
  const url = `file://${path.join(here, 'composition.html').replace(/\\/g, '/')}?format=${format.id}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.fonts && document.fonts.status === 'loaded', null, { timeout: 15000 }).catch(() => {});
  // The composition starts itself once fonts settle; give it the full run plus a tail.
  await page.waitForTimeout((DURATION + 0.9) * 1000);

  const videoPath = await page.video().path();
  await context.close();

  const rawWebm = path.join(recordDir, 'raw.webm');
  fs.copyFileSync(videoPath, rawWebm);

  const outFile = path.join(media, format.out);
  run(
    FFMPEG,
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(LEAD_TRIM), '-i', rawWebm,
      '-i', audioMix,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '19',
      '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-t', String(DURATION),
      '-movflags', '+faststart',
      outFile
    ],
    `encode ${format.id}`
  );

  const poster = path.join(media, `${format.out.replace(/\.mp4$/, '')}-poster.jpg`);
  run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '2.6', '-i', outFile, '-frames:v', '1', '-q:v', '3', poster], `poster ${format.id}`);

  const info = probe(outFile);
  const videoStream = info.streams.find((s) => s.codec_type === 'video');
  const audioStream = info.streams.find((s) => s.codec_type === 'audio');
  results.push({
    format: format.id,
    file: format.out,
    sizeMB: Number((Number(info.format.size) / 1024 / 1024).toFixed(2)),
    duration: Number(Number(info.format.duration).toFixed(2)),
    resolution: `${videoStream.width}x${videoStream.height}`,
    codec: videoStream.codec_name,
    audio: audioStream ? `${audioStream.codec_name} 48k` : 'MISSING',
    luma: [1.2, 6.0, 11.0, 16.5, 22.0, 27.5].map((t) => Number(lumaAt(outFile, t).toFixed(1))),
    poster
  });
}

await browser.close();

/* ------------------------------------------------------------------ report */
let failed = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

console.log('\n=== deliverables ===');
for (const r of results) {
  console.log(
    `  ${r.file.padEnd(34)} ${r.resolution.padEnd(10)} ${String(r.duration).padStart(6)}s  ${String(r.sizeMB).padStart(5)} MB  ${r.audio}`
  );
}

console.log('\n=== checks ===');
for (const r of results) {
  const [w, h] = r.resolution.split('x').map(Number);
  const expected = FORMATS.find((f) => f.id === r.format);
  check(w === expected.width && h === expected.height, `${r.format} resolution`, r.resolution);
  check(Math.abs(r.duration - DURATION) <= 1.2, `${r.format} duration`, `${r.duration}s vs ${DURATION}s`);
  check(r.codec === 'h264', `${r.format} codec`, r.codec);
  check(r.audio.startsWith('aac'), `${r.format} has audio`, r.audio);
  check(r.sizeMB < 12, `${r.format} size < 12 MB`, `${r.sizeMB} MB`);
  check(r.luma.every((l) => l > 2 && l < 250), `${r.format} frames are neither black nor blown out`, r.luma.join(', '));
  check(r.luma[1] < r.luma[3], `${r.format} has a visible brightness arc`, `${r.luma[1]} → ${r.luma[3]}`);
}

// End card must actually show the repo URL. Measure the element's real box in
// the composition at that timestamp, then sample exactly that region of the
// finished frame — guessing a crop band is how this check lied to me before.
{
  const frameTime = 27.6;
  const masterFile = results[0].file;
  const probeBrowser = await chromium.launch({ headless: true });
  const probePage = await probeBrowser.newPage({ viewport: { width: 1920, height: 1080 } });
  await probePage.goto(`file://${path.join(here, 'composition.html').replace(/\\/g, '/')}?t=${frameTime}`, { waitUntil: 'load' });
  await probePage.waitForTimeout(400);
  const box = await probePage.locator('.end-url').boundingBox();
  const boxOpacity = await probePage.locator('.end-url').evaluate((el) => getComputedStyle(el).opacity);
  await probeBrowser.close();

  check(Boolean(box), 'end card URL element is laid out', box ? `${Math.round(box.width)}x${Math.round(box.height)} @ ${Math.round(box.x)},${Math.round(box.y)}` : 'missing');
  if (box) {
    const endFrame = path.join(workDir, 'endframe.png');
    run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(frameTime), '-i', path.join(media, masterFile), '-frames:v', '1', endFrame], 'end frame');
    const pad = 6;
    const x = Math.max(0, Math.round(box.x) - pad);
    const y = Math.max(0, Math.round(box.y) - pad);
    const w = Math.round(box.width) + pad * 2;
    const h = Math.round(box.height) + pad * 2;
    const probe = spawnSync(
      FFMPEG,
      ['-v', 'error', '-i', endFrame, '-vf', `crop=${w}:${h}:${x}:${y},format=gray`, '-f', 'rawvideo', '-'],
      { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }
    );
    const pixels = probe.stdout ?? Buffer.alloc(0);
    let bright = 0;
    for (const value of pixels) if (value > 140) bright += 1;
    const ratio = pixels.length ? bright / pixels.length : 0;
    check(Number(boxOpacity) > 0.9, 'end card URL is fully faded in', `opacity ${boxOpacity}`);
    check(ratio > 0.05, 'end card renders the repository URL', `${(ratio * 100).toFixed(1)}% bright pixels inside the measured URL box`);
  } else {
    check(false, 'end card renders the repository URL', 'element box unavailable');
  }
}

console.log(`\n${failed === 0 ? 'PROMO PASS' : 'PROMO FAIL'} — ${results.length * 7 + 1} checks, ${failed} failed`);
if (failed > 0) process.exit(1);
