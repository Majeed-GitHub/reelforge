/**
 * Time-scoped redaction blur.
 *
 * The agent records one redaction entry per step (never collapsing identical
 * boxes across consecutive steps, because collapsing wrongly would un-blur a
 * field that is still on screen). The renderer:
 *
 *   1. blurs each box only inside its step's own window, plus a 150 ms
 *      lead-in/out so the blur does not pop;
 *   2. merges *contiguous identical* boxes itself: steps 3, 4 and 5 carrying
 *      the same geometry become one continuous interval (safe - coverage only
 *      extends where the field was already visible) and stops re-application
 *      flicker;
 *   3. never bridges a gap: if a step has no redaction entry, the next identical
 *      box starts a new interval.
 *
 * Blur is applied to the source frame *before* the auto-zoom camera, so the
 * blurred region pans/zooms with the content and the blurred background copy of
 * social reframes never contains the sensitive pixels either.
 */
import type { Box, StepRecord } from '../../core/src/types.ts';
import type { Viewport } from './zoom.ts';
import { cameraCropRectAt, type ZoomKeyframe } from './zoom.ts';
import type { AspectLayout } from './aspect.ts';

export type RedactionBox = Box & { stepIndex: number };

export type RedactionWindow = {
  box: Box;
  startMs: number;
  endMs: number;
  /** Step indices whose entries merged into this window. */
  stepIndices: number[];
};

/** Blur lead-in/out around a step window, so it does not pop mid-frame. */
export const REDACTION_LEAD_MS = 150;
/** Geometry drift allowed when deciding two boxes are "identical". */
export const REDACTION_MERGE_TOLERANCE_PX = 4;

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

