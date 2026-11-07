/**
 * Looping GIF previews.
 *
 * A demo video is the deliverable, but the thing people paste into Slack,
 * READMEs and issue trackers is a 3–4 second loop. The interesting moment is
 * picked from the capture's own data: the step whose element box has the
 * largest area (a big form, a full-width panel) reads far better in a
 * thumbnail-sized loop than a 40 px nav link.
 *
 * ffmpeg does the work in one pass — `fps` -> `scale` -> `split` ->
 * `palettegen`/`paletteuse` — because the two-step temp-PNG-palette dance leaves
 * files around and is slower. Width is capped at 720 and the encoder is retried
 * at lower fps/colour depth until the file fits the ~2 MB budget, so a GIF
 * export is always paste-able.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { StepRecord } from '../../core/src/types.ts';
import { probeMedia, runFfmpeg, tailOutput } from './ffmpeg.ts';

/** Hard cap on preview width (px). Retries only go narrower. */
export const GIF_MAX_WIDTH = 720;
/** Budget for the finished GIF (bytes). */
export const GIF_TARGET_BYTES = 2 * 1024 * 1024;
export const GIF_DEFAULT_DURATION_MS = 3500;

export type GifOptions = {
  /** Absolute output path (.gif). */
  outPath: string;
  /** Capture steps, used to find the most interesting moment. */
  steps?: StepRecord[];
  /** Loop length in ms, clamped to 2000–4000. Default 3500. */
  durationMs?: number;
  /** Ignore `steps` and centre the loop on this timestamp. */
  atMs?: number;
  /** Maximum output width; never exceeds GIF_MAX_WIDTH. Default 720. */
  maxWidth?: number;
  /** Starting frame rate. Default 12. */
  fps?: number;
  /** Size budget. Default GIF_TARGET_BYTES. */
  maxBytes?: number;
  timeoutMs?: number;
};

export type GifWindow = {
  /** Which capture step the loop is centred on (null = video centre). */
  stepIndex: number | null;
  startMs: number;
  durationMs: number;
};

export type GifResult = {
  path: string;
  startMs: number;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
  stepIndex: number | null;
  /** How many encode attempts it took to fit the budget (1–3). */
  attempts: number;
  /** True when even the smallest attempt is still over budget. */
  overBudget: boolean;
  targetBytes: number;
};

