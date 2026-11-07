/**
 * Auto-zoom camera: turns StepRecord boxes/points into a keyframe timeline and
 * an ffmpeg `zoompan` expression program.
 *
 * Keyframes are (t, cx, cy, zoom): the centre of the camera in viewport CSS px
 * and the zoom factor (1 = full frame). Segments are interpolated with an
 * easeInOutCubic curve; centres are clamped so the crop never leaves the frame.
 *
 * The expression program is generated (not hand-written): three expressions
 * z(t), x(t), y(t) that ffmpeg evaluates per frame inside `zoompan`.
 */
import type { Box, StepRecord, Point } from '../../core/src/types.ts';

export type Viewport = { width: number; height: number };

export type ZoomKeyframe = {
  /** Milliseconds relative to video start. */
  tMs: number;
  /** Camera centre X in viewport CSS px. */
  cx: number;
  /** Camera centre Y in viewport CSS px. */
  cy: number;
  /** 1 = full frame, 1.6 = default, capped by maxZoom. */
  zoom: number;
};

export type ZoomTimelineOptions = {
  /** Requested zoom strength. 1 disables zoom. Default 1.6. */
  strength?: number;
  /** Transition length between shots, ms. Default 650. */
  transitionMs?: number;
};

export type ZoomFilterProgram = {
  /** ffmpeg expression over `time` (seconds), zoom factor. */
  z: string;
  /** ffmpeg expression over `time` + `in_w`/`in_h`, crop origin X. */
  x: string;
  /** ffmpeg expression over `time` + `in_w`/`in_h`, crop origin Y. */
  y: string;
  keyframes: ZoomKeyframe[];
};

export const DEFAULT_ZOOM_STRENGTH = 1.6;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const MIN_SHOT_MS = 700;
const TAIL_ZOOM_OUT_MS = 900;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampViewport(viewport: Viewport | undefined): Viewport {
  const width = clamp(finite(viewport?.width, 1280), 16, 16384);
  const height = clamp(finite(viewport?.height, 720), 16, 16384);
  return { width, height };
}

/** Keep the camera centre such that the crop stays fully inside the frame. */
export function clampCenter(cx: number, cy: number, zoom: number, viewport: Viewport): { cx: number; cy: number } {
  const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const halfW = viewport.width / (2 * z);
  const halfH = viewport.height / (2 * z);
  return {
    cx: clamp(cx, halfW, viewport.width - halfW),
    cy: clamp(cy, halfH, viewport.height - halfH)
  };
}

/**
 * Where the camera should look for one step.
 * - `box`: frame the element with breathing room, zooming further when small.
 * - `point`: a comfortable fixed region around the pointer.
 * - neither: null (leave the camera where it is).
 */
export function targetForStep(
  step: StepRecord,
  viewport: Viewport,
  strength: number
): { cx: number; cy: number; zoom: number } | null {
  const vp = clampViewport(viewport);
  const requested = clamp(finite(strength, DEFAULT_ZOOM_STRENGTH), MIN_ZOOM, MAX_ZOOM);
  if (requested <= 1.001) return null;

  const box: Box | undefined =
    step.box && finite(step.box.width, 0) > 0 && finite(step.box.height, 0) > 0 ? step.box : undefined;
  const point: Point | undefined =
    step.point && Number.isFinite(step.point.x) && Number.isFinite(step.point.y) ? step.point : undefined;

  if (box) {
    const w = finite(box.width, 0);
    const h = finite(box.height, 0);
    const margin = 1.65;
    const fit = Math.min(requested, vp.width / Math.max(1, w * margin), vp.height / Math.max(1, h * margin));
    if (fit <= 1.04) return null;
    const zoom = clamp(fit, MIN_ZOOM, MAX_ZOOM);
    const { cx, cy } = clampCenter(finite(box.x, 0) + w / 2, finite(box.y, 0) + h / 2, zoom, vp);
    return { cx, cy, zoom };
  }

  if (point) {
    // A virtual 440x250 region around the pointer keeps clicks readable.
    const regionW = 440;
    const regionH = 250;
    const fit = Math.min(requested, vp.width / regionW, vp.height / regionH);
    if (fit <= 1.04) return null;
    const zoom = clamp(fit, MIN_ZOOM, MAX_ZOOM);
    const { cx, cy } = clampCenter(finite(point.x, 0), finite(point.y, 0), zoom, vp);
    return { cx, cy, zoom };
  }

  return null;
}

