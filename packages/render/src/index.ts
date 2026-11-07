/**
 * Reelforge render stage.
 *
 *   raw Playwright .webm + StepRecord[]
 *     -> TTS narration clips (per step, cross-platform provider chain)
 *     -> auto-zoom keyframe timeline (eased, clamped)
 *     -> time-scoped redaction blur (pre-camera, merged across contiguous steps)
 *     -> one ffmpeg pass: 2x upscale -> animated zoompan crop -> aspect reframe
 *        (blurred/darkened cover background) -> captions burn -> watermark
 *        -> narration + optional music bed (sidechain-ducked) -> H.264/yuv420p/+faststart
 *     -> MP4 + SRT + poster PNG
 *
 * Degrades gracefully: no TTS provider (silent + captions), no steps (full
 * frame, no captions/zoom), missing/short capture video (plain background or
 * frozen last frame), unreadable music (warning, no music), no watermark font
 * (warning, watermark skipped).
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  AspectRatio,
  Box,
  CaptureResult,
  MusicOptions,
  NarrationLine,
  Point,
  RenderInput,
  RenderOptions,
  RenderResult,
  StepRecord
} from '../../core/src/types.ts';
import { PATHS, VIEWPORT } from '../../core/src/config.ts';
import { probeMedia, runFfmpeg, tailOutput, type MediaProbe } from './ffmpeg.ts';
import { estimateSpeechDurationMs, sanitizeCaptionText, writeSrt } from './captions.ts';
import { buildZoomTimeline, buildZoompanFilter, DEFAULT_ZOOM_STRENGTH, type Viewport } from './zoom.ts';
import { isTtsProviderToken, synthesizeNarration, type TtsClip } from './tts.ts';
import { buildReframeChains, isAspectRatio, resolveAspectLayout, type AspectLayout, DEFAULT_ASPECT } from './aspect.ts';
import { buildRedactionChains, planRedactionWindows, type RedactionBox, type RedactionWindow } from './redactions.ts';
import { duckFilter, musicFilter, resolveMusicBed, type MusicBed } from './music.ts';

export * from './ffmpeg.ts';
export * from './captions.ts';
export * from './zoom.ts';
export * from './tts.ts';
export * from './aspect.ts';
export * from './redactions.ts';
export * from './music.ts';

const DEFAULT_FPS = 30;
const DEFAULT_SCALE_HEIGHT = 720;
const DEFAULT_LANGUAGE = 'en';
const RENDER_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_DURATION_MS = 30 * 60 * 1000;
const AUDIO_GAP_MS = 120;
const TAIL_PADDING_MS = 400;

type ResolvedRenderOptions = {
  fps: number;
  scaleHeight: number;
  width: number;
  height: number;
  watermark: boolean;
  watermarkText: string;
  language: string;
  voice?: string;
  zoom: number;
  aspect: AspectRatio;
  layout: AspectLayout;
  music?: MusicOptions;
  redactions: RedactionBox[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeEven(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function seconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

function normalizeOptions(options: Partial<RenderOptions> | undefined): ResolvedRenderOptions {
  const scaleHeight = makeEven(clamp(finiteNumber(options?.scaleHeight, DEFAULT_SCALE_HEIGHT), 120, 2160));
  const fps = Math.round(clamp(finiteNumber(options?.fps, DEFAULT_FPS), 10, 60));
  const zoom = clamp(finiteNumber(options?.zoom, DEFAULT_ZOOM_STRENGTH), 1, 3);
  const voice = typeof options?.voice === 'string' && options.voice.trim() ? options.voice.trim() : undefined;
  const watermarkText =
    typeof options?.watermarkText === 'string' && options.watermarkText.trim()
      ? options.watermarkText.trim()
      : 'Reelforge';
  const language =
    typeof options?.language === 'string' && options.language.trim() ? options.language.trim() : DEFAULT_LANGUAGE;
  const aspect = isAspectRatio(options?.aspect) ? options.aspect : DEFAULT_ASPECT;
  const layout = resolveAspectLayout(aspect, scaleHeight);
  const redactions = Array.isArray(options?.redactions)
    ? (options.redactions as RedactionBox[]).filter((entry) => Boolean(entry) && Number.isFinite(entry.stepIndex))
    : [];
  return {
    fps,
    scaleHeight,
    width: layout.width,
    height: layout.height,
    watermark: options?.watermark !== false,
    watermarkText,
    language,
    voice,
    zoom,
    aspect,
    layout,
    music: options?.music,
    redactions
  };
}

function normalizeViewport(viewport: CaptureResult['viewport'] | undefined): Viewport {
  const width = finiteNumber(viewport?.width, VIEWPORT.width);
  const height = finiteNumber(viewport?.height, VIEWPORT.height);
  if (width < 16 || height < 16) return { width: VIEWPORT.width, height: VIEWPORT.height };
  return { width, height };
}

function normalizeBox(box: Box | undefined): Box | undefined {
  if (!box) return undefined;
  const x = finiteNumber(box.x, Number.NaN);
  const y = finiteNumber(box.y, Number.NaN);
  const width = finiteNumber(box.width, Number.NaN);
  const height = finiteNumber(box.height, Number.NaN);
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function normalizePoint(point: Point | undefined): Point | undefined {
  if (!point) return undefined;
  const x = finiteNumber(point.x, Number.NaN);
  const y = finiteNumber(point.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x, y };
}

function normalizeSteps(steps: StepRecord[] | undefined): StepRecord[] {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((step): step is StepRecord => Boolean(step) && typeof step === 'object')
    .map((step, index) => ({
      ...step,
      index: Number.isFinite(step.index) ? step.index : index,
      narration: typeof step.narration === 'string' ? step.narration : '',
      startedAtMs: Math.max(0, Math.round(finiteNumber(step.startedAtMs, 0))),
      endedAtMs: Math.max(0, Math.round(finiteNumber(step.endedAtMs, finiteNumber(step.startedAtMs, 0)))),
      box: normalizeBox(step.box),
      point: normalizePoint(step.point)
    }))
    .sort((a, b) => a.startedAtMs - b.startedAtMs || a.index - b.index);
}

/** Escape a path for use inside an ffmpeg filter option value. */
function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function windowsFontsDir(): string | null {
  if (process.platform !== 'win32') return null;
  const dir = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts');
  try {
    if (fs.statSync(dir).isDirectory()) return dir;
  } catch {
    return null;
  }
  return null;
}