export function normalizeRedactionBox(raw: Box | undefined, viewport: Viewport): Box | null {
  if (!raw) return null;
  const x = finite(raw.x, Number.NaN);
  const y = finite(raw.y, Number.NaN);
  const width = finite(raw.width, Number.NaN);
  const height = finite(raw.height, Number.NaN);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const left = clamp(Math.round(x), 0, Math.max(0, viewport.width - 1));
  const top = clamp(Math.round(y), 0, Math.max(0, viewport.height - 1));
  const right = clamp(Math.round(x + width), left + 1, viewport.width);
  const bottom = clamp(Math.round(y + height), top + 1, viewport.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Boxes are "identical" when their rounded edges are within a few pixels. */
export function sameRedactionGeometry(a: Box, b: Box): boolean {
  const tol = REDACTION_MERGE_TOLERANCE_PX;
  return (
    Math.abs(a.x - b.x) <= tol &&
    Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.width - b.width) <= tol &&
    Math.abs(a.height - b.height) <= tol
  );
}

/**
 * Plan the blur intervals: one window per contiguous run of identical boxes
 * across consecutive ordered steps, with the 150 ms lead-in/out applied.
 */
export function planRedactionWindows(
  redactions: RedactionBox[] | undefined,
  steps: StepRecord[],
  viewport: Viewport,
  durationMs: number,
  warnings: string[] = []
): RedactionWindow[] {
  const ordered = (Array.isArray(steps) ? steps : [])
    .slice()
    .sort((a, b) => finite(a.startedAtMs, 0) - finite(b.startedAtMs, 0) || a.index - b.index);
  const stepByIndex = new Map<number, StepRecord>();
  for (const step of ordered) stepByIndex.set(step.index, step);

  const boxesByStep = new Map<number, Box[]>();
  for (const raw of Array.isArray(redactions) ? redactions : []) {
    if (!raw || !Number.isFinite(raw.stepIndex)) continue;
    const step = stepByIndex.get(raw.stepIndex);
    if (!step) {
      warnings.push(`redactions: no step with index ${raw.stepIndex}; skipping that blur`);
      continue;
    }
    const box = normalizeRedactionBox(raw, viewport);
    if (!box) {
      warnings.push(`redactions: invalid box for step ${raw.stepIndex}; skipping that blur`);
      continue;
    }
    const list = boxesByStep.get(step.index) ?? [];
    if (!list.some((existing) => sameRedactionGeometry(existing, box))) list.push(box);
    boxesByStep.set(step.index, list);
  }

  const windows: RedactionWindow[] = [];
  let previousStepWindows: RedactionWindow[] = [];

  for (const step of ordered) {
    const boxes = boxesByStep.get(step.index) ?? [];
    const current: RedactionWindow[] = [];
    for (const box of boxes) {
      const continued = previousStepWindows.find((window) => sameRedactionGeometry(window.box, box));
      if (continued) {
        continued.endMs = Math.max(continued.endMs, step.endedAtMs);
        continued.stepIndices.push(step.index);
        current.push(continued);
        continue;
      }
      const created: RedactionWindow = {
        box,
        startMs: step.startedAtMs,
        endMs: Math.max(step.endedAtMs, step.startedAtMs + 1),
        stepIndices: [step.index]
      };
      windows.push(created);
      current.push(created);
    }
    // Only the immediately previous step can be merged into; a gap starts fresh.
    previousStepWindows = current;
  }

  return windows.map((window) => ({
    ...window,
    startMs: Math.max(0, Math.round(window.startMs - REDACTION_LEAD_MS)),
    endMs: Math.max(0, Math.min(durationMs, Math.round(window.endMs + REDACTION_LEAD_MS)))
  }));
}

function scaleBoxToSource(box: Box, viewport: Viewport, sourceSize: Viewport): Box | null {
  const sx = sourceSize.width / Math.max(1, viewport.width);
  const sy = sourceSize.height / Math.max(1, viewport.height);
  const x = clamp(Math.round(box.x * sx), 0, Math.max(0, sourceSize.width - 1));
  const y = clamp(Math.round(box.y * sy), 0, Math.max(0, sourceSize.height - 1));
  const width = makeEven(clamp(Math.round(box.width * sx), 2, Math.max(2, sourceSize.width - x)));
  const height = makeEven(clamp(Math.round(box.height * sy), 2, Math.max(2, sourceSize.height - y)));
  if (sourceSize.width - x < 2 || sourceSize.height - y < 2) return null;
  return { x, y, width: Math.min(width, sourceSize.width - x), height: Math.min(height, sourceSize.height - y) };
}

export type RedactionChains = {
  chains: string[];
  /** Filter label carrying the redacted source frame. */
  outputLabel: string;
};

/**
 * Build the pre-camera blur graph. Each window is a split/crop/boxblur/overlay
 * with `enable='between(t,start,end)'`, so pixels are only obscured while the
 * owning step is actually on screen.
 */
export function buildRedactionChains(
  windows: RedactionWindow[],
  viewport: Viewport,
  sourceSize: Viewport,
  startLabel: string = '0:v'
): RedactionChains {
  const chains: string[] = [];
  let label = startLabel;
  windows.forEach((window, index) => {
    const box = scaleBoxToSource(window.box, viewport, sourceSize);
    if (!box) return;
    const radius = clamp(Math.round(Math.min(box.width, box.height) / 6), 1, 40);
    const base = `rvBase${index}`;
    const target = `rvTgt${index}`;
    const blurred = `rvBlur${index}`;
    const out = `rv${index}`;
    chains.push(`[${label}]split=2[${base}][${target}]`);
    chains.push(
      `[${target}]crop=${box.width}:${box.height}:${box.x}:${box.y},` +
        `boxblur=luma_radius=${radius}:luma_power=2:chroma_radius=${radius}:chroma_power=2[${blurred}]`
    );
    chains.push(
      `[${base}][${blurred}]overlay=${box.x}:${box.y}:` +
        `enable='between(t,${seconds(window.startMs)},${seconds(window.endMs)})':format=auto[${out}]`
    );
    label = out;
  });
  return { chains, outputLabel: label };
}

/**
 * Map a viewport-space box into finished-frame pixels for the given camera
 * state. Exported because the self-test (and future callers) need to know where
 * a blurred region actually lands; the renderer itself blurs pre-camera.
 */
export function mapViewportRectThroughCamera(
  box: Box,
  viewport: Viewport,
  layout: AspectLayout,
  camera: { cx: number; cy: number; zoom: number }
): Box {
  const zoom = clamp(camera.zoom, 1, 3);
  const crop = cameraCropRectAt([{ tMs: 0, cx: camera.cx, cy: camera.cy, zoom }], viewport, 0);
  const sx = layout.camWidth / crop.width;
  const sy = layout.camHeight / crop.height;
  return {
    x: layout.fitX + (box.x - crop.x) * sx,
    y: layout.fitY + (box.y - crop.y) * sy,
    width: box.width * sx,
    height: box.height * sy
  };
}

/** Camera state at a timestamp, re-exported for tests that map redaction boxes. */
export { cameraStateAt } from './zoom.ts';
export type { ZoomKeyframe };
