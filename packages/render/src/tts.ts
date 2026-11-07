/**
 * Narration synthesis, offline-first.
 *
 * Provider chain (`auto`): OpenAI (OPENAI_API_KEY) -> edge-tts (python module)
 * -> Windows SAPI via PowerShell System.Speech -> none (silent, captions only).
 *
 * Windows SAPI needs no packages: PowerShell's System.Speech writes a WAV per
 * line, using a voice that matches the requested language when one is
 * installed, falling back to Microsoft David/Zira Desktop.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TTS } from '../../core/src/config.ts';
import { probeMedia, runBinary } from './ffmpeg.ts';
import { estimateSpeechDurationMs } from './captions.ts';

export type TtsProvider = 'sapi' | 'openai' | 'edge' | 'none';

export type NarrationRequest = {
  stepIndex: number;
  text: string;
  /** Desired start offset in the finished video, ms. */
  startMs: number;
};

export type TtsClip = {
  stepIndex: number;
  text: string;
  startMs: number;
  audioPath: string;
  durationMs: number;
};

export type TtsOptions = {
  /** Provider override: auto | sapi | openai | edge | none (or a voice name). */
  provider?: string;
  /** Language hint, e.g. "en", "es-ES". */
  language?: string;
  /** Voice name override (provider specific). */
  voice?: string;
  /** Directory to write audio clips into. Created if missing. */
  outDir: string;
  timeoutMs?: number;
};

export type TtsResult = {
  provider: TtsProvider;
  clips: TtsClip[];
  warnings: string[];
};

export const KNOWN_TTS_PROVIDERS: readonly (TtsProvider | 'auto')[] = ['auto', 'sapi', 'openai', 'edge', 'none'] as const;

const OPENAI_VOICES = new Set([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'cedar'
]);

const EDGE_VOICE_BY_LANGUAGE: Record<string, string> = {
  en: 'en-US-AriaNeural',
  es: 'es-ES-ElviraNeural',
  fr: 'fr-FR-DeniseNeural',
  de: 'de-DE-KatjaNeural',
  it: 'it-IT-ElsaNeural',
  pt: 'pt-BR-FranciscaNeural',
  nl: 'nl-NL-ColetteNeural',
  hi: 'hi-IN-SwaraNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  ar: 'ar-SA-ZariyahNeural',
  ru: 'ru-RU-SvetlanaNeural',
  tr: 'tr-TR-EmelNeural',
  pl: 'pl-PL-ZofiaNeural',
  sv: 'sv-SE-SofieNeural',
  da: 'da-DK-ChristelNeural',
  fi: 'fi-FI-NooraNeural',
  no: 'nb-NO-PernilleNeural'
};

function normalizeProvider(value: string | undefined): TtsProvider | 'auto' | null {
  const token = String(value ?? '').trim().toLowerCase();
  if (!token) return null;
  if (token === 'auto') return 'auto';
  if (token === 'sapi' || token === 'windows' || token === 'system.speech') return 'sapi';
  if (token === 'openai' || token === 'gpt-tts') return 'openai';
  if (token === 'edge' || token === 'edge-tts' || token === 'edgetts') return 'edge';
  if (token === 'none' || token === 'off' || token === 'silent') return 'none';
  return null;
}

/** True when a string names a TTS provider (auto/sapi/openai/edge/none). */
export function isTtsProviderToken(value: string | undefined): boolean {
  return normalizeProvider(value) !== null;
}

function languageBase(language: string | undefined): string {
  const token = String(language ?? 'en').trim().toLowerCase().replace('_', '-');
  return (token.split('-')[0] || 'en').toLowerCase();
}

function isEdgeVoiceName(voice: string): boolean {
  return /^[a-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z]+Neural$/.test(voice.trim());
}

// ---------------------------------------------------------------------------
// Windows SAPI (PowerShell System.Speech)
// ---------------------------------------------------------------------------

