/**
 * End-to-end self-test for the Reelforge render stage.
 *
 *   node packages/render/test/render-selftest.ts
 *
 * Covers v0.1/v0.2 render output and the v0.3 additions:
 *   1. cross-platform narration providers (describeTtsProviders + real synth)
 *   2. aspect ratios: 16:9 unchanged, 9:16 = 1080x1920, 1:1 square, with a
 *      non-black blurred background at the edges
 *   3. music bed: audible extra audio stream; missing file = warning, no crash
 *   4. redactions: blur inside the step window only, merged across contiguous
 *      identical boxes, never bridging a gap
 *
 * Exits 0 only when every check passes; prints PASS/FAIL lines, ffprobe JSON
 * evidence and a machine-readable summary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ROOT } from '../../core/src/config.ts';
import type { CaptureResult, StepRecord } from '../../core/src/types.ts';
import { ffmpegPath, ffprobePath, probeMedia, runFfmpeg, runFfprobe, tailOutput , hasFilter } from '../src/ffmpeg.ts';
import { renderDemo } from '../src/index.ts';
import { describeTtsProviders, resolveTtsProvider } from '../src/tts.ts';
import { resolveAspectLayout } from '../src/aspect.ts';
import { buildZoomTimeline, cameraStateAt } from '../src/zoom.ts';
import { planRedactionWindows } from '../src/redactions.ts';
import { mapViewportRectThroughCamera } from '../src/redactions.ts';

const OUT_DIR = path.join(PATHS.exports, 'selftest');
const SOURCE_WEBM = path.join(OUT_DIR, 'capture.webm');
const OUTPUT_MP4 = path.join(OUT_DIR, 'selftest-demo.mp4');
const SCALE_HEIGHT = 720;
const VIEWPORT = { width: 1280, height: 720 };

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

function fixtureSteps(): StepRecord[] {
  return [
    {
      index: 0,
      kind: 'goto',
      narration: 'Welcome to the Reelforge self-test demo.',
      startedAtMs: 0,
      endedAtMs: 1400,
      url: 'https://example.test/',
      box: { x: 40, y: 24, width: 520, height: 64 },
      point: { x: 300, y: 56 },
      reason: 'open the landing page'
    },
    {
      index: 1,
      kind: 'click',
      narration: 'Click the Create project button in the top right corner.',
      startedAtMs: 1500,
      endedAtMs: 3200,
      selector: '#create-project',
      role: 'button',
      accessibleName: 'Create project',
      box: { x: 900, y: 40, width: 260, height: 64 },
      point: { x: 1030, y: 72 },
      screenshotPath: path.join(OUT_DIR, 'step-2.png')
    },
    {
      index: 2,
      kind: 'type',
      narration: 'Type a name for the project and confirm.',
      startedAtMs: 3400,
      endedAtMs: 5200,
      selector: '#project-name',
      role: 'textbox',
      accessibleName: 'Project name',
      box: { x: 120, y: 260, width: 520, height: 48 },
      point: { x: 300, y: 284 },
      value: 'Self-test project',
      screenshotPath: path.join(OUT_DIR, 'step-3.png')
    },
    {
      index: 3,
      kind: 'click',
      narration: 'The project is created and ready for actions.',
      startedAtMs: 5400,
      endedAtMs: 7200,
      selector: '[data-testid="primary-action"]',
      role: 'button',
      accessibleName: 'Start recording',
      box: { x: 620, y: 560, width: 220, height: 56 },
      point: { x: 730, y: 588 },
      screenshotPath: path.join(OUT_DIR, 'step-4.png')
    }
  ];
}

function buildCapture(steps: StepRecord[], videoPath: string = SOURCE_WEBM): CaptureResult {
  const now = Date.now();
  return {
    steps,
    viewport: VIEWPORT,
    videoPath,
    startedAtEpochMs: now - 8000,
    endedAtEpochMs: now,
    goalMet: true,
    finalUrl: 'https://example.test/projects',
    log: []
  };
}

async function generateSyntheticWebm(): Promise<void> {
  // A synthetic capture that stays colourful across the whole frame (so the
  // blurred social background is measurably non-black at the edges) and keeps
  // high-frequency detail (so the redaction blur visibly changes pixels):
  // testsrc2 screened over a dark blue base colour.
  const res = await runFfmpeg(
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30:duration=8',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x2c4157:size=1280x720:rate=30:duration=8',
      '-filter_complex',
      '[1:v][0:v]blend=all_mode=screen:shortest=1,format=yuv420p',
      '-c:v',
      'libvpx',
      '-b:v',
      '2000k',
      '-pix_fmt',
      'yuv420p',
      SOURCE_WEBM
    ],
    { timeoutMs: 180_000 }
  );
  if (res.code !== 0 || !fs.existsSync(SOURCE_WEBM)) {
    throw new Error(`could not generate the synthetic WebM: ${tailOutput(res.stderr, 1500)}`);
  }
}

// ---------------------------------------------------------------------------
// ffmpeg analysis helpers
// ---------------------------------------------------------------------------

async function cornerYAvg(file: string, corner: 'tl' | 'tr' | 'bl' | 'br', atMs = 2000): Promise<number> {
  const crop = {
    tl: 'crop=24:24:0:0',
    tr: 'crop=24:24:iw-24:0',
    bl: 'crop=24:24:0:ih-24',
    br: 'crop=24:24:iw-24:ih-24'
  }[corner];
  const res = await runFfmpeg(
    [
      '-hide_banner',
      '-loglevel',
      'info',
      '-ss',
      (atMs / 1000).toFixed(3),
      '-i',
      file,
      '-vf',
      `${crop},signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
      '-frames:v',
      '1',
      '-f',
      'null',
      '-'
    ],
    { timeoutMs: 60_000 }
  );
  const match = /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(res.stderr);
  return match ? Number(match[1]) : -1;
}

async function meanVolumeDb(file: string): Promise<number> {
  const res = await runFfmpeg(
    ['-hide_banner', '-loglevel', 'info', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    { timeoutMs: 120_000 }
  );
  const match = /mean_volume:\s*(-?[0-9.]+)\s*dB/.exec(res.stderr);
  return match ? Number(match[1]) : -999;
}

/** Mean luma of the absolute difference between two frames inside a crop. */
async function frameDiffYAvg(fileA: string, fileB: string, atMs: number, crop: string): Promise<number> {
  const seek = (atMs / 1000).toFixed(3);
  const res = await runFfmpeg(
    [
      '-hide_banner',
      '-loglevel',
      'info',
      '-ss',
      seek,
      '-i',
      fileA,
      '-ss',
      seek,
      '-i',
      fileB,
      '-filter_complex',
      `[0:v][1:v]blend=all_mode=difference,${crop},signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
      '-frames:v',
      '1',
      '-f',
      'null',
      '-'
    ],
    { timeoutMs: 60_000 }
  );
  const match = /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(res.stderr);
  return match ? Number(match[1]) : -1;
}

async function generateTone(filePath: string, durationSec: number, frequency = 440): Promise<void> {
  const res = await runFfmpeg(
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${frequency}:duration=${durationSec}`,
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      filePath
    ],
    { timeoutMs: 60_000 }
  );
  if (res.code !== 0 || !fs.existsSync(filePath)) {
    throw new Error(`could not generate the music fixture: ${tailOutput(res.stderr, 1200)}`);
  }
}