function sameState(a: ZoomKeyframe, b: { cx: number; cy: number; zoom: number }): boolean {
  return Math.abs(a.cx - b.cx) < 0.5 && Math.abs(a.cy - b.cy) < 0.5 && Math.abs(a.zoom - b.zoom) < 0.002;
}

/**
 * Build the keyframe timeline. A shot is held for the duration of its step,
 * entered with an eased 650ms move, and the camera returns to the full frame
 * after the final step.
 */
export function buildZoomTimeline(
  steps: StepRecord[],
  viewport: Viewport | undefined,
  options: ZoomTimelineOptions = {}
): ZoomKeyframe[] {
  const vp = clampViewport(viewport);
  const strength = clamp(finite(options.strength, DEFAULT_ZOOM_STRENGTH), MIN_ZOOM, MAX_ZOOM);
  const transitionMs = clamp(finite(options.transitionMs, 650), 120, 2500);
  const center: ZoomKeyframe = { tMs: 0, cx: vp.width / 2, cy: vp.height / 2, zoom: 1 };

  const ordered = Array.isArray(steps)
    ? [...steps].sort((a, b) => finite(a.startedAtMs, 0) - finite(b.startedAtMs, 0))
    : [];

  type Shot = { startMs: number; endMs: number; target: { cx: number; cy: number; zoom: number } };
  const shots: Shot[] = [];
  for (const step of ordered) {
    const target = targetForStep(step, vp, strength);
    if (!target) continue;
    const startMs = Math.max(0, finite(step.startedAtMs, 0));
    const rawEnd = finite(step.endedAtMs, startMs + MIN_SHOT_MS);
    const endMs = Math.max(startMs + MIN_SHOT_MS, rawEnd);
    shots.push({ startMs, endMs, target });
  }

  if (shots.length === 0) return [center];

  const keyframes: ZoomKeyframe[] = [center];
  let lastT = 0;

  const pushRaw = (tMs: number, state: { cx: number; cy: number; zoom: number }): void => {
    const t = Math.max(Math.round(tMs), lastT + 1);
    lastT = t;
    keyframes.push({ tMs: t, cx: state.cx, cy: state.cy, zoom: state.zoom });
  };

  for (const shot of shots) {
    const previous = keyframes[keyframes.length - 1];
    const transitionStart = Math.max(previous.tMs + 16, shot.startMs - transitionMs);
    if (transitionStart > previous.tMs + 16) {
      // Hold the previous framing until the transition is due to start.
      pushRaw(transitionStart, previous);
    }
    const enterAt = Math.max(transitionStart, shot.startMs);
    if (!sameState(keyframes[keyframes.length - 1], shot.target)) {
      pushRaw(enterAt, shot.target);
    }
    const holdEnd = Math.max(enterAt + MIN_SHOT_MS, shot.endMs);
    if (!sameState(keyframes[keyframes.length - 1], shot.target) || holdEnd > enterAt) {
      pushRaw(holdEnd, shot.target);
    }
  }

  // Settle back to the full frame once the run is over.
  pushRaw(lastT + TAIL_ZOOM_OUT_MS, center);

  return keyframes;
}

function num(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/** easeInOutCubic for normalised progress u: 4u^3 below 0.5, 1-(-2u+2)^3/2 above. */
function easeInOutCubic(u: string): string {
  return `if(lt(${u},0.5),4*${u}*${u}*${u},1-pow(-2*${u}+2,3)/2)`;
}

function valueExpression(
  keyframes: ZoomKeyframe[],
  pick: (k: ZoomKeyframe) => number
): string {
  const last = keyframes[keyframes.length - 1];
  if (keyframes.length === 1) return num(pick(last));
  let expression = num(pick(last));
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    const dtSec = (b.tMs - a.tMs) / 1000;
    if (dtSec <= 0) continue;
    const u = `((time-${num(a.tMs / 1000)})/${num(dtSec)})`;
    const va = num(pick(a));
    const vb = num(pick(b));
    expression = `if(lt(time,${num(b.tMs / 1000)}),${va}+(${vb}-${va})*${easeInOutCubic(u)},${expression})`;
  }
  return expression;
}