const SAPI_SCRIPT = String.raw`
param(
  [string]$Out,
  [string]$Text,
  [string]$Voice,
  [switch]$ListVoices
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($ListVoices) {
    foreach ($v in $synth.GetInstalledVoices()) {
      if ($v.Enabled) {
        [Console]::Out.WriteLine($v.VoiceInfo.Name + '|' + $v.VoiceInfo.Culture.Name + '|' + $v.VoiceInfo.Gender)
      }
    }
    exit 0
  }
  if (-not $Out) { [Console]::Error.WriteLine('sapi:missing-out'); exit 2 }
  if ($Voice) {
    $match = $null
    foreach ($v in $synth.GetInstalledVoices()) {
      if ($v.VoiceInfo.Name -eq $Voice) { $match = $v.VoiceInfo.Name; break }
    }
    if (-not $match) {
      foreach ($v in $synth.GetInstalledVoices()) {
        if ($v.VoiceInfo.Name -like ('*' + $Voice + '*')) { $match = $v.VoiceInfo.Name; break }
      }
    }
    if (-not $match) { [Console]::Error.WriteLine('sapi:voice-not-found:' + $Voice); exit 3 }
    $synth.SelectVoice($match)
  }
  $synth.SetOutputToWaveFile($Out)
  $synth.Speak($Text)
  [Console]::Out.WriteLine('ok')
} finally {
  $synth.Dispose()
}
`;

export type SapiVoice = { name: string; culture: string; gender: string };

let sapiVoicesPromise: Promise<SapiVoice[]> | null = null;
let sapiScriptPath: string | null = null;
let sapiPowerShell: string | null = null;

function powershellExecutable(): string {
  if (sapiPowerShell) return sapiPowerShell;
  // powershell.exe (Windows PowerShell 5.1) ships System.Speech; pwsh 7 may not.
  sapiPowerShell = 'powershell.exe';
  return sapiPowerShell;
}

function ensureSapiScript(workDir: string): string {
  if (sapiScriptPath && fs.existsSync(sapiScriptPath)) return sapiScriptPath;
  fs.mkdirSync(workDir, { recursive: true });
  const file = path.join(workDir, 'reelforge-sapi.ps1');
  fs.writeFileSync(file, SAPI_SCRIPT, 'utf8');
  sapiScriptPath = file;
  return file;
}

/** Probe installed SAPI voices (cached). Returns [] when SAPI is unavailable. */
export function probeSapiVoices(workDir: string): Promise<SapiVoice[]> {
  if (sapiVoicesPromise) return sapiVoicesPromise;
  sapiVoicesPromise = (async () => {
    if (process.platform !== 'win32') return [];
    try {
      const script = ensureSapiScript(workDir);
      const res = await runBinary(
        powershellExecutable(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ListVoices'],
        { timeoutMs: 20_000 }
      );
      if (res.code !== 0) return [];
      return res.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, culture, gender] = line.split('|');
          return { name: name ?? '', culture: culture ?? '', gender: gender ?? '' };
        })
        .filter((voice) => voice.name.length > 0);
    } catch {
      return [];
    }
  })();
  return sapiVoicesPromise;
}

function pickSapiVoice(voices: SapiVoice[], requested: string | undefined, language: string | undefined): SapiVoice | null {
  if (voices.length === 0) return null;
  const wanted = (requested ?? '').trim().toLowerCase();
  if (wanted) {
    const exact = voices.find((v) => v.name.toLowerCase() === wanted);
    if (exact) return exact;
    const fuzzy = voices.find((v) => v.name.toLowerCase().includes(wanted));
    if (fuzzy) return fuzzy;
  }
  const base = languageBase(language);
  const byLanguage = voices.filter((v) => v.culture.toLowerCase().startsWith(base));
  const pool = byLanguage.length > 0 ? byLanguage : voices.filter((v) => v.culture.toLowerCase().startsWith('en')) || voices;
  const candidates = pool.length > 0 ? pool : voices;
  const preferred =
    candidates.find((v) => /zira|aria|jenny|female/i.test(v.name)) ??
    candidates.find((v) => /female/i.test(v.gender)) ??
    candidates.find((v) => /david|mark|guy/i.test(v.name)) ??
    candidates[0];
  return preferred ?? null;
}