type RenderCase = {
  result: Awaited<ReturnType<typeof renderDemo>>;
  probe: Awaited<ReturnType<typeof probeMedia>>;
};

async function renderCase(outName: string, options: Record<string, unknown>, steps: StepRecord[] = fixtureSteps()): Promise<RenderCase> {
  const result = await renderDemo({
    capture: buildCapture(steps),
    steps,
    outDir: OUT_DIR,
    outputPath: path.join(OUT_DIR, outName),
    options: options as never
  });
  const probe = await probeMedia(result.videoPath);
  for (const warning of result.warnings) console.log(`      warning: ${warning}`);
  return { result, probe };
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log('Reelforge render self-test');
  console.log(`  node        ${process.version} (${process.platform}/${process.arch})`);
  console.log(`  ffmpeg      ${ffmpegPath()}`);
  console.log(`  ffprobe     ${ffprobePath()}`);
  console.log(`  workspace   ${ROOT}`);
  console.log(`  output dir  ${OUT_DIR}`);

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---- 0. Narration provider inventory -------------------------------------
  const providerInfo = await resolveTtsProvider(undefined, { workDir: path.join(OUT_DIR, 'tts') });
  const provider = providerInfo.provider;
  const nativeCoverage = await describeTtsProviders();
  console.log(`  tts         ${provider}${providerInfo.warnings.length ? ` (${providerInfo.warnings.join('; ')})` : ''}`);
  console.log('  tts coverage (native):');
  for (const info of nativeCoverage) {
    console.log(`      ${info.id.padEnd(11)} ${info.available ? 'yes' : 'no '}  ${info.reason}`);
  }
  console.log('');

  // ---- 1. Synthetic capture video ------------------------------------------
  console.log('[1/8] generating synthetic 8s 1280x720 WebM ...');
  await generateSyntheticWebm();
  const sourceProbe = await probeMedia(SOURCE_WEBM);
  console.log(
    `      capture.webm ${sourceProbe.width}x${sourceProbe.height} ${sourceProbe.durationMs}ms ` +
      `${(fs.statSync(SOURCE_WEBM).size / 1024).toFixed(0)}KiB`
  );
  check(
    'synthetic capture.webm generated',
    sourceProbe.durationMs >= 7500,
    `${sourceProbe.durationMs}ms, ${sourceProbe.width}x${sourceProbe.height}`
  );

  // ---- 2. Main narrated 16:9 render (regression) ---------------------------
  const steps = fixtureSteps();
  console.log('[2/8] rendering narrated 16:9 MP4 through renderDemo() ...');
  const mainCase = await renderCase('selftest-demo.mp4', {
    fps: 30,
    scaleHeight: SCALE_HEIGHT,
    watermark: true,
    watermarkText: 'Reelforge',
    language: 'en',
    zoom: 1.6
  });
  const result = mainCase.result;
  const probe = mainCase.probe;
  console.log(`      rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  check('renderDemo returned a result', Boolean(result), result.videoPath ?? '');
  check('finished MP4 exists', fs.existsSync(OUTPUT_MP4), OUTPUT_MP4);

  console.log('[3/8] probing the finished MP4 with ffprobe ...');
  const rawProbe = await runFfprobe([
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    OUTPUT_MP4
  ]);
  console.log('--- ffprobe JSON (16:9) ------------------------------------------');
  console.log(rawProbe.stdout.trim());
  console.log('------------------------------------------------------------------');

  const expectedWidth = Math.round((SCALE_HEIGHT * 16) / 9);
  check(
    '(a) 16:9 dimensions unchanged',
    probe.width === expectedWidth && probe.height === SCALE_HEIGHT,
    `${probe.width}x${probe.height} (expected ${expectedWidth}x${SCALE_HEIGHT})`
  );
  check('video stream present (h264)', probe.hasVideo && probe.videoCodec === 'h264', `codec=${probe.videoCodec}`);

  // A build that lacks a filter is a fact to report, not a failure. A build
  // that *has* the filter and falls back is a bug — that is exactly what CI
  // caught on Linux, where captions silently disappeared for a release.
  const caps = { captions: hasFilter('subtitles') || hasFilter('ass'), watermark: hasFilter('drawtext') };
  const captionFallbacks = result.warnings.filter((w) => /caption burn failed/i.test(w));
  const watermarkFallbacks = result.warnings.filter((w) => /watermark failed/i.test(w));
  check(
    caps.captions ? 'captions burned (build has libass)' : 'captions reported unavailable (build lacks libass)',
    caps.captions ? captionFallbacks.length === 0 : result.warnings.some((w) => /no libass/.test(w)),
    captionFallbacks.join(' | ') || result.warnings.filter((w) => /libass/.test(w)).join(' | ')
  );
  check(
    caps.watermark ? 'watermark drawn (build has drawtext)' : 'watermark reported unavailable (build lacks drawtext)',
    caps.watermark ? watermarkFallbacks.length === 0 : result.warnings.some((w) => /no drawtext/.test(w)),
    watermarkFallbacks.join(' | ') || result.warnings.filter((w) => /drawtext/.test(w)).join(' | ')
  );

  // The renderer tells us how long it intends the video to be; assert the file
  // matches that plan and is never shorter than the capture. This is
  // provider-independent: with narration the plan includes the voiceover, with
  // TTS=none it is just the capture length, and either way plan must equal file.
  const plannedDurationMs = Number.isFinite(result.durationMs) && result.durationMs > 0 ? result.durationMs : sourceProbe.durationMs;
  const durationOk =
    Math.abs(probe.durationMs - plannedDurationMs) <= 1200 && probe.durationMs >= sourceProbe.durationMs - 250;
  check(
    'duration within tolerance',
    durationOk,
    `file ${probe.durationMs}ms vs planned ${plannedDurationMs}ms, capture ${sourceProbe.durationMs}ms (tolerance 1200ms)`
  );

  if (provider !== 'none') {
    check('audio stream present (narration)', probe.hasAudio, `codec=${probe.audioCodec}, sampleRate=${probe.sampleRate}`);
    check(
      'narration lines carry audio paths',
      result.lines.length > 0 && result.lines.filter((line) => line.audioPath).length > 0,
      `${result.lines.filter((line) => line.audioPath).length}/${result.lines.length} lines`
    );
  } else {
    console.log('SKIP  narration audio assertions (no TTS provider available)');
  }

  check('file size is sane', probe.sizeBytes > 50_000, `${(probe.sizeBytes / 1024).toFixed(0)}KiB`);
  check('SRT file written', Boolean(result.srtPath && fs.existsSync(result.srtPath)), result.srtPath ?? 'missing');
  if (result.srtPath && fs.existsSync(result.srtPath)) {
    const srt = fs.readFileSync(result.srtPath, 'utf8');
    const blocks = srt.trim() ? srt.trim().split(/\n\n/).length : 0;
    check('SRT has one block per narration line', blocks === steps.length, `${blocks} blocks / ${steps.length} lines`);
  }
  const posterOk = Boolean(result.posterPath && fs.existsSync(result.posterPath) && fs.statSync(result.posterPath).size > 0);
  check('poster frame extracted', posterOk, result.posterPath ?? 'missing');

  // ---- 3. Aspect ratios ----------------------------------------------------
  console.log('[4/8] rendering social aspect ratios ...');
  const portrait = await renderCase('selftest-portrait-9x16.mp4', {
    fps: 30,
    scaleHeight: 1920,
    aspect: '9:16',
    watermark: true,
    watermarkText: 'Reelforge',
    language: 'en',
    voice: 'none',
    zoom: 1.6
  });
  check(
    '(b) 9:16 is 1080x1920',
    portrait.probe.width === 1080 && portrait.probe.height === 1920,
    `${portrait.probe.width}x${portrait.probe.height}`
  );
  const portraitCorners = {
    tl: await cornerYAvg(portrait.result.videoPath, 'tl'),
    tr: await cornerYAvg(portrait.result.videoPath, 'tr'),
    bl: await cornerYAvg(portrait.result.videoPath, 'bl'),
    br: await cornerYAvg(portrait.result.videoPath, 'br')
  };
  check(
    '(b) 9:16 blurred background is non-black at the edges',
    Object.values(portraitCorners).every((value) => value > 8),
    `corner YAVG ${JSON.stringify(portraitCorners)} (need > 8)`
  );

  const square = await renderCase('selftest-square-1x1.mp4', {
    fps: 30,
    scaleHeight: 480,
    aspect: '1:1',
    watermark: false,
    language: 'en',
    voice: 'none',
    zoom: 1.6
  });
  const squareCorners = {
    tl: await cornerYAvg(square.result.videoPath, 'tl'),
    br: await cornerYAvg(square.result.videoPath, 'br')
  };
  check(
    '(b) 1:1 produces a square',
    square.probe.width === square.probe.height && square.probe.width === 480,
    `${square.probe.width}x${square.probe.height}`
  );
  check(
    '(b) 1:1 blurred background is non-black at the edges',
    Object.values(squareCorners).every((value) => value > 8),
    `corner YAVG ${JSON.stringify(squareCorners)} (need > 8)`
  );

  // ---- 4. Music bed --------------------------------------------------------
  console.log('[5/8] rendering music bed + auto-duck ...');
  const musicPath = path.join(OUT_DIR, 'music-tone.mp3');
  await generateTone(musicPath, 3, 440);
  const musicOnly = await renderCase('selftest-music-only.mp4', {
    fps: 30,
    scaleHeight: 480,
    watermark: false,
    language: 'en',
    voice: 'none',
    zoom: 1.6,
    music: { path: musicPath, gain: 0.2, duck: true }
  });
  check(
    '(c) music adds an audio stream',
    musicOnly.probe.hasAudio,
    `codec=${musicOnly.probe.audioCodec}`
  );
  const musicOnlyVolume = await meanVolumeDb(musicOnly.result.videoPath);
  check(
    '(c) music is audible (not silence)',
    musicOnlyVolume > -50,
    `mean_volume ${musicOnlyVolume} dB (need > -50 dB)`
  );

  if (provider !== 'none') {
    const musicNarrated = await renderCase('selftest-music-narration.mp4', {
      fps: 30,
      scaleHeight: 480,
      watermark: false,
      language: 'en',
      zoom: 1.6,
      music: { path: musicPath, gain: 0.2, duck: true }
    });
    const narratedVolume = await meanVolumeDb(musicNarrated.result.videoPath);
    check(
      '(c) ducked music + narration mix renders',
      musicNarrated.probe.hasAudio && narratedVolume > -50,
      `codec=${musicNarrated.probe.audioCodec}, mean_volume ${narratedVolume} dB`
    );
  } else {
    console.log('SKIP  ducking mix assertion (no narration provider available)');
  }

  const missingMusic = await renderCase('selftest-music-missing.mp4', {
    fps: 30,
    scaleHeight: 480,
    watermark: false,
    language: 'en',
    voice: 'none',
    zoom: 1.6,
    music: { path: path.join(OUT_DIR, 'does-not-exist', 'track.mp3') }
  });
  check(
    '(c) missing music file warns and still renders',
    fs.existsSync(missingMusic.result.videoPath) &&
      missingMusic.probe.hasVideo &&
      missingMusic.result.warnings.some((warning) => /^music:/.test(warning)),
    missingMusic.result.warnings.find((warning) => /^music:/.test(warning)) ?? 'no music warning'
  );

  // ---- 5. Redactions -------------------------------------------------------
  console.log('[6/8] rendering redaction blur ...');
  // Lossless encodes make the "nothing outside the box" pixel comparison exact:
  // with CRF 0 the only difference between the two renders is the blur itself.
  const previousCrf = process.env.REELFORGE_FFMPEG_CRF;
  process.env.REELFORGE_FFMPEG_CRF = '0';
  const redactionBox = { x: 100, y: 100, width: 220, height: 120, stepIndex: 0 };
  const baseOptions = { fps: 30, scaleHeight: 480, watermark: false, language: 'en', voice: 'none', zoom: 1.6 };
  const redactionBase = await renderCase('selftest-redaction-base.mp4', baseOptions);
  const redactionOn = await renderCase('selftest-redaction-on.mp4', { ...baseOptions, redactions: [redactionBox] });
  if (previousCrf === undefined) delete process.env.REELFORGE_FFMPEG_CRF;
  else process.env.REELFORGE_FFMPEG_CRF = previousCrf;

  const layout = resolveAspectLayout('16:9', 480);
  const keyframes = buildZoomTimeline(steps, VIEWPORT, { strength: 1.6 });
  const camera = cameraStateAt(keyframes, 700);
  const mapped = mapViewportRectThroughCamera(
    { x: redactionBox.x, y: redactionBox.y, width: redactionBox.width, height: redactionBox.height },
    VIEWPORT,
    layout,
    camera
  );
  const cropX = Math.max(0, Math.round(mapped.x + 6));
  const cropY = Math.max(0, Math.round(mapped.y + 6));
  const cropW = Math.max(8, Math.round(mapped.width - 12));
  const cropH = Math.max(8, Math.round(mapped.height - 12));
  const boxCrop = `crop=${cropW}:${cropH}:${cropX}:${cropY}`;
  const insideDiff = await frameDiffYAvg(redactionBase.result.videoPath, redactionOn.result.videoPath, 700, boxCrop);
  const cornerDiff = await frameDiffYAvg(
    redactionBase.result.videoPath,
    redactionOn.result.videoPath,
    700,
    'crop=32:32:iw-32:ih-32'
  );
  const outsideDiff = await frameDiffYAvg(redactionBase.result.videoPath, redactionOn.result.videoPath, 6500, boxCrop);
  check(
    '(d) redaction blur changes pixels inside the box during the step window',
    insideDiff > 2,
    `mapped box ${JSON.stringify({ x: cropX, y: cropY, width: cropW, height: cropH })}, YAVG diff ${insideDiff.toFixed(2)} (need > 2)`
  );
  check(
    '(d) redaction blur changes nothing outside the box during the window',
    cornerDiff < 1,
    `far-corner YAVG diff ${cornerDiff.toFixed(2)} (need < 1)`
  );
  check(
    '(d) redaction blur is off outside the step window',
    outsideDiff < 1,
    `same-box YAVG diff at 6.5s ${outsideDiff.toFixed(2)} (need < 1)`
  );

  // Merge rules (lead clarification): contiguous identical boxes become one
  // interval; a gap must NOT be bridged.
  const mergeSteps = [0, 1, 2, 3].map((index) => ({
    index,
    kind: 'click',
    narration: '',
    startedAtMs: index * 1000 + 100,
    endedAtMs: index * 1000 + 900,
    box: { x: index * 10, y: 10, width: 200, height: 80 }
  })) as StepRecord[];
  const sameBox = { x: 40, y: 40, width: 200, height: 60 };
  const contiguous = planRedactionWindows(
    [
      { ...sameBox, stepIndex: 0 },
      { ...sameBox, stepIndex: 1 },
      { ...sameBox, stepIndex: 2 }
    ],
    mergeSteps,
    VIEWPORT,
    5000,
    []
  );
  check(
    '(d) contiguous identical boxes merge into one blur interval',
    contiguous.length === 1 &&
      contiguous[0].startMs === Math.max(0, mergeSteps[0].startedAtMs - 150) &&
      contiguous[0].endMs === mergeSteps[2].endedAtMs + 150 &&
      contiguous[0].stepIndices.length === 3,
    JSON.stringify(contiguous)
  );
  const gapped = planRedactionWindows(
    [
      { ...sameBox, stepIndex: 0 },
      { ...sameBox, stepIndex: 2 }
    ],
    mergeSteps,
    VIEWPORT,
    5000,
    []
  );
  check(
    '(d) a missing step does not bridge the gap',
    gapped.length === 2 && gapped[0].endMs <= mergeSteps[0].endedAtMs + 150 && gapped[1].startMs >= mergeSteps[2].startedAtMs - 150,
    JSON.stringify(gapped)
  );

  // ---- 6. Provider description per platform --------------------------------
  console.log('[7/8] describing TTS providers per platform ...');
  const expectedIds = 'openai,elevenlabs,edge,macos,linux,sapi,none';
  check(
    '(e) describeTtsProviders reports the native platform',
    nativeCoverage.length === 7 &&
      nativeCoverage.every((info) => info.platform === process.platform) &&
      nativeCoverage.map((info) => info.id).join(',') === expectedIds,
    nativeCoverage.map((info) => `${info.id}:${info.available ? 'yes' : 'no'}`).join(' ')
  );
  const sapiInfo = nativeCoverage.find((info) => info.id === 'sapi');
  check(
    '(e) sapi availability matches the platform',
    Boolean(sapiInfo) && sapiInfo!.available === (process.platform === 'win32'),
    `platform=${process.platform}, sapi.available=${sapiInfo?.available}, active provider=${provider}`
  );

  const linuxView = await describeTtsProviders('linux');
  const linuxSapi = linuxView.find((info) => info.id === 'sapi');
  const linuxMac = linuxView.find((info) => info.id === 'macos');
  check(
    '(e) platform override linux gates Windows/macOS voices',
    linuxView.every((info) => info.platform === 'linux') &&
      linuxSapi?.available === false &&
      linuxMac?.available === false &&
      /Windows-only/.test(linuxSapi?.reason ?? ''),
    `sapi=${linuxSapi?.reason}`
  );

  const darwinView = await describeTtsProviders('darwin');
  const darwinSapi = darwinView.find((info) => info.id === 'sapi');
  const darwinLinux = darwinView.find((info) => info.id === 'linux');
  check(
    '(e) platform override darwin gates Windows/Linux voices',
    darwinView.every((info) => info.platform === 'darwin') &&
      darwinSapi?.available === false &&
      darwinLinux?.available === false,
    `sapi=${darwinSapi?.reason}; linux=${darwinLinux?.reason}`
  );

  // ---- 7. Summary ----------------------------------------------------------
  console.log('[8/8] summary');
  const failed = checks.filter((entry) => !entry.ok);
  const coverage = nativeCoverage.filter((info) => info.available).map((info) => info.id);
  console.log('');
  console.log('TTS provider coverage:');
  console.log(
    JSON.stringify(
      Object.fromEntries(
        nativeCoverage.map((info) => [info.id, { available: info.available, platform: info.platform, reason: info.reason }])
      ),
      null,
      2
    )
  );
  console.log('');
  console.log('render summary:');
  console.log(
    JSON.stringify(
      {
        main: {
          file: path.relative(ROOT, OUTPUT_MP4).split(path.sep).join('/'),
          durationMs: probe.durationMs,
          width: probe.width,
          height: probe.height,
          videoCodec: probe.videoCodec,
          audioCodec: probe.audioCodec,
          hasAudio: probe.hasAudio,
          sizeBytes: probe.sizeBytes
        },
        portrait: { width: portrait.probe.width, height: portrait.probe.height, corners: portraitCorners },
        square: { width: square.probe.width, height: square.probe.height, corners: squareCorners },
        music: {
          only: { hasAudio: musicOnly.probe.hasAudio, meanVolumeDb: musicOnlyVolume },
          missingWarn: missingMusic.result.warnings.filter((warning) => /^music:/.test(warning))
        },
        redactions: { insideDiff, cornerDiff, outsideDiff, mapped: { x: cropX, y: cropY, width: cropW, height: cropH } },
        tts: { active: provider, availableOnThisMachine: coverage },
        narrationLines: result.lines.length,
        srtPath: result.srtPath,
        posterPath: result.posterPath,
        warnings: result.warnings
      },
      null,
      2
    )
  );
  console.log('');
  if (failed.length === 0) {
    console.log(`SELFTEST PASS - ${checks.length}/${checks.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`Result: ${OUTPUT_MP4}`);
    process.exit(0);
  }
  console.log(`SELFTEST FAIL - ${failed.length}/${checks.length} checks failed:`);
  for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail}`);
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error('SELFTEST FAIL - unhandled error');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
