/**
 * Output framing: 16:9 (the native capture) plus 9:16 / 1:1 / 4:5 social
 * reframes.
 *
 * The captured 16:9 frame is always the camera's output; for a social aspect it
 * is scaled to fit a taller/square canvas and the rest of the canvas is filled
 * with a blurred, darkened, cover-scaled copy of that same camera frame — the
 * Screen Studio / Loom look, rather than a flat colour.
 *
 * Sizing contract: `scaleHeight` is the canvas height, so 16:9 keeps today's
 * `width = height * 16/9` exactly (pixel-identical output), while 9:16 at
 * `scaleHeight = 1920` yields 1080x1920 and 1:1 at 1080 yields 1080x1080.
 */
import type { AspectRatio } from '../../core/src/types.ts';

export const DEFAULT_ASPECT: AspectRatio = '16:9';

const ASPECT_VALUES: Record<AspectRatio, [number, number]> = {
  '16:9': [16, 9],
  '9:16': [9, 16],
  '1:1': [1, 1],
  '4:5': [4, 5]
};

/** Valid aspect ids (mirrors core ASPECT_RATIOS, re-exported for convenience). */
export const ASPECT_IDS: readonly AspectRatio[] = ['16:9', '9:16', '1:1', '4:5'] as const;

export type AspectLayout = {
  aspect: AspectRatio;
  /** Output canvas. */
  width: number;
  height: number;
  /** The (16:9) camera frame, fitted inside the canvas. */
  camWidth: number;
  camHeight: number;
  /** Top-left of the fitted camera frame on the canvas. */
  fitX: number;
  fitY: number;
  /** True for 16:9: no reframe graph, byte-for-byte the old pipeline. */
  native: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function makeEven(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

export function isAspectRatio(value: unknown): value is AspectRatio {
  return typeof value === 'string' && (ASPECT_IDS as readonly string[]).includes(value);
}

/** Resolve canvas + fitted camera dimensions for an aspect and a height. */
export function resolveAspectLayout(aspect: AspectRatio | undefined, scaleHeight: number): AspectLayout {
  const chosen = isAspectRatio(aspect) ? aspect : DEFAULT_ASPECT;
  const [ratioW, ratioH] = ASPECT_VALUES[chosen];
  const height = makeEven(clamp(Number.isFinite(scaleHeight) ? scaleHeight : 720, 120, 2160));
  const width = makeEven(Math.round((height * ratioW) / ratioH));

  if (chosen === '16:9') {
    return { aspect: chosen, width, height, camWidth: width, camHeight: height, fitX: 0, fitY: 0, native: true };
  }

  // The camera frame is always 16:9, fitted inside the canvas.
  const camWidth = makeEven(Math.min(width, Math.round((height * 16) / 9)));
  const camHeight = makeEven(Math.min(height, Math.round((camWidth * 9) / 16)));
  const fitX = makeEven(clamp(Math.round((width - camWidth) / 2), 0, Math.max(0, width - camWidth)));
  const fitY = makeEven(clamp(Math.round((height - camHeight) / 2), 0, Math.max(0, height - camHeight)));
  return { aspect: chosen, width, height, camWidth, camHeight, fitX, fitY, native: false };
}

/** How strongly the background copy is blurred/darkened. Kept as constants so
 * the look stays consistent across aspect ratios and canvas sizes. The
 * darkening is proportional (colorlevels) rather than subtractive, so dark
 * source areas never crush to pure black. */
const BG_DIVISOR = 4;
const BG_LEVEL_MAX = 0.7;
const BG_SATURATION = 0.85;
const BG_SIGMA_RATIO = 0.012;

/**
 * Filter chains that turn the `[cam]` 16:9 camera frame into a reframed
 * `[framed]` canvas: blurred/darkened cover copy underneath, the full camera
 * frame fitted and centred on top.
 */
export function buildReframeChains(layout: AspectLayout, inputLabel: string = 'cam'): string[] {
  if (layout.native) return [];
  const bgWidth = makeEven(layout.width / BG_DIVISOR);
  const bgHeight = makeEven(layout.height / BG_DIVISOR);
  const sigma = clamp(Math.round(Math.min(layout.width, layout.height) * BG_SIGMA_RATIO), 3, 60);
  const w = layout.width;
  const h = layout.height;
  return [
    `[${inputLabel}]split=2[camFg][camBg]`,
    `[camBg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-${w})/2:(ih-${h})/2,` +
      `scale=${bgWidth}:${bgHeight}:flags=bicubic,gblur=sigma=${sigma},` +
      `scale=${w}:${h}:flags=bicubic,` +
      `colorlevels=romax=${BG_LEVEL_MAX}:gomax=${BG_LEVEL_MAX}:bomax=${BG_LEVEL_MAX},` +
      `eq=saturation=${BG_SATURATION},setsar=1[bg]`,
    `[bg][camFg]overlay=${layout.fitX}:${layout.fitY}:format=auto[framed]`
  ];
}
