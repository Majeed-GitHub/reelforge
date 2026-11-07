#!/usr/bin/env node
/**
 * Reelforge promo recorder — "video as code".
 *
 * Renders docs/media/promo/promo.html in real Chromium at 1920x1080, records it
 * with Playwright's video capture, then encodes the final MP4 with the bundled
 * ffmpeg (h264 + yuv420p + faststart), extracts the poster JPG and 8 storyboard
 * frames, and verifies everything with ffprobe.
 *
 * Usage:
 *   node docs/media/promo/record.mjs [--fps 30] [--silent] [--keep]
 *
 *   --fps 30     output frame rate (default 30)
 *   --silent     skip the generated tone bed (the composition itself is silent)
 *   --keep       keep the raw Playwright .webm in docs/media/promo/.tmp/
 *
 * Requires the root dependencies (`playwright`, `ffmpeg-static`, `ffprobe-static`)
 * and an installed Chromium for Playwright. No network and no external assets:
 * the composition is one self-contained HTML file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const run = promisify(execFile);

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

const HERE = import.meta.dirname; // docs/media/promo
const MEDIA_DIR = path.resolve(HERE, '..'); // docs/media
const PROMO_HTML = path.join(HERE, 'promo.html');
const TMP_DIR = path.join(HERE, '.tmp');
const FRAMES_DIR = path.join(HERE, 'frames');
const MP4_PATH = path.join(MEDIA_DIR, 'reelforge-promo.mp4');
const POSTER_PATH = path.join(MEDIA_DIR, 'reelforge-promo-poster.jpg');
const DURATION = 30; // seconds, keep in sync with promo.html
const TARGET_W = 1920;
const TARGET_H = 1080;
const MAX_BYTES = 10 * 1024 * 1024;
const REPO_URL = 'github.com/Majeed-GitHub/reelforge';
const FRAME_TIMES = [0.6, 3.9, 7.4, 10.9, 14.2, 17.8, 22.9, 28.4];

// ---- tiny CLI ---------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(`--${name}`); }
function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1 || index === argv.length - 1) return fallback;
  return argv[index + 1];
}
const FPS = Math.max(15, Math.min(60, Number(option('fps', '30')) || 30));
const SILENT = flag('silent');
const KEEP = flag('keep');

// ---- reporting --------------------------------------------------------------
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function humanBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
function ff(args, opts = {}) {
  return run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    maxBuffer: 64 * 1024 * 1024,
    ...opts
  });
}
async function ffprobeJson(file) {
  const { stdout } = await run(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { maxBuffer: 16 * 1024 * 1024 }
  );
  return JSON.parse(stdout);
}

/** Decode one frame to grey and measure a region (used to prove text is drawn). */
async function grayStats(file, region = {}) {
  const { x = 0, y = 0, w = TARGET_W, h = TARGET_H } = region;
  const rawPath = path.join(TMP_DIR, 'gray.raw');
  await ff(['-i', file, '-frames:v', '1', '-vf', `scale=${TARGET_W}:${TARGET_H}:flags=area,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', rawPath]);
  const buf = fs.readFileSync(rawPath);
  let sum = 0, count = 0, min = 255, max = 0, bright = 0;
  const x1 = Math.min(TARGET_W, x + w);
  const y1 = Math.min(TARGET_H, y + h);
  for (let yy = Math.max(0, y); yy < y1; yy += 2) {
    for (let xx = Math.max(0, x); xx < x1; xx += 2) {
      const value = buf[yy * TARGET_W + xx];
      sum += value; count++;
      if (value < min) min = value;
      if (value > max) max = value;
      if (value > 120) bright++;
    }
  }
  return { avg: sum / Math.max(1, count), min, max, brightPct: (100 * bright) / Math.max(1, count) };
}

async function meanVolumeDb(file) {
  const { stderr } = await run(
    ffmpegPath,
    ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    { maxBuffer: 8 * 1024 * 1024 }
  );
  const match = /mean_volume:\s*(-?[0-9.]+)\s*dB/.exec(stderr || '');
  return match ? Number(match[1]) : -999;
}

// ---- main -------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  console.log('Reelforge promo recorder');
  console.log(`  composition  ${PROMO_HTML}`);
  console.log(`  output       ${MP4_PATH}`);
  console.log(`  ffmpeg       ${ffmpegPath}`);
  console.log(`  format       ${TARGET_W}x${TARGET_H} @ ${FPS}fps, ${DURATION}s target`);
  console.log('');

  if (!fs.existsSync(PROMO_HTML)) throw new Error(`missing composition: ${PROMO_HTML}`);
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  // ---- 1. record ------------------------------------------------------------
  console.log('[1/6] recording 1920x1080 composition with Playwright Chromium ...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--disable-lcd-text']
  });
  const contextWall = Date.now();
  const context = await browser.newContext({
    viewport: { width: TARGET_W, height: TARGET_H },
    deviceScaleFactor: 1,
    recordVideo: { dir: TMP_DIR, size: { width: TARGET_W, height: TARGET_H } }
  });
  const page = await context.newPage();
  const pageErrors = [];
  const networkRequests = [];
  page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  page.on('request', (request) => {
    const url = request.url();
    if (/^https?:/i.test(url)) networkRequests.push(url);
  });

  const fileUrl = pathToFileURL(PROMO_HTML).href;
  await page.goto(fileUrl, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', null, { timeout: 15_000 });
  const composition = await page.evaluate(() => window.__promo);
  check(
    'composition loaded (1920x1080 canvas, no external requests)',
    networkRequests.length === 0,
    networkRequests.length ? networkRequests.join(', ') : '0 http(s) requests'
  );
  const stageBox = await page.evaluate(() => {
    const stage = document.getElementById('stage');
    return { w: stage.offsetWidth, h: stage.offsetHeight, scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight };
  });
  check(
    'stage is exactly 1920x1080 with no page scroll',
    stageBox.w === TARGET_W && stageBox.h === TARGET_H && stageBox.scrollW === TARGET_W && stageBox.scrollH === TARGET_H,
    `${stageBox.w}x${stageBox.h} (scroll ${stageBox.scrollW}x${stageBox.scrollH})`
  );

  const video = page.video();
  await page.evaluate(() => window.__start && window.__start());
  const startedWall = Date.now();
  // recordVideo starts at context creation; the composition starts at __start().
  // Trim that lead-in (minus a small safety margin) so t=0 of the MP4 is the
  // composition's t=0 rather than browser startup.
  const leadIn = Math.max(0, Math.min(1.5, (startedWall - contextWall) / 1000 - 0.12));
  console.log(`      playing ${DURATION}s timeline (lead-in ${leadIn.toFixed(2)}s will be trimmed) ...`);
  await page.waitForTimeout(DURATION * 1000 + 900);
  const recordedAt = await page.evaluate(() => document.body.dataset.t ?? '0');
  console.log(`      timeline reached t=${recordedAt}s`);

  // ---- 2. content assertions (seeking is a first-class feature) ------------
  console.log('[2/6] checking storyboard content via ?t= seek ...');
  async function inspectAt(t) {
    await page.goto(`${fileUrl}?t=${t}`, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true', null, { timeout: 15_000 });
    return page.evaluate(() => {
      const effectiveOpacity = (node) => {
        let opacity = 1;
        for (let current = node; current && current !== document.documentElement; current = current.parentElement) {
          opacity *= Number(getComputedStyle(current).opacity);
        }
        return opacity;
      };
      const visible = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return { exists: false, opacity: 0, text: '', box: null };
        const rect = node.getBoundingClientRect();
        return {
          exists: true,
          opacity: effectiveOpacity(node),
          text: (node.textContent || '').trim().replace(/\s+/g, ' '),
          box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
        };
      };
      const stage = document.getElementById('stage').getBoundingClientRect();
      return {
        t: document.body.dataset.t,
        wordmark: visible('#wordmark'),
        instruction: visible('#instruction'),
        cards: [...document.querySelectorAll('.card')].filter((card) => effectiveOpacity(card) > 0.5).length,
        act4Head: visible('#a4head'),
        providerRows: [...document.querySelectorAll('.track span')].slice(0, 6).map((s) => s.textContent),
        redactTransform: getComputedStyle(document.getElementById('redact')).transform,
        endurl: visible('#endurl'),
        cmds: visible('#cmds'),
        stage: { w: stage.width, h: stage.height }
      };
    });
  }

  const s1 = await inspectAt(1.3);
  check(
    'act 1: wordmark visible',
    s1.wordmark.exists && s1.wordmark.opacity > 0.5 && s1.wordmark.box.w > 600,
    `opacity ${s1.wordmark.opacity}, width ${Math.round(s1.wordmark.box.w)}px`
  );
  const s2 = await inspectAt(5.9);
  check(
    'act 2: instruction + URL chip visible',
    s2.instruction.text.includes('Sign in') && s2.instruction.text.includes('teammate.') && s2.instruction.opacity > 0.4,
    s2.instruction.text
  );
  const s3 = await inspectAt(13.6);
  check('act 3: four output cards fanned out', s3.cards === 4, `${s3.cards}/4 cards above 0.5 opacity`);
  const s4 = await inspectAt(18.0);
  check(
    'act 4: provider wall streaming',
    s4.act4Head.opacity > 0.5 && s4.providerRows.length > 0,
    `${s4.providerRows.length} names sampled (${s4.providerRows.slice(0, 3).join(', ')} …)`
  );
  const s5 = await inspectAt(23.1);
  check(
    'act 5: redaction box covers the field',
    /matrix\(([0-9.]+)/.exec(s5.redactTransform)?.[1] > 0.8,
    `redact transform ${s5.redactTransform}`
  );
  const s6 = await inspectAt(28.4);
  const endUrlBox = s6.endurl.box ? { x: Math.floor(s6.endurl.box.x), y: Math.floor(s6.endurl.box.y), w: Math.ceil(s6.endurl.box.w), h: Math.ceil(s6.endurl.box.h) } : null;
  const urlVisible = s6.endurl.exists && s6.endurl.opacity > 0.5 && s6.endurl.text.includes(REPO_URL);
  const urlInFrame = s6.endurl.box && s6.endurl.box.x >= 0 && s6.endurl.box.y >= 0 &&
    s6.endurl.box.x + s6.endurl.box.w <= s6.stage.w && s6.endurl.box.y + s6.endurl.box.h <= s6.stage.h;
  check(
    'end card contains the repo URL and is on-screen at 28.4s',
    urlVisible && urlInFrame,
    `${s6.endurl.text} @ opacity ${s6.endurl.opacity}`
  );
  check(
    'end card: commands visible',
    s6.cmds.exists && s6.cmds.text.includes('npm run dev'),
    s6.cmds.text.slice(0, 80)
  );
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'clean console');

  // ---- 3. close + grab the raw video --------------------------------------
  console.log('[3/6] finishing Playwright recording ...');
  await page.close();
  await context.close();
  await browser.close();
  const videoPath = video ? await video.path() : null;
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error('Playwright did not produce a recorded .webm');
  }
  console.log(`      raw capture ${path.basename(videoPath)} (${humanBytes(fs.statSync(videoPath).size)})`);

  // ---- 4. encode: tone bed + h264 ----------------------------------------
  console.log('[4/6] encoding with bundled ffmpeg ...');
  let audioPath = null;
  if (!SILENT) {
    audioPath = path.join(TMP_DIR, 'bed.wav');
    // Generated bed only — two sines, slow tremolo, fades. Nothing licensed.
    // 220 Hz + 329.63 Hz stays audible on a phone speaker while sitting far
    // under the (empty) voice track.
    await ff([
      '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=32',
      '-f', 'lavfi', '-i', 'sine=frequency=329.63:sample_rate=48000:duration=32',
      '-filter_complex',
      '[1:a]volume=0.25[b];[0:a][b]amix=inputs=2:normalize=0,volume=0.45,' +
        'tremolo=f=0.1:d=0.65,afade=t=in:st=0:d=2,afade=t=out:st=27:d=3[a]',
      '-map', '[a]', '-c:a', 'pcm_s16le', audioPath
    ]);
  }

  const encodeArgs = [
    ...(leadIn > 0.01 ? ['-ss', leadIn.toFixed(3)] : []),
    '-i', videoPath,
    ...(audioPath ? ['-i', audioPath] : []),
    '-filter_complex',
    `[0:v]fps=${FPS},scale=${TARGET_W}:${TARGET_H}:flags=lanczos,setsar=1,format=yuv420p[v]` +
      (audioPath ? ';[1:a]atrim=start=0:duration=' + DURATION + ',asetpts=PTS-STARTPTS[a]' : ''),
    '-map', '[v]',
    ...(audioPath ? ['-map', '[a]'] : []),
    '-t', String(DURATION),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-profile:v', 'high', '-level', '4.1',
    '-pix_fmt', 'yuv420p', '-g', String(FPS * 2),
    ...(audioPath ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'] : ['-an']),
    '-movflags', '+faststart',
    MP4_PATH
  ];
  const started = Date.now();
  await ff(encodeArgs);
  console.log(`      encoded in ${((Date.now() - started) / 1000).toFixed(1)}s → ${humanBytes(fs.statSync(MP4_PATH).size)}`);

  // ---- 5. poster + frames -------------------------------------------------
  console.log('[5/6] extracting poster and storyboard frames ...');
  await ff(['-ss', '2.4', '-i', MP4_PATH, '-frames:v', '1', '-q:v', '2', POSTER_PATH]);
  for (let i = 0; i < FRAME_TIMES.length; i++) {
    const file = path.join(FRAMES_DIR, `frame-${String(i + 1).padStart(2, '0')}.jpg`);
    await ff(['-ss', String(FRAME_TIMES[i]), '-i', MP4_PATH, '-frames:v', '1', '-q:v', '3', file]);
  }
  console.log(`      poster + ${FRAME_TIMES.length} frames (${FRAME_TIMES.map((t) => `${t}s`).join(', ')})`);

  // ---- 6. verify ----------------------------------------------------------
  console.log('[6/6] verifying with ffprobe ...');
  const probe = await ffprobeJson(MP4_PATH);
  const videoStream = (probe.streams || []).find((stream) => stream.codec_type === 'video');
  const audioStream = (probe.streams || []).find((stream) => stream.codec_type === 'audio');
  const duration = Number(probe.format?.duration ?? 0);
  const size = fs.statSync(MP4_PATH).size;

  console.log('--- ffprobe ------------------------------------------------------');
  console.log(JSON.stringify({
    file: path.relative(process.cwd(), MP4_PATH).split(path.sep).join('/'),
    duration,
    size,
    video: videoStream ? {
      codec: videoStream.codec_name,
      width: videoStream.width,
      height: videoStream.height,
      pix_fmt: videoStream.pix_fmt,
      fps: videoStream.avg_frame_rate
    } : null,
    audio: audioStream ? {
      codec: audioStream.codec_name,
      sample_rate: audioStream.sample_rate,
      channels: audioStream.channels
    } : null
  }, null, 2));
  console.log('------------------------------------------------------------------');

  check('duration within ±1s of 30s', Math.abs(duration - DURATION) <= 1.0, `${duration.toFixed(3)}s`);
  check(
    '1920x1080 h264 yuv420p',
    videoStream && videoStream.width === TARGET_W && videoStream.height === TARGET_H &&
      videoStream.codec_name === 'h264' && videoStream.pix_fmt === 'yuv420p',
    videoStream ? `${videoStream.width}x${videoStream.height} ${videoStream.codec_name}/${videoStream.pix_fmt}` : 'no video stream'
  );
  check(
    'audio stream present',
    SILENT ? true : Boolean(audioStream) && audioStream.codec_name === 'aac',
    SILENT ? 'skipped (--silent)' : audioStream ? `${audioStream.codec_name} ${audioStream.sample_rate}Hz` : 'missing'
  );
  check('file under 10 MB', size < MAX_BYTES, humanBytes(size));
  check('poster JPG written', fs.existsSync(POSTER_PATH) && fs.statSync(POSTER_PATH).size > 8_000, humanBytes(fs.existsSync(POSTER_PATH) ? fs.statSync(POSTER_PATH).size : 0));

  const frames = fs.readdirSync(FRAMES_DIR).filter((name) => /^frame-\d+\.jpg$/.test(name));
  const framesSane = frames.length === FRAME_TIMES.length && frames.every((name) => fs.statSync(path.join(FRAMES_DIR, name)).size > 5_000);
  check('8 storyboard frames extracted', framesSane, `${frames.length}/8 frames`);
  check('composition metadata', composition && composition.duration === DURATION, JSON.stringify(composition));

  // Prove the poster and the end-card frame actually contain rendered content
  // (a silent black frame would still pass ffprobe, so measure pixels).
  const posterStats = await grayStats(POSTER_PATH);
  check(
    'poster is a rendered frame (not blank)',
    posterStats.avg > 8 && posterStats.max > 200,
    `avg luma ${posterStats.avg.toFixed(1)}, max ${posterStats.max}`
  );
  if (endUrlBox) {
    const endCardStats = await grayStats(path.join(FRAMES_DIR, 'frame-08.jpg'), endUrlBox);
    check(
      'end card frame contains the repo URL text',
      endCardStats.brightPct > 1,
      `${endCardStats.brightPct.toFixed(2)}% bright pixels in the URL box (${JSON.stringify(endUrlBox)})`
    );
  }
  if (!SILENT) {
    const bedVolume = await meanVolumeDb(MP4_PATH);
    check('tone bed is audible but subtle', bedVolume > -45 && bedVolume < -18, `mean_volume ${bedVolume} dB`);
  }

  // ---- summary ------------------------------------------------------------
  const failed = checks.filter((entry) => !entry.ok);
  console.log('');
  if (!KEEP) fs.rmSync(TMP_DIR, { recursive: true, force: true });
  if (failed.length === 0) {
    console.log(`PROMO RECORD PASS — ${checks.length}/${checks.length} checks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`  video   ${MP4_PATH}`);
    console.log(`  poster  ${POSTER_PATH}`);
    console.log(`  frames  ${FRAMES_DIR}`);
    process.exit(0);
  }
  console.log(`PROMO RECORD FAIL — ${failed.length}/${checks.length} checks failed:`);
  for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail}`);
  process.exit(1);
}

main().catch((error) => {
  console.error('PROMO RECORD FAIL — unhandled error');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