function findWatermarkFont(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'arialbd.ttf'),
          path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'arial.ttf'),
          path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'segoeuib.ttf'),
          path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'segoeui.ttf')
        ]
      : process.platform === 'darwin'
        ? ['/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial.ttf']
        : [
            '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
          ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function hasNonLatinScript(text: string): boolean {
  return /[^\u0000-\u024f\u1e00-\u1eff\u2000-\u206f]/.test(text);
}

type ClipLine = {
  text: string;
  startMs: number;
  durationMs: number;
  audioPath?: string;
};

function buildNarrationTimeline(
  steps: StepRecord[],
  clips: TtsClip[]
): { lines: NarrationLine[]; clipLines: ClipLine[]; warnings: string[] } {
  const warnings: string[] = [];
  const clipByStep = new Map<number, TtsClip>();
  const duplicateCounts = new Map<number, number>();
  for (const clip of clips) {
    const seen = duplicateCounts.get(clip.stepIndex) ?? 0;
    duplicateCounts.set(clip.stepIndex, seen + 1);
    if (seen === 0) clipByStep.set(clip.stepIndex, clip);
  }

  const lines: NarrationLine[] = [];
  const clipLines: ClipLine[] = [];
  let cursor = 0;
  for (const step of steps) {
    const text = sanitizeCaptionText(step.narration);
    if (!text) continue;
    const clip = clipByStep.get(step.index);
    const durationMs = clip ? Math.max(300, clip.durationMs) : estimateSpeechDurationMs(text);
    const startMs = Math.max(step.startedAtMs, cursor);
    cursor = startMs + durationMs + AUDIO_GAP_MS;
    lines.push({
      stepIndex: step.index,
      text,
      startMs,
      durationMs,
      audioPath: clip?.audioPath
    });
    clipLines.push({ text, startMs, durationMs, audioPath: clip?.audioPath });
  }

  if (hasNonLatinScript(lines.map((line) => line.text).join(' '))) {
    warnings.push(
      'captions: non-Latin text detected; the burned-in font may lack glyphs for this language (install a matching system font)'
    );
  }
  return { lines, clipLines, warnings };
}

type Variant = { subtitles: boolean; watermark: boolean };

type RenderAttempt = {
  /** Extra video padding (ms) needed beyond the source duration. */
  padMs: number;
  subtitlesPath?: string;
  watermarkFont?: string;
  watermarkTextPath?: string;
  clipInputs: { audioPath: string; startMs: number }[];
  durationMs: number;
  viewport: Viewport;
  sourceSize: Viewport;
  zoomFilter: string;
  fps: number;
  width: number;
  height: number;
  layout: AspectLayout;
  redactionWindows: RedactionWindow[];
  music?: { inputIndex: number; bed: MusicBed };
};

function buildVideoChains(attempt: RenderAttempt, variant: Variant): string[] {
  const chains: string[] = [];
  let label = '0:v';

  // Redaction blur first, in source/viewport space: the camera then pans and
  // zooms the already-masked pixels, and social backgrounds never contain them.
  const redactions = buildRedactionChains(attempt.redactionWindows, attempt.viewport, attempt.sourceSize, label);
  if (redactions.chains.length > 0) {
    chains.push(...redactions.chains);
    label = redactions.outputLabel;
  }

  chains.push(`[${label}]${attempt.zoomFilter}[cam]`);
  let videoLabel = 'cam';

  if (attempt.padMs > 40) {
    // zoompan emits a non-monotonic/terminal PTS that makes tpad stop early;
    // normalise the timeline first so the frozen tail actually appears.
    chains.push(`[cam]setpts=N/(${attempt.fps}*TB)[camPts]`);
    chains.push(`[camPts]tpad=stop_mode=clone:stop_duration=${seconds(attempt.padMs)}[camPad]`);
    videoLabel = 'camPad';
  }

  if (!attempt.layout.native) {
    chains.push(...buildReframeChains(attempt.layout, videoLabel));
    videoLabel = 'framed';
  }

  const overlays: string[] = [];
  if (variant.subtitles && attempt.subtitlesPath) {
    const srtName = path.basename(attempt.subtitlesPath).replace(/\\/g, '/').replace(/:/g, '\\:');
    const fontDir = windowsFontsDir();
    const fontSize = Math.round(clamp(attempt.height * 0.028, 14, 64));
    const marginV = Math.round(clamp(attempt.height * 0.045, 16, 160));
    const style = [
      'FontName=Arial',
      `FontSize=${fontSize}`,
      'PrimaryColour=&H00FFFFFF',
      'OutlineColour=&H00000000',
      'BorderStyle=1',
      'Outline=1',
      'Shadow=0',
      `MarginV=${marginV}`,
      'Alignment=2'
    ].join(',');
    const fontsDirPart = fontDir ? `:fontsdir='${escapeFilterPath(fontDir)}'` : '';
    overlays.push(`subtitles=filename='${srtName}'${fontsDirPart}:force_style='${style}'`);
  }

  if (variant.watermark && attempt.watermarkFont && attempt.watermarkTextPath) {
    const textName = path.basename(attempt.watermarkTextPath);
    const fontSize = Math.round(clamp(attempt.height * 0.036, 16, 84));
    const pad = Math.round(clamp(attempt.height * 0.03, 10, 120));
    overlays.push(
      'drawtext=' +
        `fontfile='${escapeFilterPath(attempt.watermarkFont)}':` +
        `textfile='${textName}':` +
        'fontcolor=white@0.9:' +
        `fontsize=${fontSize}:` +
        'box=1:boxcolor=black@0.35:' +
        `boxborderw=${Math.round(fontSize * 0.35)}:` +
        `x=w-tw-${pad}:y=h-th-${pad}`
    );
  }

  // `null` keeps the graph shape stable (and is a no-op) when nothing is burned in.
  chains.push(`[${videoLabel}]${overlays.length > 0 ? overlays.join(',') : 'null'}[vout]`);
  return chains;
}

function buildAudioChains(attempt: RenderAttempt): { chains: string[]; hasAudio: boolean } {
  const chains: string[] = [];
  const narrationLabel = 'nar';
  const musicLabel = 'mus';
  const trim = `apad,atrim=start=0:duration=${seconds(attempt.durationMs)},asetpts=PTS-STARTPTS[aout]`;

  let hasNarration = false;
  if (attempt.clipInputs.length > 0) {
    hasNarration = true;
    const labels: string[] = [];
    attempt.clipInputs.forEach((clip, index) => {
      const inputIndex = index + 1;
      const label = `a${index}`;
      const delay = Math.max(0, Math.round(clip.startMs));
      chains.push(
        `[${inputIndex}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
          `adelay=${delay}:all=1,volume=1.0[${label}]`
      );
      labels.push(`[${label}]`);
    });
    if (labels.length === 1) chains.push(`${labels[0]}anull[${narrationLabel}]`);
    else chains.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0[${narrationLabel}]`);
  }

  let hasMusic = false;
  if (attempt.music) {
    hasMusic = true;
    chains.push(`[${attempt.music.inputIndex}:a]${musicFilter(attempt.music.bed)}[${musicLabel}]`);
  }

  if (hasNarration && hasMusic) {
    if (attempt.music && attempt.music.bed.duck) {
      chains.push(`[${narrationLabel}]asplit=2[narMix][duckKey]`);
      chains.push(`[${musicLabel}][duckKey]${duckFilter()}[musDuck]`);
      chains.push(`[narMix][musDuck]amix=inputs=2:duration=longest:normalize=0,${trim}`);
    } else {
      chains.push(`[${narrationLabel}][${musicLabel}]amix=inputs=2:duration=longest:normalize=0,${trim}`);
    }
  } else if (hasNarration) {
    chains.push(`[${narrationLabel}]${trim}`);
  } else if (hasMusic) {
    chains.push(`[${musicLabel}]apad,atrim=start=0:duration=${seconds(attempt.durationMs)},asetpts=PTS-STARTPTS[aout]`);
  }

  return { chains, hasAudio: hasNarration || hasMusic };
}

function buildFilterScript(attempt: RenderAttempt, variant: Variant): { script: string; hasAudio: boolean } {
  const video = buildVideoChains(attempt, variant);
  const audio = buildAudioChains(attempt);
  return { script: [...video, ...audio.chains].join(';\n'), hasAudio: audio.hasAudio };
}

async function probeOrNull(file: string, warnings: string[]): Promise<MediaProbe | null> {
  try {
    return await probeMedia(file);
  } catch (err) {
    warnings.push(`render: could not probe ${path.basename(file)} (${(err as Error).message})`);
    return null;
  }
}

async function extractPoster(videoPath: string, posterPath: string, durationMs: number, warnings: string[]): Promise<string | undefined> {
  const atMs = clamp(durationMs / 2, 0, Math.max(0, durationMs - 200));
  const attempts: string[][] = [
    ['-hide_banner', '-loglevel', 'error', '-y', '-ss', seconds(atMs), '-i', videoPath, '-frames:v', '1', '-q:v', '2', posterPath],
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-frames:v', '1', '-q:v', '2', posterPath]
  ];
  for (const args of attempts) {
    const res = await runFfmpeg(args, { timeoutMs: 60_000 });
    if (res.code === 0) {
      try {
        if (fs.statSync(posterPath).size > 0) return posterPath;
      } catch {
        // try the next strategy
      }
    }
  }
  warnings.push('render: could not extract a poster frame');
  return undefined;
}

/**
 * Render a finished, narrated MP4 from a Playwright capture.
 * Writes MP4 (+ SRT, poster PNG) and returns what was produced.
 */
export async function renderDemo(input: RenderInput): Promise<RenderResult> {
  if (!input || typeof input !== 'object') throw new Error('renderDemo: an input object is required');
  const warnings: string[] = [];
  const outDir = path.resolve(input.outDir || PATHS.exports);
  fs.mkdirSync(outDir, { recursive: true });
  const outputPath = path.resolve(input.outputPath || path.join(outDir, 'demo.mp4'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const options = normalizeOptions(input.options);
  const capture = input.capture ?? ({ steps: [] } as unknown as CaptureResult);
  const steps = normalizeSteps(input.steps?.length ? input.steps : capture.steps);
  const viewport = normalizeViewport(capture.viewport);
  const language = options.language;
  const zoomStrength = options.zoom;

  if (steps.length === 0) {
    warnings.push('render: no steps recorded; rendering the full frame with no auto-zoom or captions');
  }
  const hasZoomTarget = steps.some((step) => Boolean(step.box || step.point));
  if (!hasZoomTarget && zoomStrength > 1.001) {
    warnings.push('render: no element boxes or points were recorded; auto-zoom will stay at full frame');
  }

  // ---- 1. Narrate each step -------------------------------------------------
  const voiceToken = options.voice ?? '';
  const providerOverride = voiceToken && isTtsProviderToken(voiceToken) ? voiceToken : undefined;
  const voiceName = providerOverride ? undefined : voiceToken || undefined;

  const narrationRequests = steps
    .filter((step) => sanitizeCaptionText(step.narration).length > 0)
    .map((step) => ({
      stepIndex: step.index,
      text: sanitizeCaptionText(step.narration),
      startMs: step.startedAtMs
    }));

  const tts = await synthesizeNarration(narrationRequests, {
    provider: providerOverride,
    voice: voiceName,
    language,
    outDir,
    timeoutMs: 180_000
  });
  warnings.push(...tts.warnings);

  const { lines, clipLines, warnings: narrationWarnings } = buildNarrationTimeline(steps, tts.clips);
  warnings.push(...narrationWarnings);
  const clipLinesWithAudio = clipLines.filter((line) => Boolean(line.audioPath));

  // ---- 2. Capture source / duration ----------------------------------------
  const capturedVideo = typeof capture.videoPath === 'string' ? capture.videoPath : '';
  const sourceExists = Boolean(capturedVideo) && fs.existsSync(capturedVideo);
  const sourceProbe = sourceExists ? await probeOrNull(capturedVideo, warnings) : null;
  const useLavfi = !sourceProbe || !sourceProbe.hasVideo;
  if (useLavfi) {
    warnings.push(
      sourceExists
        ? 'render: capture video unreadable (no video stream); rendering on a plain background'
        : 'render: capture video missing; rendering on a plain background'
    );
  }

  const sourceSize: Viewport = useLavfi
    ? { width: viewport.width, height: viewport.height }
    : { width: sourceProbe!.width || viewport.width, height: sourceProbe!.height || viewport.height };
  const sourceDurationMs = useLavfi ? 0 : sourceProbe!.durationMs;
  const stepEndMs = steps.reduce((max, step) => Math.max(max, step.endedAtMs), 0);
  const narrationEndMs = lines.reduce((max, line) => Math.max(max, line.startMs + line.durationMs), 0);
  const durationKnown = useLavfi || sourceDurationMs > 0;

  let finalDurationMs: number;
  let padMs = 0;
  if (useLavfi) {
    finalDurationMs = Math.max(narrationEndMs + TAIL_PADDING_MS, 3000);
  } else if (durationKnown) {
    finalDurationMs = Math.max(sourceDurationMs, narrationEndMs + TAIL_PADDING_MS, 1500);
    padMs = Math.max(0, finalDurationMs - sourceDurationMs);
  } else {
    // Playwright WebM can lack duration metadata; bound the output by step timings
    // and let the video stream end naturally (no -t truncation).
    warnings.push(
      'render: capture duration could not be probed; bounding the output with step timings instead of the video duration'
    );
    finalDurationMs = Math.max(stepEndMs + 800, narrationEndMs + TAIL_PADDING_MS, 1500);
  }
  finalDurationMs = Math.min(finalDurationMs, MAX_DURATION_MS);

  if (!useLavfi && durationKnown && stepEndMs > sourceDurationMs + 200) {
    warnings.push(
      `render: capture video ends at ${(sourceDurationMs / 1000).toFixed(2)}s but the last step ends at ` +
        `${(stepEndMs / 1000).toFixed(2)}s; freezing the last frame to fit`
    );
  }
  if (!useLavfi && sourceDurationMs > 0 && sourceDurationMs < 1200) {
    warnings.push(`render: capture video is very short (${sourceDurationMs}ms); output will be padded with a frozen frame`);
  }
  if (!useLavfi && durationKnown && narrationEndMs + TAIL_PADDING_MS > sourceDurationMs && narrationEndMs > 0) {
    warnings.push('render: narration runs past the end of the capture; the last frame is frozen to cover it');
  }

  // ---- 3. Captions ----------------------------------------------------------
  let srtPath: string | undefined;
  if (lines.length > 0) {
    const srtFile = path.join(outDir, 'captions.srt');
    try {
      const written = writeSrt(srtFile, lines, { totalDurationMs: finalDurationMs });
      if (written.count > 0) srtPath = written.path;
      else warnings.push('captions: nothing to burn; skipping subtitles');
    } catch (err) {
      warnings.push(`captions: could not write SRT (${(err as Error).message}); rendering without captions`);
    }
  }

  // ---- 4. Watermark ---------------------------------------------------------
  let watermarkFont: string | undefined;
  let watermarkTextPath: string | undefined;
  if (options.watermark) {
    const font = findWatermarkFont();
    if (!font) {
      warnings.push('render: no usable font found for the watermark; skipping it');
    } else {
      watermarkFont = font;
      watermarkTextPath = path.join(outDir, 'watermark.txt');
      try {
        fs.writeFileSync(watermarkTextPath, options.watermarkText, 'utf8');
      } catch (err) {
        warnings.push(`render: could not write watermark text (${(err as Error).message}); skipping watermark`);
        watermarkFont = undefined;
        watermarkTextPath = undefined;
      }
    }
  }

  // ---- 5. Redactions + music ------------------------------------------------
  const allRedactions: RedactionBox[] = [
    ...(Array.isArray(capture.redactions) ? (capture.redactions as RedactionBox[]) : []),
    ...options.redactions
  ];
  const redactionWindows = allRedactions.length > 0
    ? planRedactionWindows(allRedactions, steps, viewport, finalDurationMs, warnings)
    : [];
  const musicBed = await resolveMusicBed(options.music, warnings);

  // ---- 6. Zoom camera + video filter program -------------------------------
  const keyframes = buildZoomTimeline(steps, viewport, { strength: zoomStrength });
  const zoomFilter = buildZoompanFilter(keyframes, viewport, {
    outWidth: options.layout.camWidth,
    outHeight: options.layout.camHeight,
    fps: options.fps,
    upscale: 2
  });

  // ---- 7. Render ------------------------------------------------------------
  const inputArgs: string[] = [];
  if (useLavfi) {
    inputArgs.push(
      '-f',
      'lavfi',
      '-i',
      `color=c=0x0b1220:s=${viewport.width}x${viewport.height}:r=${options.fps}:d=${seconds(finalDurationMs)}`
    );
  } else {
    inputArgs.push('-i', capturedVideo);
  }
  for (const line of clipLinesWithAudio) inputArgs.push('-i', line.audioPath as string);
  if (musicBed) inputArgs.push('-stream_loop', '-1', '-i', musicBed.path);

  const attempt: RenderAttempt = {
    padMs,
    subtitlesPath: srtPath,
    watermarkFont,
    watermarkTextPath,
    clipInputs: clipLinesWithAudio.map((line) => ({ audioPath: line.audioPath as string, startMs: line.startMs })),
    durationMs: finalDurationMs,
    viewport,
    sourceSize,
    zoomFilter,
    fps: options.fps,
    width: options.width,
    height: options.height,
    layout: options.layout,
    redactionWindows,
    music: musicBed
      ? { inputIndex: clipLinesWithAudio.length + 1, bed: musicBed }
      : undefined
  };

  const variants: Variant[] = [{ subtitles: Boolean(srtPath), watermark: Boolean(watermarkFont) }];
  if (srtPath) variants.push({ subtitles: false, watermark: Boolean(watermarkFont) });
  if (watermarkFont) variants.push({ subtitles: false, watermark: false });

  const filterScriptPath = path.join(outDir, 'render.filters.txt');
  const preset = process.env.REELFORGE_FFMPEG_PRESET ?? 'veryfast';
  const crf = process.env.REELFORGE_FFMPEG_CRF ?? '21';
  let lastFailure = '';
  let rendered = false;
  let hasAudio = false;

  for (const [index, variant] of variants.entries()) {
    const built = buildFilterScript(attempt, variant);
    hasAudio = built.hasAudio;
    fs.writeFileSync(filterScriptPath, built.script, 'utf8');
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-y',
      ...inputArgs,
      '-filter_complex_script',
      filterScriptPath,
      '-map',
      '[vout]',
      ...(hasAudio ? ['-map', '[aout]'] : []),
      '-c:v',
      'libx264',
      '-preset',
      preset,
      '-crf',
      crf,
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(options.fps),
      ...(durationKnown ? ['-t', seconds(finalDurationMs)] : []),
      ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'] : ['-an']),
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      outputPath
    ];
    const res = await runFfmpeg(args, { cwd: outDir, timeoutMs: RENDER_TIMEOUT_MS });
    if (res.code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      if (index > 0) {
        if (!variant.subtitles && srtPath) warnings.push('render: caption burn failed; retried without burned-in captions');
        if (!variant.watermark) warnings.push('render: watermark failed; retried without the watermark');
      }
      rendered = true;
      break;
    }
    lastFailure = tailOutput(res.stderr, 4000) || `ffmpeg exited with code ${res.code}`;
    if (res.timedOut) {
      lastFailure = `ffmpeg timed out after ${Math.round(RENDER_TIMEOUT_MS / 1000)}s`;
      break;
    }
  }

  if (!rendered) {
    throw new Error(`render: ffmpeg failed (${path.basename(outputPath)}): ${lastFailure}`);
  }

  // ---- 8. Verify + poster ---------------------------------------------------
  const outputProbe = await probeMedia(outputPath).catch((err: Error) => {
    warnings.push(`render: could not probe the finished MP4 (${err.message})`);
    return null;
  });

  let durationMs = finalDurationMs;
  if (outputProbe && outputProbe.durationMs > 0) {
    durationMs = outputProbe.durationMs;
    if (Math.abs(durationMs - finalDurationMs) > 700) {
      warnings.push(
        `render: finished duration ${(durationMs / 1000).toFixed(2)}s differs from the planned ` +
          `${(finalDurationMs / 1000).toFixed(2)}s`
      );
    }
  }
  if (outputProbe && (outputProbe.width !== options.width || outputProbe.height !== options.height)) {
    warnings.push(
      `render: finished dimensions ${outputProbe.width}x${outputProbe.height} differ from the requested ` +
        `${options.width}x${options.height}`
    );
  }
  if (hasAudio && outputProbe && !outputProbe.hasAudio) {
    warnings.push('render: narration/music audio was synthesized but the finished MP4 has no audio stream');
  }

  const posterPath = await extractPoster(outputPath, path.join(outDir, 'poster.png'), durationMs, warnings);

  for (const key of ['render.filters.txt', 'watermark.txt']) {
    if (process.env.REELFORGE_KEEP_FILTERS === '1') break;
    try {
      fs.rmSync(path.join(outDir, key), { force: true });
    } catch {
      // non-fatal cleanup
    }
  }

  return {
    videoPath: outputPath,
    posterPath,
    durationMs,
    width: outputProbe?.width || options.width,
    height: outputProbe?.height || options.height,
    lines,
    srtPath,
    warnings
  };
}

export default renderDemo;
