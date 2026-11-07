/**
 * WebVTT captions: a mirror of the SRT the renderer already produces.
 *
 * Two ways in, because both are real:
 *
 *   buildVtt(lines)      same NarrationLine[] -> SRT path, re-emitted as WebVTT
 *   srtToVtt(srtText)    the *burned* SRT file converted verbatim, so the
 *                        exported captions can never drift from the video
 *
 * WebVTT differs from SRT in exactly the ways that bite downloads: a required
 * `WEBVTT` header, `HH:MM:SS.mmm` timestamps with a dot instead of a comma, and
 * blank-line separated cues. Cue identifiers are optional; we number them so a
 * player's cue list looks the same as the SRT.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { NarrationLine } from '../../core/src/types.ts';
import {
  DEFAULT_CAPTION_WIDTH,
  sanitizeCaptionText,
  wrapCaption,
  type CaptionBuildOptions
} from './captions.ts';

/** 3723000 ms -> 01:02:03.000 (WebVTT timestamp, dot not comma). */
export function vttTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

const VTT_HEADER = 'WEBVTT';

/**
 * Build a WebVTT document from narration lines. Timing rules mirror
 * `buildSrt` in captions.ts (minimum on-screen time, 40 ms cue gap, clamped to
 * the finished video) so the two caption files describe the same moments.
 */
export function buildVtt(lines: NarrationLine[], options: CaptionBuildOptions = {}): string {
  const startOffset = Math.max(0, options.startOffsetMs ?? 0);
  const minDisplay = Math.max(200, options.minDisplayMs ?? 900);
  const limit = options.totalDurationMs === undefined ? Number.POSITIVE_INFINITY : Math.max(0, options.totalDurationMs);
  const maxChars = options.maxLineChars ?? DEFAULT_CAPTION_WIDTH;

  const ordered = (Array.isArray(lines) ? lines : [])
    .filter((line) => line && sanitizeCaptionText(line.text).length > 0)
    .slice()
    .sort((a, b) => a.startMs - b.startMs);

  const cues: string[] = [];
  let cursor = 0;
  for (const line of ordered) {
    const start = Math.max(startOffset + Math.max(0, Math.round(line.startMs)), cursor);
    if (start >= limit) continue;
    const wanted = Math.max(minDisplay, Math.round(line.durationMs || 0));
    const end = Math.min(limit, Math.max(start + 400, start + wanted));
    if (end <= start) continue;
    cursor = end + 40; // small gap so cues visibly change
    cues.push(`${cues.length + 1}\n${vttTimestamp(start)} --> ${vttTimestamp(end)}\n${wrapCaption(line.text, maxChars)}`);
  }

  return `${VTT_HEADER}\n\n${cues.length > 0 ? `${cues.join('\n\n')}\n` : ''}`;
}

/** Write a `.vtt` file (directories created). Returns the cue count written. */
export function writeVtt(
  filePath: string,
  lines: NarrationLine[],
  options: CaptionBuildOptions = {}
): { path: string; count: number } {
  const vtt = buildVtt(lines, options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, vtt, 'utf8');
  const count = vtt.trim() === VTT_HEADER ? 0 : vtt.slice(VTT_HEADER.length).trim().split(/\n\n/).filter(Boolean).length;
  return { path: filePath, count };
}

const SRT_TIMING = /^(\d{1,2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}),(\d{3})(.*)$/;

/**
 * Convert an SRT document to WebVTT verbatim: timestamps keep their exact
 * values (commas become dots), cue text is untouched, cue numbers are dropped
 * (WebVTT treats them as optional identifiers; keeping them is also valid, but
 * dropping them keeps the header clean).
 */
export function srtToVtt(srt: string): string {
  const text = String(srt ?? '').replace(/\r\n?/g, '\n');
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const cues: string[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length === 0) continue;
    // Optional numeric cue index on the first line.
    const timingIndex = /^\d+$/.test(lines[0].trim()) && lines.length > 1 ? 1 : 0;
    const timing = lines[timingIndex].trim();
    const match = SRT_TIMING.exec(timing);
    if (!match) continue;
    const body = lines
      .slice(timingIndex + 1)
      .join('\n')
      .trim();
    if (!body) continue;
    cues.push(`${match[1]}.${match[2]} --> ${match[3]}.${match[4]}${match[5] ?? ''}\n${body}`);
  }

  return `${VTT_HEADER}\n\n${cues.length > 0 ? `${cues.join('\n\n')}\n` : ''}`;
}

/** read an SRT file and write its WebVTT equivalent next to it (or at `vttPath`). */
export function srtFileToVtt(
  srtPath: string,
  vttPath: string = srtPath.replace(/\.srt$/i, '.vtt')
): { path: string; count: number } {
  const vtt = srtToVtt(fs.readFileSync(srtPath, 'utf8'));
  fs.mkdirSync(path.dirname(vttPath), { recursive: true });
  fs.writeFileSync(vttPath, vtt, 'utf8');
  const count = vtt.trim() === VTT_HEADER ? 0 : vtt.slice(VTT_HEADER.length).trim().split(/\n\n/).filter(Boolean).length;
  return { path: vttPath, count };
}