async function sapiSynthesize(
  requests: NarrationRequest[],
  outDir: string,
  options: TtsOptions,
  warnings: string[]
): Promise<TtsClip[]> {
  const workDir = path.join(outDir, 'tts');
  fs.mkdirSync(workDir, { recursive: true });
  const voices = await probeSapiVoices(workDir);
  if (voices.length === 0) {
    warnings.push('sapi: no Windows System.Speech voices found (is this Windows with SAPI voices installed?)');
    return [];
  }
  const requestedVoice = ((options.voice ?? TTS.voice ?? '').trim() || undefined);
  const voice = pickSapiVoice(voices, requestedVoice, options.language);
  if (!voice) {
    warnings.push('sapi: could not pick a voice');
    return [];
  }
  if (requestedVoice && !voices.some((v) => v.name.toLowerCase().includes(requestedVoice.toLowerCase()))) {
    warnings.push(`sapi: requested voice "${requestedVoice}" not installed; using "${voice.name}"`);
  }

  const script = ensureSapiScript(workDir);
  const clips: TtsClip[] = [];
  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    const audioPath = path.join(workDir, `line-${String(i + 1).padStart(2, '0')}.wav`);
    try {
      const res = await runBinary(
        powershellExecutable(),
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-Out',
          audioPath,
          '-Text',
          request.text,
          '-Voice',
          voice.name
        ],
        { timeoutMs: options.timeoutMs ?? 120_000 }
      );
      if (res.code !== 0 || !fs.existsSync(audioPath) || fs.statSync(audioPath).size === 0) {
        warnings.push(`sapi: failed to synthesize step ${request.stepIndex} (${res.stderr.trim().slice(0, 160) || `exit ${res.code}`})`);
        continue;
      }
      const durationMs = await measureClipMs(audioPath, request.text, warnings);
      clips.push({
        stepIndex: request.stepIndex,
        text: request.text,
        startMs: request.startMs,
        audioPath,
        durationMs
      });
    } catch (err) {
      warnings.push(`sapi: step ${request.stepIndex} failed: ${(err as Error).message}`);
    }
  }
  return clips;
}

// ---------------------------------------------------------------------------
// OpenAI TTS (gpt-4o-mini-tts)
// ---------------------------------------------------------------------------

