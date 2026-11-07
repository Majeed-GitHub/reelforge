/**
 * ffmpeg / ffprobe plumbing for the Reelforge render stage.
 *
 * Binaries are resolved from (in order): explicit env override, the
 * `ffmpeg-static` / `ffprobe-static` npm packages, a `node_modules` walk-up,
 * and finally PATH. Nothing is ever installed at runtime.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Default wall-clock cap for a single media command (10 minutes). */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export type RunOptions = {
  cwd?: string;
  timeoutMs?: number;
  /** Cap on captured bytes per stream; extra output is discarded. */
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  /** Text written to the child's stdin (then closed). Used by `text2wave`. */
  input?: string;
};

export type RunResult = {
  bin: string;
  args: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

export type MediaProbe = {
  path: string;
  /** ISO duration in milliseconds (0 when unknown). */
  durationMs: number;
  width: number;
  height: number;
  /** Frames per second of the primary video stream (0 when unknown). */
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
  /** Size on disk in bytes (0 when unknown). */
  sizeBytes: number;
};

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isUsableBinary(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function exeName(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

function walkUpForModule(relPath: string, startDir: string = import.meta.dirname): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, relPath);
    if (isUsableBinary(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Search PATH for a bare executable name (no shell needed). */
function findOnPath(base: string): string | null {
  const name = exeName(base);
  const raw = process.env.PATH ?? process.env.Path ?? '';
  for (const entry of raw.split(path.delimiter)) {
    if (!entry) continue;
    const clean = entry.replace(/^"|"$/g, '');
    const candidate = path.join(clean, name);
    if (isUsableBinary(candidate)) return candidate;
  }
  return null;
}

/**
 * Locate an executable on PATH (platform aware: `.exe` on Windows).
 * Returns the absolute path or null. Cheap and synchronous - used by the TTS
 * provider probes, which must never throw.
 */
export function which(binary: string): string | null {
  return findOnPath(binary);
}

/** True when an executable exists on PATH. */
export function commandExists(binary: string): boolean {
  return findOnPath(binary) !== null;
}

let ffmpegCache: string | null = null;
let ffprobeCache: string | null = null;

function resolvePackageBinary(pkg: string, base: string): string | null {
  try {
    const exported = require(pkg) as unknown;
    const fromExport =
      typeof exported === 'string'
        ? exported
        : exported && typeof exported === 'object' && typeof (exported as { path?: unknown }).path === 'string'
          ? ((exported as { path: string }).path)
          : null;
    if (fromExport && isUsableBinary(fromExport)) return fromExport;
  } catch {
    // package not installed / not resolvable - fall through to the walk-up.
  }
  const arch = process.arch;
  const candidates = [
    path.join('node_modules', pkg, exeName(base)),
    path.join('node_modules', pkg, 'bin', process.platform, arch, exeName(base)),
    path.join('node_modules', pkg, 'bin', process.platform, exeName(base))
  ];
  for (const rel of candidates) {
    const found = walkUpForModule(rel);
    if (found) return found;
  }
  return null;
}

/** Absolute path to the ffmpeg binary. Throws with a useful message when absent. */
export function ffmpegPath(): string {
  if (ffmpegCache) return ffmpegCache;
  const envPath = process.env.REELFORGE_FFMPEG_PATH ?? process.env.FFMPEG_BIN ?? '';
  const resolved =
    (envPath && isUsableBinary(envPath) ? envPath : null) ??
    resolvePackageBinary('ffmpeg-static', 'ffmpeg') ??
    findOnPath('ffmpeg');
  if (!resolved) {
    throw new Error(
      'ffmpeg not found: install ffmpeg-static (root dependency) or set REELFORGE_FFMPEG_PATH.'
    );
  }
  ffmpegCache = resolved;
  return resolved;
}

/** Absolute path to the ffprobe binary. Throws with a useful message when absent. */
export function ffprobePath(): string {
  if (ffprobeCache) return ffprobeCache;
  const envPath = process.env.REELFORGE_FFPROBE_PATH ?? process.env.FFPROBE_BIN ?? '';
  const resolved =
    (envPath && isUsableBinary(envPath) ? envPath : null) ??
    resolvePackageBinary('ffprobe-static', 'ffprobe') ??
    findOnPath('ffprobe');
  if (!resolved) {
    throw new Error(
      'ffprobe not found: install ffprobe-static (root dependency) or set REELFORGE_FFPROBE_PATH.'
    );
  }
  ffprobeCache = resolved;
  return resolved;
}

/** Run any binary and capture stdout/stderr with a hard timeout. */
export function runBinary(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? 8 * 1024 * 1024;
  const started = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });

    if (opts.input !== undefined) {
      try {
        child.stdin?.end(opts.input, 'utf8');
      } catch {
        // the child may exit before reading stdin; the exit code tells the story
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, timeoutMs);

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= maxOutputBytes) return current;
      const next = current + chunk.toString('utf8');
      return next.length > maxOutputBytes ? next.slice(0, maxOutputBytes) : next;
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        bin,
        args,
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started
      });
    };

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to launch ${path.basename(bin)}: ${err.message}`));
    });
    child.on('close', finish);
  });
}

/** Run ffmpeg with the resolved binary. */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return runBinary(ffmpegPath(), args, opts);
}

/** Run ffprobe with the resolved binary. */
export function runFfprobe(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return runBinary(ffprobePath(), args, opts);
}

/** Last `n` characters of process output, for throwing/ logging. */
export function tailOutput(text: string, n: number = 4000): string {
  const trimmed = text.trim();
  return trimmed.length <= n ? trimmed : trimmed.slice(trimmed.length - n);
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split('/');
  const n = Number(num);
  const d = Number(den ?? '1');
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  const value = n / d;
  return Number.isFinite(value) ? value : 0;
}

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
};

type FfprobeFormat = {
  duration?: string;
  size?: string;
};

type FfprobeJson = {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
};

/** Probe a media file with ffprobe. Throws when the file is unreadable. */
export async function probeMedia(file: string): Promise<MediaProbe> {
  if (!isFile(file)) {
    throw new Error(`media file not found: ${file}`);
  }
  const res = await runFfprobe(
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeoutMs: 60_000 }
  );
  if (res.code !== 0) {
    throw new Error(`ffprobe failed (code ${res.code}) for ${file}: ${tailOutput(res.stderr, 1500)}`);
  }
  let parsed: FfprobeJson;
  try {
    parsed = JSON.parse(res.stdout) as FfprobeJson;
  } catch (err) {
    throw new Error(`ffprobe returned invalid JSON for ${file}: ${(err as Error).message}`);
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const durationSec = Number(parsed.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  const size = Number(parsed.format?.size ?? 0);
  const formatDurationMs = Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec * 1000) : 0;

  return {
    path: file,
    durationMs: formatDurationMs,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
    channels: typeof audio?.channels === 'number' ? audio.channels : undefined,
    sizeBytes: Number.isFinite(size) && size > 0 ? size : 0
  };
}

/** Resolve both binaries or throw a single descriptive error. */
export function requireMediaTools(): { ffmpeg: string; ffprobe: string } {
  return { ffmpeg: ffmpegPath(), ffprobe: ffprobePath() };
}
