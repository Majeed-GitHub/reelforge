/**
 * Captions: NarrationLine[] -> SRT text / file.
 *
 * SRT is what the `subtitles` ffmpeg filter (libass) burns. Times are clamped to
 * the finished video so a late line cannot produce a caption past the last frame.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { NarrationLine } from '../../core/src/types.ts';

/** Longest single caption line before wrapping, in characters. */
export const DEFAULT_CAPTION_WIDTH = 76;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 3723000 ms -> 01:02:03,000 */
export function srtTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

/** Strip control characters that would confuse libass. */
export function sanitizeCaptionText(text: string): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Wrap a caption to at most `maxChars` per line (word-aware; hard-slices words
 * longer than the limit, and caps at three lines with an ellipsis).
 */
export function wrapCaption(text: string, maxChars: number = DEFAULT_CAPTION_WIDTH): string {
  const clean = sanitizeCaptionText(text);
  if (clean.length <= maxChars) return clean;
  const words = clean.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (word.length > maxChars) {
      // Hard-slice very long tokens (URLs, CJK runs without spaces).
      let rest = word;
      while (rest.length > maxChars) {
        lines.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      current = rest;
    } else {
      current = word;
    }
    if (lines.length >= 3) break;
  }
  if (current && lines.length < 3) lines.push(current);
  if (lines.length === 3 && words.join(' ').length > lines.join(' ').length + 1) {
    lines[2] = `${lines[2].replace(/[\s,.;:!?]+$/, '')}…`;
  }
  return lines.join('\n');
}

export type CaptionBuildOptions = {
  /** Minutes worth of padding before the first caption (rarely needed). */
  startOffsetMs?: number;
  /** Minimum on-screen time per caption. Default 900ms. */
  minDisplayMs?: number;
  /** Do not emit captions that start after this point. */
  totalDurationMs?: number;
  maxLineChars?: number;
};

/** Build the SRT body for a set of narration lines. */
export function buildSrt(lines: NarrationLine[], options: CaptionBuildOptions = {}): string {
  const startOffset = Math.max(0, options.startOffsetMs ?? 0);
  const minDisplay = Math.max(200, options.minDisplayMs ?? 900);
  const limit = options.totalDurationMs === undefined ? Number.POSITIVE_INFINITY : Math.max(0, options.totalDurationMs);
  const maxChars = options.maxLineChars ?? DEFAULT_CAPTION_WIDTH;

  const ordered = (Array.isArray(lines) ? lines : [])
    .filter((line) => line && sanitizeCaptionText(line.text).length > 0)
    .slice()
    .sort((a, b) => a.startMs - b.startMs);

  const blocks: string[] = [];
  let cursor = 0;
  for (const line of ordered) {
    const start = Math.max(startOffset + Math.max(0, Math.round(line.startMs)), cursor);
    if (start >= limit) continue;
    const wanted = Math.max(minDisplay, Math.round(line.durationMs || 0));
    const end = Math.min(limit, Math.max(start + 400, start + wanted));
    if (end <= start) continue;
    cursor = end + 40; // small gap so captions visibly change
    blocks.push(
      `${blocks.length + 1}\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\n${wrapCaption(line.text, maxChars)}\n`
    );
  }
  return blocks.join('\n');
}

/**
 * Write an SRT file. `filePath` is normally `<outDir>/captions.srt`; the
 * directory is created if needed. Returns the number of caption blocks written.
 */
export function writeSrt(filePath: string, lines: NarrationLine[], options: CaptionBuildOptions = {}): { path: string; count: number } {
  const srt = buildSrt(lines, options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, srt, 'utf8');
  const count = srt.length === 0 ? 0 : srt.trimEnd().split(/\n\n/).length;
  return { path: filePath, count };
}

/** Rough spoken length for a line when no audio was synthesised. */
export function estimateSpeechDurationMs(text: string): number {
  const clean = sanitizeCaptionText(text);
  if (!clean) return 0;
  const words = clean.split(/\s+/).filter(Boolean).length;
  const perWord = 380; // ~158 wpm
  const chars = clean.length;
  const byChars = Math.round(chars * 55); // fallback for languages without spaces
  const estimate = 320 + Math.max(words > 0 ? words * perWord : 0, byChars);
  return clamp(estimate, 900, 20_000);
}