/**
 * Generate the ffmpeg expression program. `z(t)` is the zoom factor,
 * `x(t)`/`y(t)` are the crop origin in input pixels, clamped to the frame.
 */
export function zoomExpressionProgram(
  keyframes: ZoomKeyframe[],
  viewport: Viewport | undefined
): ZoomFilterProgram {
  const vp = clampViewport(viewport);
  const safe = keyframes.length > 0 ? keyframes : [{ tMs: 0, cx: vp.width / 2, cy: vp.height / 2, zoom: 1 }];
  const z = valueExpression(safe, (k) => clamp(k.zoom, MIN_ZOOM, MAX_ZOOM));
  const cx = valueExpression(safe, (k) => k.cx);
  const cy = valueExpression(safe, (k) => k.cy);
  const x = `clip((${cx})*in_w/${num(vp.width)}-in_w/(2*(${z})),0,in_w-in_w/(${z}))`;
  const y = `clip((${cy})*in_h/${num(vp.height)}-in_h/(2*(${z})),0,in_h-in_h/(${z}))`;
  return { z, x, y, keyframes: safe };
}

/**
 * Numerically evaluate the camera at a timestamp (same easeInOutCubic curve the
 * ffmpeg expression program implements). Used for mapping redaction boxes into
 * output pixels and by the self-test.
 */
export function cameraStateAt(
  keyframes: ZoomKeyframe[],
  tMs: number
): { cx: number; cy: number; zoom: number } {
  const frames = Array.isArray(keyframes) && keyframes.length > 0
    ? keyframes
    : [{ tMs: 0, cx: 0, cy: 0, zoom: 1 }];
  if (tMs <= frames[0].tMs) return { cx: frames[0].cx, cy: frames[0].cy, zoom: frames[0].zoom };
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    if (tMs >= b.tMs) continue;
    const dt = b.tMs - a.tMs;
    const u = dt <= 0 ? 1 : (tMs - a.tMs) / dt;
    const eased = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    return {
      cx: a.cx + (b.cx - a.cx) * eased,
      cy: a.cy + (b.cy - a.cy) * eased,
      zoom: a.zoom + (b.zoom - a.zoom) * eased
    };
  }
  const last = frames[frames.length - 1];
  return { cx: last.cx, cy: last.cy, zoom: last.zoom };
}

/**
 * The camera crop rectangle in viewport coordinates at a timestamp (origin +
 * size). Mirrors what `zoompan` does with the expression program.
 */
export function cameraCropRectAt(
  keyframes: ZoomKeyframe[],
  viewport: Viewport | undefined,
  tMs: number
): { x: number; y: number; width: number; height: number; zoom: number } {
  const vp = clampViewport(viewport);
  const state = cameraStateAt(keyframes, tMs);
  const zoom = clamp(state.zoom, MIN_ZOOM, MAX_ZOOM);
  const width = vp.width / zoom;
  const height = vp.height / zoom;
  const { cx, cy } = clampCenter(state.cx, state.cy, zoom, vp);
  return { x: cx - width / 2, y: cy - height / 2, width, height, zoom };
}

/**
 * Full video filter prefix: 2x upscale (keeps crops sharp), animated zoompan
 * crop, then setsar. The zoompan output is already at the target size.
 */
export function buildZoompanFilter(
  keyframes: ZoomKeyframe[],
  viewport: Viewport | undefined,
  options: { outWidth: number; outHeight: number; fps: number; upscale?: number }
): string {
  const program = zoomExpressionProgram(keyframes, viewport);
  const upscale = clamp(Math.round(options.upscale ?? 2), 1, 4);
  const width = Math.max(2, Math.round(options.outWidth));
  const height = Math.max(2, Math.round(options.outHeight));
  const fps = clamp(Math.round(options.fps), 10, 60);
  return (
    `scale=iw*${upscale}:ih*${upscale}:flags=lanczos,` +
    `zoompan=z='${program.z}':x='${program.x}':y='${program.y}':d=1:s=${width}x${height}:fps=${fps},` +
    'setsar=1'
  );
}
