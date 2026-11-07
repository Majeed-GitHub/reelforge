/**
 * End-to-end self-test for the Reelforge render stage.
 *
 *   node packages/render/test/render-selftest.ts
 *
 * Generates a synthetic 8s 1280x720 WebM (ffmpeg lavfi), fabricates four steps
 * with boxes/timings/narration, renders a narrated MP4 through the real
 * pipeline, then verifies the result with ffprobe.
 *
 * Exits 0 only when every check passes; prints PASS/FAIL lines and the raw
 * ffprobe JSON summary for evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ROOT } from '../../core/src/config.ts';
import type { CaptureResult, StepRecord } from '../../core/src/types.ts';
import { ffmpegPath, ffprobePath, probeMedia, runFfmpeg, runFfprobe, tailOutput } from '../src/ffmpeg.ts';
import { renderDemo } from '../src/index.ts';
import { resolveTtsProvider } from '../src/tts.ts';

const OUT_DIR = path.join(PATHS.exports, 'selftest');
const SOURCE_WEBM = path.join(OUT_DIR, 'capture.webm');
const OUTPUT_MP4 = path.join(OUT_DIR, 'selftest-demo.mp4');
const SCALE_HEIGHT = 720;

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

function buildCapture(steps: StepRecord[]): CaptureResult {
  const now = Date.now();
  return {
    steps,
    viewport: { width: 1280, height: 720 },
    videoPath: SOURCE_WEBM,
    startedAtEpochMs: now - 8000,
    endedAtEpochMs: now,
    goalMet: true,
    finalUrl: 'https://example.test/projects',
    log: []
  };
}

async function generateSyntheticWebm(): Promise<void> {
  const res = await runFfmpeg(
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1280x720:rate=30:duration=8',
      '-c:v',
      'libvpx',
      '-b:v',
      '1500k',
      SOURCE_WEBM
    ],
    { timeoutMs: 120_000 }
  );
  if (res.code !== 0 || !fs.existsSync(SOURCE_WEBM)) {
    throw new Error(`could not generate the synthetic WebM: ${tailOutput(res.stderr, 1500)}`);
  }
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

  // 0. Which TTS provider will actually run?
  const providerInfo = await resolveTtsProvider(undefined, { workDir: path.join(OUT_DIR, 'tts') });
  const provider = providerInfo.provider;
  console.log(`  tts         ${provider}${providerInfo.warnings.length ? ` (${providerInfo.warnings.join('; ')})` : ''}`);
  console.log('');

  // 1. Synthetic capture video.
  console.log('[1/4] generating synthetic 8s 1280x720 WebM ...');
  await generateSyntheticWebm();
  const sourceProbe = await probeMedia(SOURCE_WEBM);
  console.log(
    `      capture.webm ${sourceProbe.width}x${sourceProbe.height} ${sourceProbe.durationMs}ms ` +
      `${(fs.statSync(SOURCE_WEBM).size / 1024).toFixed(0)}KiB`
  );
  check('synthetic capture.webm generated', sourceProbe.durationMs >= 7500, `${sourceProbe.durationMs}ms, ${sourceProbe.width}x${sourceProbe.height}`);

  // 2. Render.
  const steps = fixtureSteps();
  const capture = buildCapture(steps);
  console.log('[2/4] rendering narrated MP4 through renderDemo() ...');
  const result = await renderDemo({
    capture,
    steps,
    outDir: OUT_DIR,
    outputPath: OUTPUT_MP4,
    options: {
      fps: 30,
      scaleHeight: SCALE_HEIGHT,
      watermark: true,
      watermarkText: 'Reelforge',
      language: 'en',
      zoom: 1.6
    }
  });
  const renderMs = Date.now() - t0;
  console.log(`      rendered in ${(renderMs / 1000).toFixed(1)}s`);
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) console.log(`      warning: ${warning}`);
  }

  check('renderDemo returned a result', Boolean(result), result.videoPath ?? '');
  check('finished MP4 exists', fs.existsSync(OUTPUT_MP4), OUTPUT_MP4);

  // 3. ffprobe evidence.
  console.log('[3/4] probing the finished MP4 with ffprobe ...');
  const probe = await probeMedia(OUTPUT_MP4);
  const rawProbe = await runFfprobe([
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    OUTPUT_MP4
  ]);
  console.log('--- ffprobe JSON -------------------------------------------------');
  console.log(rawProbe.stdout.trim());
  console.log('------------------------------------------------------------------');

  const expectedWidth = Math.round((SCALE_HEIGHT * 16) / 9);
  check(
    'dimensions match scaleHeight / 16:9',
    probe.width === expectedWidth && probe.height === SCALE_HEIGHT,
    `${probe.width}x${probe.height} (expected ${expectedWidth}x${SCALE_HEIGHT})`
  );
  check('video stream present (h264)', probe.hasVideo && probe.videoCodec === 'h264', `codec=${probe.videoCodec}`);

  const lastLine = result.lines.reduce((max, line) => Math.max(max, line.startMs + line.durationMs), 0);
  const expectedDurationMs = Math.max(sourceProbe.durationMs, lastLine + 400);
  const durationOk = Math.abs(probe.durationMs - expectedDurationMs) <= 1200;
  check(
    'duration within tolerance',
    durationOk,
    `measured ${probe.durationMs}ms, expected ~${expectedDurationMs}ms (tolerance 1200ms)`
  );

  if (provider !== 'none') {
    check('audio stream present (narration)', probe.hasAudio, `codec=${probe.audioCodec}, sampleRate=${probe.sampleRate}`);
    check(
      'narration lines carry audio paths',
      result.lines.length > 0 && result.lines.filter((line) => line.audioPath).length > 0,
      `${result.lines.filter((line) => line.audioPath).length}/${result.lines.length} lines`
    );
  } else {
    console.log('SKIP  audio stream assertion (no TTS provider available)');
  }

  const sizeOk = probe.sizeBytes > 50_000;
  check('file size is sane', sizeOk, `${(probe.sizeBytes / 1024).toFixed(0)}KiB`);

  check('SRT file written', Boolean(result.srtPath && fs.existsSync(result.srtPath)), result.srtPath ?? 'missing');
  if (result.srtPath && fs.existsSync(result.srtPath)) {
    const srt = fs.readFileSync(result.srtPath, 'utf8');
    const blocks = srt.trim() ? srt.trim().split(/\n\n/).length : 0;
    check('SRT has one block per narration line', blocks === steps.length, `${blocks} blocks / ${steps.length} lines`);
  }
  const posterOk = Boolean(result.posterPath && fs.existsSync(result.posterPath) && fs.statSync(result.posterPath).size > 0);
  check('poster frame extracted', posterOk, result.posterPath ?? 'missing');

  // 4. Summary.
  console.log('[4/4] summary');
  const failed = checks.filter((entry) => !entry.ok);
  console.log('');
  console.log('ffprobe summary:');
  console.log(
    JSON.stringify(
      {
        file: path.relative(ROOT, OUTPUT_MP4).split(path.sep).join('/'),
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
        hasAudio: probe.hasAudio,
        sizeBytes: probe.sizeBytes,
        ttsProvider: provider,
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
