#!/usr/bin/env node
/**
 * Social-format promo cuts + lightweight 720p hero.
 *
 *   node docs/media/promo/record-social.mjs
 *
 * One command records and encodes:
 *   reelforge-story-9x16.mp4   1080x1920  18s  < 4 MB   (IG story / WhatsApp status)
 *   reelforge-post-1x1.mp4     1080x1080  18s  < 4 MB   (IG feed post)
 *   reelforge-feed-4x5.mp4     1080x1350  18s  < 4 MB   (IG feed 4:5)
 *   reelforge-promo-720p.mp4   1280x720   ~30s < 900 KB (site hero, from the 16:9 master)
 *
 * Each social variant gets a poster JPG and three review frames. The recorder
 * also asserts: exact dimensions, duration, size budget, H.264/yuv420p/AAC,
 * no external network requests, no page errors, the end card contains the repo
 * URL (DOM + rendered pixels) and all key text sits inside the safe area.
 *
 * Options: --fps 30 | --silent | --keep
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
const TMP_DIR = path.join(HERE, '.tmp-social');
const FRAMES_ROOT = path.join(HERE, 'frames');
const REPO_URL = 'github.com/Majeed-GitHub/reelforge';
const MASTER_16x9 = path.join(MEDIA_DIR, 'reelforge-promo.mp4');
const HERO_720P = path.join(MEDIA_DIR, 'reelforge-promo-720p.mp4');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1 || index === argv.length - 1) return fallback;
  return argv[index + 1];
}
const FPS = Math.max(15, Math.min(60, Number(option('fps', '30')) || 30));
const SILENT = flag('silent');
const KEEP = flag('keep');

const DURATION = 18; // seconds, keep in sync with social.js
const SOCIAL_MAX_BYTES = 4 * 1024 * 1024;
const HERO_MAX_BYTES = 900 * 1024;
const FRAME_TIMES = [1.5, 8.6, 15.5];
const SAFE_PROBE_TIMES = [1.5, 3.6, 8.6, 11.5, 15.5];
const POSTER_AT = 8.6;

const VARIANTS = [
  {
    key: 'story',
    html: 'promo-story.html',
    label: 'story 9:16',
    out: 'reelforge-story-9x16.mp4',
    poster: 'reelforge-story-9x16-poster.jpg',
    width: 1080,
    height: 1920,
    safeTop: 250,
    safeBottom: 250
  },
  {
    key: 'post',
    html: 'promo-square.html',
    label: 'post 1:1',
    out: 'reelforge-post-1x1.mp4',
    poster: 'reelforge-post-1x1-poster.jpg',
    width: 1080,
    height: 1080,
    safeTop: 64,
    safeBottom: 64
  },
  {
    key: 'feed',
    html: 'promo-4x5.html',
    label: 'feed 4:5',
    out: 'reelforge-feed-4x5.mp4',
    poster: 'reelforge-feed-4x5-poster.jpg',
    width: 1080,
    height: 1350,
    safeTop: 80,
    safeBottom: 80
  }
];

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
async function grayStats(file, region = {}) {
  const { x = 0, y = 0, w = 1080, h = 1080, frameWidth = 1080, frameHeight = 1080 } = region;
  const rawPath = path.join(TMP_DIR, 'gray.raw');
  await ff([
    '-i', file, '-frames:v', '1',
    '-vf', `scale=${frameWidth}:${frameHeight}:flags=area,format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', rawPath
  ]);
  const buf = fs.readFileSync(rawPath);
  let sum = 0, count = 0, min = 255, max = 0, bright = 0;
  const x1 = Math.min(frameWidth, x + w);
  const y1 = Math.min(frameHeight, y + h);
  for (let yy = Math.max(0, y); yy < y1; yy += 2) {
    for (let xx = Math.max(0, x); xx < x1; xx += 2) {
      const value = buf[yy * frameWidth + xx];
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

// ---- audio bed (generated, no licence) --------------------------------------
async function makeToneBed(filePath, seconds) {
  await ff([
    '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${seconds + 2}`,
    '-f', 'lavfi', '-i', `sine=frequency=329.63:sample_rate=48000:duration=${seconds + 2}`,
    '-filter_complex',
    '[1:a]volume=0.25[b];[0:a][b]amix=inputs=2:normalize=0,volume=0.45,' +
      'tremolo=f=0.1:d=0.65,afade=t=in:st=0:d=1.5[a]',
    '-map', '[a]', '-c:a', 'pcm_s16le', filePath
  ]);
}

// ---- browser-side probes ----------------------------------------------------
const SAFE_SELECTORS = [
  '#brand',
  '#scene-hook .line',
  '#typed',
  '#chip',
  '#cards .card',
  '#providersHeadline',
  '#providersSub',
  '#mwrap',
  '#endhead',
  '#endurl',
  '#endbio'
];

async function inspect(page, timeSeconds) {
  return page.evaluate((selectors) => {
    const effectiveOpacity = (node) => {
      let opacity = 1;
      for (let current = node; current && current !== document.documentElement; current = current.parentElement) {
        opacity *= Number(getComputedStyle(current).opacity);
      }
      return opacity;
    };
    const boxes = [];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (effectiveOpacity(node) < 0.15) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        boxes.push({
          selector,
          text: (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
          x: rect.x, y: rect.y, w: rect.width, h: rect.height,
          opacity: effectiveOpacity(node)
        });
      }
    }
    const url = document.querySelector('#endurl');
    const stage = document.getElementById('stage').getBoundingClientRect();
    return {
      t: Number(document.body.dataset.t),
      stage: { w: stage.width, h: stage.height },
      boxes,
      url: url
        ? {
            text: (url.textContent || '').trim().replace(/\s+/g, ' '),
            opacity: effectiveOpacity(url),
            box: (() => { const r = url.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()
          }
        : null,
      meta: window.__promo
    };
  }, SAFE_SELECTORS);
}

async function main() {
  const t0 = Date.now();
  console.log('Reelforge social cuts recorder');
  console.log(`  composition dir  ${HERE}`);
  console.log(`  outputs          ${MEDIA_DIR}`);
  console.log(`  ffmpeg           ${ffmpegPath}`);
  console.log(`  formats          story 1080x1920 · post 1080x1080 · feed 1080x1350 @ ${FPS}fps, ${DURATION}s`);
  console.log('');

  for (const variant of VARIANTS) {
    const htmlPath = path.join(HERE, variant.html);
    if (!fs.existsSync(htmlPath)) throw new Error(`missing composition: ${htmlPath}`);
  }
  if (!fs.existsSync(MASTER_16x9)) {
    throw new Error(`missing 16:9 master for the 720p cut: ${MASTER_16x9} (run record.mjs first)`);
  }

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const bedPath = path.join(TMP_DIR, 'bed.wav');
  if (!SILENT) await makeToneBed(bedPath, DURATION);

  const browser = await chromium.launch({
    headless: true,
    args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--disable-lcd-text']
  });

  let externalRequests = 0;
  const results = [];

  for (const [index, variant] of VARIANTS.entries()) {
    const tag = `[${index + 1}/${VARIANTS.length}] ${variant.label}`;
    console.log(`${tag} — recording ${variant.width}x${variant.height} ...`);
    const contextWall = Date.now();
    const context = await browser.newContext({
      viewport: { width: variant.width, height: variant.height },
      deviceScaleFactor: 1,
      recordVideo: { dir: TMP_DIR, size: { width: variant.width, height: variant.height } }
    });
    const page = await context.newPage();
    const pageErrors = [];
    let variantExternal = 0;
    page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    page.on('request', (request) => {
      if (/^https?:/i.test(request.url())) {
        variantExternal += 1;
        externalRequests += 1;
      }
    });

    const fileUrl = pathToFileURL(path.join(HERE, variant.html)).href;
    await page.goto(fileUrl, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true', null, { timeout: 15_000 });
    const meta = await page.evaluate(() => window.__promo);
    check(
      `${variant.key}: composition meta (${variant.width}x${variant.height}, ${DURATION}s)`,
      meta && meta.width === variant.width && meta.height === variant.height && meta.duration === DURATION,
      JSON.stringify(meta)
    );
    const stageBox = await page.evaluate(() => {
      const stage = document.getElementById('stage');
      return { w: stage.offsetWidth, h: stage.offsetHeight, scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight };
    });
    check(
      `${variant.key}: stage is exactly ${variant.width}x${variant.height} with no scroll`,
      stageBox.w === variant.width && stageBox.h === variant.height &&
        stageBox.scrollW === variant.width && stageBox.scrollH === variant.height,
      `${stageBox.w}x${stageBox.h} (scroll ${stageBox.scrollW}x${stageBox.scrollH})`
    );

    const video = page.video();
    await page.evaluate(() => window.__start && window.__start());
    const startedWall = Date.now();
    const leadIn = Math.max(0, Math.min(1.5, (startedWall - contextWall) / 1000 - 0.12));
    await page.waitForTimeout(DURATION * 1000 + 900);

    // Storyboard probes through ?t= seek (safe areas + end-card URL).
    const probes = [];
    for (const time of SAFE_PROBE_TIMES) {
      await page.goto(`${fileUrl}?t=${time}`, { waitUntil: 'load' });
      await page.waitForFunction('window.__ready === true', null, { timeout: 15_000 });
      probes.push(await inspect(page, time));
    }

    const minTop = Math.min(...probes.flatMap((probe) => probe.boxes.map((box) => box.y)));
    const maxBottom = Math.max(...probes.flatMap((probe) => probe.boxes.map((box) => box.y + box.h)));
    const safeOk = minTop >= variant.safeTop - 1 && maxBottom <= variant.height - variant.safeBottom + 1;
    check(
      variant.key === 'story'
        ? `${variant.key}: key text inside the 250px safe area`
        : `${variant.key}: key text inside its safe band (${variant.safeTop}px)`,
      safeOk,
      `content y ${minTop.toFixed(0)}..${maxBottom.toFixed(0)} vs safe ${variant.safeTop}..${variant.height - variant.safeBottom} (${probes.length} seek points)`
    );

    const endProbe = probes[probes.length - 1];
    const endUrlBox = endProbe.url ? {
      x: Math.floor(endProbe.url.box.x),
      y: Math.floor(endProbe.url.box.y),
      w: Math.ceil(endProbe.url.box.w),
      h: Math.ceil(endProbe.url.box.h)
    } : null;
    const urlVisible = Boolean(
      endProbe.url &&
        endProbe.url.text.includes(REPO_URL) &&
        endProbe.url.opacity > 0.5 &&
        endProbe.url.box.x >= 0 &&
        endProbe.url.box.y >= 0 &&
        endProbe.url.box.x + endProbe.url.box.w <= variant.width + 1 &&
        endProbe.url.box.y + endProbe.url.box.h <= variant.height + 1
    );
    check(
      `${variant.key}: end card contains the repo URL on-screen`,
      urlVisible,
      endProbe.url ? `${endProbe.url.text} @ opacity ${endProbe.url.opacity.toFixed(2)}` : 'missing #endurl'
    );
    check(
      `${variant.key}: no external network requests / no page errors`,
      variantExternal === 0 && pageErrors.length === 0,
      `${variantExternal} http(s) requests, ${pageErrors.length} errors${pageErrors.length ? `: ${pageErrors.slice(0, 2).join(' | ')}` : ''}`
    );

    // ---- stop recording ----
    await page.close();
    await context.close();
    const rawVideo = video ? await video.path() : null;
    if (!rawVideo || !fs.existsSync(rawVideo)) throw new Error(`${variant.key}: Playwright produced no video`);
    console.log(`      raw capture ${humanBytes(fs.statSync(rawVideo).size)} (lead-in ${leadIn.toFixed(2)}s trimmed)`);

    // ---- encode under the 4 MB budget ----
    const outPath = path.join(MEDIA_DIR, variant.out);
    const encodeAttempts = [23, 25, 27, 29];
    let picked = null;
    let encodedBytes = 0;
    for (const crf of encodeAttempts) {
      await ff([
        ...(leadIn > 0.01 ? ['-ss', leadIn.toFixed(3)] : []),
        '-i', rawVideo,
        ...(SILENT ? [] : ['-i', bedPath]),
        '-filter_complex',
        `[0:v]fps=${FPS},scale=${variant.width}:${variant.height}:flags=lanczos,setsar=1,format=yuv420p[v]` +
          (SILENT ? '' : ';[1:a]atrim=0:' + DURATION + ',afade=t=out:st=' + (DURATION - 2.5) + ':d=2.5,asetpts=PTS-STARTPTS[a]'),
        '-map', '[v]',
        ...(SILENT ? ['-an'] : ['-map', '[a]', '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2']),
        '-t', String(DURATION),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-profile:v', 'high', '-level', '4.2',
        '-pix_fmt', 'yuv420p', '-g', String(FPS * 2),
        '-movflags', '+faststart',
        outPath
      ]);
      encodedBytes = fs.statSync(outPath).size;
      picked = crf;
      console.log(`      encoded crf ${crf} → ${humanBytes(encodedBytes)}`);
      if (encodedBytes < SOCIAL_MAX_BYTES) break;
    }

    // ---- poster + 3 frames ----
    const variantFrames = path.join(FRAMES_ROOT, variant.key);
    fs.rmSync(variantFrames, { recursive: true, force: true });
    fs.mkdirSync(variantFrames, { recursive: true });
    const posterPath = path.join(MEDIA_DIR, variant.poster);
    await ff(['-ss', String(POSTER_AT), '-i', outPath, '-frames:v', '1', '-q:v', '2', posterPath]);
    for (let i = 0; i < FRAME_TIMES.length; i++) {
      const framePath = path.join(variantFrames, `frame-${String(i + 1).padStart(2, '0')}.jpg`);
      await ff(['-ss', String(FRAME_TIMES[i]), '-i', outPath, '-frames:v', '1', '-q:v', '3', framePath]);
    }

    // ---- verify ----
    const probe = await ffprobeJson(outPath);
    const videoStream = (probe.streams || []).find((stream) => stream.codec_type === 'video');
    const audioStream = (probe.streams || []).find((stream) => stream.codec_type === 'audio');
    const fileDuration = Number(probe.format?.duration ?? 0);
    check(
      `${variant.key}: dimensions + codecs`,
      videoStream && videoStream.width === variant.width && videoStream.height === variant.height &&
        videoStream.codec_name === 'h264' && videoStream.pix_fmt === 'yuv420p',
      videoStream ? `${videoStream.width}x${videoStream.height} ${videoStream.codec_name}/${videoStream.pix_fmt}` : 'no video'
    );
    check(
      `${variant.key}: duration ${DURATION}s ±1s`,
      Math.abs(fileDuration - DURATION) <= 1,
      `${fileDuration.toFixed(3)}s`
    );
    check(
      `${variant.key}: under 4 MB`,
      encodedBytes < SOCIAL_MAX_BYTES,
      `${humanBytes(encodedBytes)} (crf ${picked})`
    );
    check(
      `${variant.key}: audio stream present`,
      SILENT ? true : Boolean(audioStream) && audioStream.codec_name === 'aac',
      SILENT ? 'skipped (--silent)' : audioStream ? `${audioStream.codec_name} ${audioStream.sample_rate}Hz` : 'missing'
    );
    const posterStats = await grayStats(posterPath, {
      frameWidth: variant.width, frameHeight: variant.height
    });
    check(
      `${variant.key}: poster is a rendered frame`,
      fs.existsSync(posterPath) && fs.statSync(posterPath).size > 8_000 && posterStats.avg > 8 && posterStats.max > 200,
      `avg luma ${posterStats.avg.toFixed(1)}, max ${posterStats.max}`
    );
    const framesOk = FRAME_TIMES.every((_, i) => {
      const framePath = path.join(variantFrames, `frame-${String(i + 1).padStart(2, '0')}.jpg`);
      return fs.existsSync(framePath) && fs.statSync(framePath).size > 4_000;
    });
    check(`${variant.key}: 3 review frames extracted`, framesOk, `${FRAME_TIMES.length}/3`);
    if (endUrlBox) {
      const endFrameStats = await grayStats(path.join(variantFrames, 'frame-03.jpg'), {
        ...endUrlBox,
        frameWidth: variant.width,
        frameHeight: variant.height
      });
      check(
        `${variant.key}: end card frame renders the URL text`,
        endFrameStats.brightPct > 1,
        `${endFrameStats.brightPct.toFixed(2)}% bright pixels in the URL box (${JSON.stringify(endUrlBox)})`
      );
    }

    results.push({
      key: variant.key,
      label: variant.label,
      file: path.basename(outPath),
      width: variant.width,
      height: variant.height,
      duration: fileDuration,
      bytes: encodedBytes,
      crf: picked,
      poster: path.basename(posterPath),
      checks: checks.length
    });
    console.log('');
  }

  await browser.close();

  // ---- lightweight 720p hero from the 16:9 master --------------------------
  console.log('[4/4] lightweight 720p hero from reelforge-promo.mp4 ...');
  const sourceProbe = await ffprobeJson(MASTER_16x9);
  check(
    '720p: 16:9 master readable',
    Boolean((sourceProbe.streams || []).find((stream) => stream.codec_type === 'video')),
    `${Number(sourceProbe.format?.duration ?? 0).toFixed(2)}s master`
  );
  let heroAttempt = null;
  let heroBytes = 0;
  for (const crf of [26, 28, 30, 32]) {
    await ff([
      '-i', MASTER_16x9,
      '-vf', 'scale=1280:720:flags=lanczos,setsar=1,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-profile:v', 'high', '-level', '3.1',
      '-pix_fmt', 'yuv420p', '-g', String(FPS * 2),
      '-c:a', 'aac', '-b:a', '48k', '-ac', '1', '-ar', '48000',
      '-movflags', '+faststart',
      HERO_720P
    ]);
    heroBytes = fs.statSync(HERO_720P).size;
    heroAttempt = crf;
    console.log(`      encoded crf ${crf} → ${humanBytes(heroBytes)}`);
    if (heroBytes < HERO_MAX_BYTES) break;
  }
  const heroProbe = await ffprobeJson(HERO_720P);
  const heroVideo = (heroProbe.streams || []).find((stream) => stream.codec_type === 'video');
  const heroAudio = (heroProbe.streams || []).find((stream) => stream.codec_type === 'audio');
  const heroDuration = Number(heroProbe.format?.duration ?? 0);
  check(
    '720p: 1280x720 h264 yuv420p',
    heroVideo && heroVideo.width === 1280 && heroVideo.height === 720 &&
      heroVideo.codec_name === 'h264' && heroVideo.pix_fmt === 'yuv420p',
    heroVideo ? `${heroVideo.width}x${heroVideo.height} ${heroVideo.codec_name}/${heroVideo.pix_fmt}` : 'no video'
  );
  check('720p: duration ~30s', Math.abs(heroDuration - 30) <= 1, `${heroDuration.toFixed(3)}s`);
  check('720p: under 900 KB', heroBytes < HERO_MAX_BYTES, `${humanBytes(heroBytes)} (crf ${heroAttempt})`);
  check(
    '720p: audio preserved (mono 48 kHz)',
    Boolean(heroAudio) && heroAudio.codec_name === 'aac' && Number(heroAudio.sample_rate) === 48000,
    heroAudio ? `${heroAudio.codec_name} ${heroAudio.sample_rate}Hz ${heroAudio.channels}ch` : 'missing'
  );
  if (!SILENT) {
    const mean = await meanVolumeDb(HERO_720P);
    check('720p: tone bed still audible', mean > -45 && mean < -18, `mean_volume ${mean} dB`);
  }

  // ---- summary --------------------------------------------------------------
  console.log('');
  console.log('| variant | file | dimensions | duration | bytes |');
  console.log('|---|---|---|---|---|');
  for (const entry of results) {
    console.log(
      `| ${entry.label} | \`${entry.file}\` | ${entry.width}x${entry.height} | ${entry.duration.toFixed(2)}s | ` +
        `${entry.bytes} (${humanBytes(entry.bytes)}) |`
    );
  }
  console.log(
    `| hero 720p | \`${path.basename(HERO_720P)}\` | 1280x720 | ${heroDuration.toFixed(2)}s | ` +
      `${heroBytes} (${humanBytes(heroBytes)}) |`
  );
  console.log('');
  console.log(`external http(s) requests across all compositions: ${externalRequests}`);

  if (!KEEP) fs.rmSync(TMP_DIR, { recursive: true, force: true });
  const failed = checks.filter((entry) => !entry.ok);
  if (failed.length === 0) {
    console.log(`SOCIAL RECORD PASS — ${checks.length}/${checks.length} checks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(0);
  }
  console.log(`SOCIAL RECORD FAIL — ${failed.length}/${checks.length} checks failed:`);
  for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail}`);
  process.exit(1);
}

main().catch((error) => {
  console.error('SOCIAL RECORD FAIL — unhandled error');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