function openAiBaseUrl(): string {
  return (process.env.OPENAI_BASE_URL ?? process.env.REELFORGE_OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
}

async function openAiSynthesize(
  requests: NarrationRequest[],
  outDir: string,
  options: TtsOptions,
  warnings: string[]
): Promise<TtsClip[]> {
  const apiKey = TTS.openaiKey || process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    warnings.push('openai: OPENAI_API_KEY is not set');
    return [];
  }
  const requestedVoice = (options.voice ?? TTS.voice ?? '').trim().toLowerCase();
  const voice = OPENAI_VOICES.has(requestedVoice) ? requestedVoice : 'alloy';
  if (requestedVoice && !OPENAI_VOICES.has(requestedVoice)) {
    warnings.push(`openai: voice "${options.voice}" is not an OpenAI voice; using "${voice}"`);
  }
  const workDir = path.join(outDir, 'tts');
  fs.mkdirSync(workDir, { recursive: true });
  const model = TTS.openaiModel;
  const clips: TtsClip[] = [];

  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    const audioPath = path.join(workDir, `line-${String(i + 1).padStart(2, '0')}.mp3`);
    try {
      const response = await fetch(`${openAiBaseUrl()}/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, voice, input: request.text, response_format: 'mp3' }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000)
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        warnings.push(`openai: HTTP ${response.status} for step ${request.stepIndex}: ${body.slice(0, 180)}`);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        warnings.push(`openai: empty audio for step ${request.stepIndex}`);
        continue;
      }
      fs.writeFileSync(audioPath, buffer);
      const durationMs = await measureClipMs(audioPath, request.text, warnings);
      clips.push({ stepIndex: request.stepIndex, text: request.text, startMs: request.startMs, audioPath, durationMs });
    } catch (err) {
      warnings.push(`openai: step ${request.stepIndex} failed: ${(err as Error).message}`);
    }
  }
  return clips;
}

// ---------------------------------------------------------------------------
// edge-tts (python module)
// ---------------------------------------------------------------------------

export type EdgeAvailability = { available: boolean; executable?: string; reason?: string };

let edgeAvailabilityPromise: Promise<EdgeAvailability> | null = null;

/** Check for the `edge_tts` python module once and cache the result. */
export function detectEdgeTts(): Promise<EdgeAvailability> {
  if (edgeAvailabilityPromise) return edgeAvailabilityPromise;
  edgeAvailabilityPromise = (async () => {
    const executables = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
    for (const executable of executables) {
      const args =
        executable === 'py' ? ['-3', '-c', 'import edge_tts'] : ['-c', 'import edge_tts'];
      try {
        const res = await runBinary(executable, args, { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
        if (res.code === 0) return { available: true, executable };
      } catch {
        // not installed / not on PATH - try the next candidate
      }
    }
    return { available: false, reason: 'python edge_tts module not installed' };
  })();
  return edgeAvailabilityPromise;
}

function edgeVoiceFor(language: string | undefined, requested: string | undefined): string {
  if (requested && isEdgeVoiceName(requested)) return requested;
  const base = languageBase(language);
  return EDGE_VOICE_BY_LANGUAGE[base] ?? 'en-US-AriaNeural';
}

async function edgeSynthesize(
  requests: NarrationRequest[],
  outDir: string,
  options: TtsOptions,
  availability: EdgeAvailability,
  warnings: string[]
): Promise<TtsClip[]> {
  if (!availability.available || !availability.executable) {
    warnings.push('edge: edge-tts is not installed');
    return [];
  }
  const voice = edgeVoiceFor(options.language, options.voice ?? TTS.voice);
  const workDir = path.join(outDir, 'tts');
  fs.mkdirSync(workDir, { recursive: true });
  const clips: TtsClip[] = [];
  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    const audioPath = path.join(workDir, `line-${String(i + 1).padStart(2, '0')}.mp3`);
    const pythonArgs = ['-m', 'edge_tts'];
    const prefix = availability.executable === 'py' ? ['-3'] : [];
    try {
      const res = await runBinary(
        availability.executable,
        [...prefix, ...pythonArgs, '--text', request.text, '--voice', voice, '--write-media', audioPath],
        { timeoutMs: options.timeoutMs ?? 120_000 }
      );
      if (res.code !== 0 || !fs.existsSync(audioPath) || fs.statSync(audioPath).size === 0) {
        warnings.push(`edge: failed to synthesize step ${request.stepIndex}: ${res.stderr.trim().slice(0, 160) || `exit ${res.code}`}`);
        continue;
      }
      const durationMs = await measureClipMs(audioPath, request.text, warnings);
      clips.push({ stepIndex: request.stepIndex, text: request.text, startMs: request.startMs, audioPath, durationMs });
    } catch (err) {
      warnings.push(`edge: step ${request.stepIndex} failed: ${(err as Error).message}`);
    }
  }
  return clips;
}

async function measureClipMs(audioPath: string, text: string, warnings: string[]): Promise<number> {
  try {
    const probe = await probeMedia(audioPath);
    if (probe.durationMs > 0) return probe.durationMs;
  } catch (err) {
    warnings.push(`tts: could not probe ${path.basename(audioPath)}: ${(err as Error).message}`);
  }
  const estimate = estimateSpeechDurationMs(text);
  warnings.push(`tts: estimated duration (${estimate}ms) for a clip ffprobe could not measure`);
  return estimate;
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

export type ResolvedProvider = {
  provider: TtsProvider;
  warnings: string[];
};

/**
 * Decide which provider will run. `auto` = OpenAI (if keyed) -> edge -> SAPI
 * (Windows only) -> none. An explicit provider that is unavailable degrades to
 * `none` with a warning rather than throwing.
 */
export async function resolveTtsProvider(
  requested?: string,
  deps: { workDir?: string } = {}
): Promise<ResolvedProvider> {
  const warnings: string[] = [];
  const workDir = deps.workDir ?? path.join(process.cwd(), '.reelforge-tts-probe');
  const fromEnv = normalizeProvider(TTS.provider);
  const fromOptions = normalizeProvider(requested);
  const explicit = fromOptions ?? (fromEnv === 'auto' || fromEnv === null ? null : fromEnv);
  const wanted = explicit ?? 'auto';

  const available = async (provider: TtsProvider): Promise<boolean> => {
    switch (provider) {
      case 'openai':
        return Boolean(TTS.openaiKey || process.env.OPENAI_API_KEY);
      case 'edge':
        return (await detectEdgeTts()).available;
      case 'sapi':
        return process.platform === 'win32' && (await probeSapiVoices(workDir)).length > 0;
      case 'none':
        return true;
    }
  };

  if (wanted !== 'auto') {
    if (wanted === 'none') return { provider: 'none', warnings };
    if (await available(wanted)) return { provider: wanted, warnings };
    warnings.push(`tts: provider "${wanted}" is unavailable on this machine; continuing without narration`);
    return { provider: 'none', warnings };
  }

  if (await available('openai')) return { provider: 'openai', warnings };
  if (await available('edge')) return { provider: 'edge', warnings };
  if (await available('sapi')) return { provider: 'sapi', warnings };
  warnings.push(
    'tts: no narration provider available (OPENAI_API_KEY unset, edge-tts not installed, Windows SAPI unavailable) - rendering silent video with burned captions'
  );
  return { provider: 'none', warnings };
}

/**
 * Synthesize every narration request with the best available provider.
 * Per-line failures are warnings; a provider that fails wholesale falls through
 * to the next one in `auto` mode.
 */
export async function synthesizeNarration(requests: NarrationRequest[], options: TtsOptions): Promise<TtsResult> {
  const warnings: string[] = [];
  const cleaned = (Array.isArray(requests) ? requests : [])
    .map((request, index) => ({
      stepIndex: typeof request.stepIndex === 'number' ? request.stepIndex : index,
      text: String(request.text ?? '').trim(),
      startMs: Number.isFinite(request.startMs) ? Math.max(0, Math.round(request.startMs)) : 0
    }))
    .filter((request) => request.text.length > 0);

  if (cleaned.length === 0) {
    return { provider: 'none', clips: [], warnings };
  }

  const requested = normalizeProvider(options.provider);
  const resolved = await resolveTtsProvider(options.provider, { workDir: path.join(options.outDir, 'tts') });
  warnings.push(...resolved.warnings);
  if (resolved.provider === 'none') return { provider: 'none', clips: [], warnings };

  // In auto mode, walk the chain if the chosen provider throws or yields nothing.
  const chain: TtsProvider[] = [];
  if (requested === null || requested === 'auto') {
    const fromEnv = normalizeProvider(TTS.provider) ?? 'auto';
    if (fromEnv === 'auto') {
      chain.push(resolved.provider);
      for (const candidate of ['edge', 'sapi'] as const) {
        if (candidate !== resolved.provider) chain.push(candidate);
      }
    } else {
      chain.push(resolved.provider);
    }
  } else {
    chain.push(resolved.provider);
  }

  for (const provider of chain) {
    try {
      let clips: TtsClip[] = [];
      if (provider === 'openai') clips = await openAiSynthesize(cleaned, options.outDir, options, warnings);
      else if (provider === 'edge') {
        const availability = await detectEdgeTts();
        clips = await edgeSynthesize(cleaned, options.outDir, options, availability, warnings);
      } else if (provider === 'sapi') clips = await sapiSynthesize(cleaned, options.outDir, options, warnings);
      if (clips.length > 0) {
        if (clips.length < cleaned.length) {
          warnings.push(`tts: ${clips.length}/${cleaned.length} narration lines synthesized with ${provider}`);
        }
        return { provider, clips, warnings };
      }
      warnings.push(`tts: provider "${provider}" produced no audio; trying the next provider`);
    } catch (err) {
      warnings.push(`tts: provider "${provider}" failed (${(err as Error).message}); trying the next provider`);
    }
  }

  warnings.push('tts: all providers failed - rendering silent video with burned captions');
  return { provider: 'none', clips: [], warnings };
}
