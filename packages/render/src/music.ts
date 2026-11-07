/**
 * Background music bed.
 *
 * The user supplies the track (no music is shipped with Reelforge - there is no
 * licence to redistribute one). The renderer loops/trims it to the video
 * length, applies `gain` (default 0.18, i.e. well under narration) and, when
 * `duck` is on (default), compresses it with ffmpeg's `sidechaincompress`,
 * keyed off the narration bus.
 *
 * A missing/unreadable file is a warning, never a render failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MusicOptions } from '../../core/src/types.ts';
import { absoluteFromData } from '../../core/src/config.ts';
import { probeMedia } from './ffmpeg.ts';

export type MusicBed = {
  path: string;
  /** Linear gain 0–1 (applied with ffmpeg `volume`). */
  gain: number;
  duck: boolean;
};

export const DEFAULT_MUSIC_GAIN = 0.18;
export const DEFAULT_DUCK = true;

/** Ducking compressor settings (start points from the v0.3 brief). */
export const DUCK_SETTINGS = {
  threshold: '-25dB',
  ratio: 4,
  attackMs: 200,
  releaseMs: 1000,
  makeup: 1
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Resolve and validate a music bed. Returns `undefined` (with a warning) when
 * the option is absent or the file cannot be read - the caller renders on
 * without music.
 */
export async function resolveMusicBed(
  music: MusicOptions | undefined,
  warnings: string[]
): Promise<MusicBed | undefined> {
  if (!music) return undefined;
  const raw = typeof music.path === 'string' ? music.path.trim() : '';
  if (!raw) {
    warnings.push('music: no path supplied; rendering without background music');
    return undefined;
  }
  const resolved = path.isAbsolute(raw) ? raw : absoluteFromData(raw) ?? raw;
  if (!fs.existsSync(resolved)) {
    warnings.push(`music: file not found (${resolved}); rendering without background music`);
    return undefined;
  }
  let hasAudio = false;
  let durationMs = 0;
  try {
    const probe = await probeMedia(resolved);
    hasAudio = probe.hasAudio;
    durationMs = probe.durationMs;
  } catch (err) {
    warnings.push(`music: could not read ${path.basename(resolved)} (${(err as Error).message}); rendering without background music`);
    return undefined;
  }
  if (!hasAudio) {
    warnings.push(`music: ${path.basename(resolved)} has no audio stream; rendering without background music`);
    return undefined;
  }
  if (durationMs <= 0) {
    warnings.push(`music: ${path.basename(resolved)} has an unknown duration; rendering without background music`);
    return undefined;
  }
  const gain = clamp(finite(music.gain, DEFAULT_MUSIC_GAIN), 0, 1);
  const duck = music.duck !== false;
  return { path: resolved, gain, duck };
}

/** ffmpeg filter fragment for the music stream (format, gain). */
export function musicFilter(bed: MusicBed): string {
  return (
    `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
    `volume=${Math.round(bed.gain * 10000) / 10000}`
  );
}

/**
 * Ducking switch for `sidechaincompress`, keyed off the narration bus.
 * threshold is expressed as a dB suffix (`-25dB`) which ffmpeg's option parser
 * accepts for this filter.
 */
export function duckFilter(): string {
  return (
    `sidechaincompress=threshold=${DUCK_SETTINGS.threshold}:` +
    `ratio=${DUCK_SETTINGS.ratio}:attack=${DUCK_SETTINGS.attackMs}:` +
    `release=${DUCK_SETTINGS.releaseMs}:makeup=${DUCK_SETTINGS.makeup}`
  );
}