type Attempt = { fps: number; width: number; height: number; colors: number; dither: 'bayer' | 'sierra2_4a' };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeEven(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function seconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

function boxArea(step: StepRecord): number {
  const box = step.box;
  if (!box) return 0;
  const width = finite(box.width, 0);
  const height = finite(box.height, 0);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

/**
 * Pick the 3–4 s window: the step with the largest element box, centred so the
 * click/typing lands mid-loop. Falls back to the video centre when no step
 * carried a usable box.
 */
export function pickGifWindow(
  steps: StepRecord[] | undefined,
  videoDurationMs: number,
  requestedMs: number = GIF_DEFAULT_DURATION_MS
): GifWindow {
  const video = Math.max(0, Math.round(videoDurationMs));
  const wanted = clamp(requestedMs, 2000, 4000);
  const duration = Math.max(0, Math.min(wanted, video || wanted));

  const usable = (Array.isArray(steps) ? steps : []).filter(
    (step) => step && boxArea(step) > 0 && finite(step.startedAtMs, 0) >= 0 && finite(step.startedAtMs, 0) <= video
  );

  let best: StepRecord | null = null;
  for (const step of usable) {
    if (!best || boxArea(step) > boxArea(best)) best = step;
  }

  let centreMs: number;
  let stepIndex: number | null = null;
  if (best) {
    stepIndex = Number.isFinite(best.index) ? best.index : null;
    const start = finite(best.startedAtMs, 0);
    const end = finite(best.endedAtMs, start);
    centreMs = end > start ? (start + end) / 2 : start + 400;
  } else {
    centreMs = video / 2;
  }

  const maxStart = Math.max(0, video - duration);
  const startMs = Math.round(clamp(centreMs - duration / 2, 0, maxStart) / 10) * 10;
  return { stepIndex, startMs, durationMs: duration };
}

function attemptPlan(options: GifOptions, sourceWidth: number, sourceHeight: number): Attempt[] {
  const cap = Math.max(160, Math.min(Math.round(finite(options.maxWidth, GIF_MAX_WIDTH)), GIF_MAX_WIDTH));
  const baseWidth = Math.max(2, Math.min(cap, Math.round(sourceWidth) || 1280));
  const heightFor = (width: number): number =>
    makeEven(Math.round((width * (Math.round(sourceHeight) || 720)) / (Math.round(sourceWidth) || 1280)));
  const fps = clamp(Math.round(finite(options.fps, 12)), 4, 30);
  const plan: Attempt[] = [
    { fps, width: makeEven(baseWidth), height: heightFor(baseWidth), colors: 128, dither: 'bayer' },
    { fps: Math.max(8, fps - 2), width: makeEven(Math.min(baseWidth, 640)), height: 0, colors: 96, dither: 'bayer' },
    { fps: Math.max(6, fps - 4), width: makeEven(Math.min(baseWidth, 480)), height: 0, colors: 64, dither: 'sierra2_4a' }
  ];
  for (const attempt of plan) {
    if (!attempt.height) attempt.height = heightFor(attempt.width);
  }
  return plan;
}

/**
 * Render (or re-render) a looping GIF preview from a finished demo video.
 * Throws with a useful message when the source is unreadable or ffmpeg fails.
 */
export async function createGifPreview(videoPath: string, options: GifOptions): Promise<GifResult> {
  if (!options || typeof options.outPath !== 'string' || !options.outPath) {
    throw new Error('gif: options.outPath is required');
  }
  if (!fs.existsSync(videoPath)) throw new Error(`gif: source video not found: ${videoPath}`);

  const probe = await probeMedia(videoPath);
  if (!probe.hasVideo || probe.durationMs <= 0) {
    throw new Error(`gif: ${path.basename(videoPath)} has no readable video stream`);
  }

  const requested = finite(options.durationMs, GIF_DEFAULT_DURATION_MS);
  const window: GifWindow =
    typeof options.atMs === 'number' && Number.isFinite(options.atMs)
      ? {
          stepIndex: null,
          startMs: Math.round(
            clamp(options.atMs - requested / 2, 0, Math.max(0, probe.durationMs - Math.min(requested, probe.durationMs))) / 10
          ) * 10,
          durationMs: Math.min(requested, probe.durationMs)
        }
      : pickGifWindow(options.steps, probe.durationMs, requested);

  const plan = attemptPlan(options, probe.width, probe.height);
  const maxBytes = Math.max(64 * 1024, Math.round(finite(options.maxBytes, GIF_TARGET_BYTES)));
  fs.mkdirSync(path.dirname(options.outPath), { recursive: true });

  let finalAttempt = plan[0];
  let sizeBytes = 0;
  let encoded = 0;

  for (const attempt of plan) {
    // bayer_scale only means anything for the ordered (bayer) dither.
    const ditherOptions = attempt.dither === 'bayer' ? ':bayer_scale=3' : '';
    const filter =
      `[0:v]fps=${attempt.fps},scale=${attempt.width}:${attempt.height}:flags=lanczos,split[a][b];` +
      `[a]palettegen=max_colors=${attempt.colors}:stats_mode=diff[p];` +
      `[b][p]paletteuse=dither=${attempt.dither}${ditherOptions}`;

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      seconds(window.startMs),
      '-t',
      seconds(window.durationMs),
      '-i',
      videoPath,
      '-filter_complex',
      filter,
      '-an',
      '-loop',
      '0',
      options.outPath
    ];

    const result = await runFfmpeg(args, { timeoutMs: options.timeoutMs ?? 120_000 });
    const stat = fs.existsSync(options.outPath) ? fs.statSync(options.outPath) : null;
    if (result.code !== 0 || !stat || stat.size === 0) {
      throw new Error(
        `gif: ffmpeg failed for ${path.basename(options.outPath)}: ` +
          (tailOutput(result.stderr, 1200) || `exit code ${result.code}`)
      );
    }
    encoded += 1;
    finalAttempt = attempt;
    sizeBytes = stat.size;
    if (sizeBytes <= maxBytes) {
      return {
        path: options.outPath,
        startMs: window.startMs,
        durationMs: window.durationMs,
        width: attempt.width,
        height: attempt.height,
        fps: attempt.fps,
        sizeBytes,
        stepIndex: window.stepIndex,
        attempts: encoded,
        overBudget: false,
        targetBytes: maxBytes
      };
    }
  }

  return {
    path: options.outPath,
    startMs: window.startMs,
    durationMs: window.durationMs,
    width: finalAttempt.width,
    height: finalAttempt.height,
    fps: finalAttempt.fps,
    sizeBytes,
    stepIndex: window.stepIndex,
    attempts: encoded,
    overBudget: sizeBytes > maxBytes,
    targetBytes: maxBytes
  };
}

export default createGifPreview;
