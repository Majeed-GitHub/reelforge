/**
 * Narration synthesis, cross-platform and offline-first.
 *
 * Provider chain (`auto`): OpenAI -> ElevenLabs -> edge-tts -> macOS `say`
 * -> Linux `espeak-ng` / `espeak` / `pico2wave` / `festival` -> Windows SAPI
 * -> none (silent video, burned captions only).
 *
 * Design rules:
 *  - every probe is cheap and cached for the process;
 *  - probes fail *soft*: an unavailable provider is skipped, never thrown;
 *  - `describeTtsProviders()` reports what actually works on a machine (and
 *    accepts a platform override so the dashboard/tests can reason about a
 *    different OS without lying about availability).
 */
import fs from 'node:fs';
import path from 'node:path';
import { TTS } from '../../core/src/config.ts';
import { commandExists, probeMedia, runBinary, runFfmpeg, which } from './ffmpeg.ts';
import { estimateSpeechDurationMs } from './captions.ts';

/** Speech synthesis provider ids, in the order `auto` tries them. */
export type TtsProvider = 'openai' | 'elevenlabs' | 'edge' | 'macos' | 'linux' | 'sapi' | 'none';

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
  /** Provider override: auto | openai | elevenlabs | edge | macos | linux | sapi | none (or a voice name). */
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

/** What `describeTtsProviders()` reports for one provider on one platform. */
export type TtsProviderInfo = {
  id: TtsProvider;
  label: string;
  available: boolean;
  /** Human-readable why (installed path, missing key, wrong OS, …). */
  reason: string;
  platform: NodeJS.Platform;
  /** e.g. 'espeak-ng' for the selected Linux backend, 'say' on macOS. */
  backend?: string;
  /** Works with no network / no key. */
  offline?: boolean;
};

export const KNOWN_TTS_PROVIDERS: readonly (TtsProvider | 'auto')[] = [
  'auto',
  'openai',
  'elevenlabs',
  'edge',
  'macos',
  'linux',
  'sapi',
  'none'
] as const;

export const TTS_PROVIDER_LABELS: Record<TtsProvider, string> = {
  openai: 'OpenAI TTS',
  elevenlabs: 'ElevenLabs',
  edge: 'edge-tts (free)',
  macos: 'macOS say',
  linux: 'Linux system voices',
  sapi: 'Windows SAPI',
  none: 'Silent (captions only)'
};

const AUTO_ORDER: readonly TtsProvider[] = ['openai', 'elevenlabs', 'edge', 'macos', 'linux', 'sapi'] as const;

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

/** ElevenLabs' "Rachel" voice is the usual safe default (multilingual). */
const ELEVENLABS_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';

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
  if (token === 'elevenlabs' || token === 'eleven') return 'elevenlabs';
  if (token === 'edge' || token === 'edge-tts' || token === 'edgetts') return 'edge';
  if (token === 'macos' || token === 'mac' || token === 'darwin' || token === 'say') return 'macos';
  if (
    token === 'linux' ||
    token === 'espeak' ||
    token === 'espeak-ng' ||
    token === 'pico2wave' ||
    token === 'pico' ||
    token === 'festival'
  ) {
    return 'linux';
  }
  if (token === 'none' || token === 'off' || token === 'silent') return 'none';
  return null;
}

/** True when a string names a TTS provider (auto/openai/elevenlabs/edge/macos/linux/sapi/none). */
export function isTtsProviderToken(value: string | undefined): boolean {
  return normalizeProvider(value) !== null;
}

function languageBase(language: string | undefined): string {
  const token = String(language ?? 'en').trim().toLowerCase().replace('_', '-');
  return (token.split('-')[0] || 'en').toLowerCase();
}

function languageTag(language: string | undefined): string {
  const token = String(language ?? 'en').trim().toLowerCase().replace('_', '-');
  return token || 'en';
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

function powershellExecutable(): string {
  // powershell.exe (Windows PowerShell 5.1) ships System.Speech; pwsh 7 may not.
  return 'powershell.exe';
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
  const pool = byLanguage.length > 0 ? byLanguage : voices.filter((v) => v.culture.toLowerCase().startsWith('en'));
  const candidates = pool.length > 0 ? pool : voices;
  return (
    candidates.find((v) => /zira|aria|jenny|female/i.test(v.name)) ??
    candidates.find((v) => /female/i.test(v.gender)) ??
    candidates.find((v) => /david|mark|guy/i.test(v.name)) ??
    candidates[0] ??
    null
  );
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
    warnings.push('sapi: no Windows System.Speech voices found');
    return [];
  }
  const requestedVoice = (options.voice ?? TTS.voice ?? '').trim() || undefined;
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
        warnings.push(
          `sapi: failed to synthesize step ${request.stepIndex} (${res.stderr.trim().slice(0, 160) || `exit ${res.code}`})`
        );
        continue;
      }
      const durationMs = await measureClipMs(audioPath, request.text, warnings);
      clips.push({ stepIndex: request.stepIndex, text: request.text, startMs: request.startMs, audioPath, durationMs });
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
  return (process.env.OPENAI_BASE_URL ?? process.env.REELFORGE_OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(
    /\/+$/,
    ''
  );
}

function openAiKey(): string {
  return TTS.openaiKey || process.env.OPENAI_API_KEY || '';
}

async function openAiSynthesize(
  requests: NarrationRequest[],
  outDir: string,
  options: TtsOptions,
  warnings: string[]
): Promise<TtsClip[]> {
  const apiKey = openAiKey();
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
// ElevenLabs
// ---------------------------------------------------------------------------

function elevenLabsKey(): string {
  return process.env.ELEVENLABS_API_KEY || process.env.REELFORGE_ELEVENLABS_API_KEY || '';
}

function elevenLabsBaseUrl(): string {
  return (process.env.ELEVENLABS_BASE_URL ?? process.env.REELFORGE_ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io/v1').replace(
    /\/+$/,
    ''
  );
}

function looksLikeElevenLabsVoiceId(value: string): boolean {
  return /^[A-Za-z0-9]{16,}$/.test(value.trim());
}

async function elevenLabsSynthesize(
  requests: NarrationRequest[],
  outDir: string,
  options: TtsOptions,
  warnings: string[]
): Promise<TtsClip[]> {
  const apiKey = elevenLabsKey();
  if (!apiKey) {
    warnings.push('elevenlabs: ELEVENLABS_API_KEY is not set');
    return [];
  }
  const requested = (options.voice ?? TTS.voice ?? '').trim();
  const voice =
    (requested && looksLikeElevenLabsVoiceId(requested) ? requested : '') ||
    process.env.ELEVENLABS_VOICE_ID ||
    ELEVENLABS_DEFAULT_VOICE;
  const model = process.env.ELEVENLABS_MODEL ?? 'eleven_multilingual_v2';
  const workDir = path.join(outDir, 'tts');
  fs.mkdirSync(workDir, { recursive: true });
  const clips: TtsClip[] = [];

  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    const audioPath = path.join(workDir, `line-${String(i + 1).padStart(2, '0')}.mp3`);
    try {
      const response = await fetch(`${elevenLabsBaseUrl()}/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'audio/mpeg',
          'xi-api-key': apiKey
        },
        body: JSON.stringify({
          text: request.text,
          model_id: model,
          voice_settings: { stability: 0.45, similarity_boost: 0.75 }
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000)
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        warnings.push(`elevenlabs: HTTP ${response.status} for step ${request.stepIndex}: ${body.slice(0, 180)}`);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        warnings.push(`elevenlabs: empty audio for step ${request.stepIndex}`);
        continue;
      }
      fs.writeFileSync(audioPath, buffer);
      const durationMs = await measureClipMs(audioPath, request.text, warnings);
      clips.push({ stepIndex: request.stepIndex, text: request.text, startMs: request.startMs, audioPath, durationMs });
    } catch (err) {
      warnings.push(`elevenlabs: step ${request.stepIndex} failed: ${(err as Error).message}`);
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
      const args = executable === 'py' ? ['-3', '-c', 'import edge_tts'] : ['-c', 'import edge_tts'];
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
    const prefix = availability.executable === 'py' ? ['-3'] : [];
    try {
      const res = await runBinary(
        availability.executable,
        [...prefix, '-m', 'edge_tts', '--text', request.text, '--voice', voice, '--write-media', audioPath],
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

// ---------------------------------------------------------------------------
// macOS `say`
// ---------------------------------------------------------------------------

export type MacSayAvailability = { available: boolean; reason: string };

let macSayPromise: Promise<MacSayAvailability> | null = null;
let macVoicesPromise: Promise<Array<{ name: string; locale: string }>> | null = null;

/** Probe macOS `say` (cached). Always false on other platforms - no spawn. */
export function detectMacSay(platform: NodeJS.Platform = process.platform): Promise<MacSayAvailability> {
  if (platform !== 'darwin') {
    return Promise.resolve({ available: false, reason: `say is macOS-only (running on ${platform})` });
  }
  if (!macSayPromise) {
    macSayPromise = (async () => {
      const binary = which('say');
      if (!binary) return { available: false, reason: 'say not found on PATH' };
      if (!which('ffmpeg')) {
        // ffmpeg-static resolves even when not literally named ffmpeg on PATH;
        // the renderer already requires ffmpeg, so this is only a doctor hint.
        return { available: true, reason: `say at ${binary} (converting with the bundled ffmpeg)` };
      }
      return { available: true, reason: `say at ${binary}` };
    })();
  }
  return macSayPromise;
}

/** macOS `say -v ?` voice list (cached). Used only to match a language. */
export function listMacVoices(platform: NodeJS.Platform = process.platform): Promise<Array<{ name: string; locale: string }>> {
  if (platform !== 'darwin') return Promise.resolve([]);
  if (macVoicesPromise) return macVoicesPromise;
  macVoicesPromise = (async () => {
    try {
      const res = await runBinary('say', ['-v', '?'], { timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 });
      if (res.code !== 0) return [];
      const voices: Array<{ name: string; locale: string }> = [];
      for (const line of res.stdout.split(/\r?\n/)) {
        // "Alex                 en_US    # Most people recognize me by my voice."
        const match = /^(.+?)\s{2,}([a-z]{2,3}[_-][A-Z]{2})\s+#/.exec(line.trimEnd());
        if (match) voices.push({ name: match[1].trim(), locale: match[2] });
      }
      return voices;
    } catch {
      return [];
    }
  })();
  return macVoicesPromise;
}

async function macosSynthesize(
  requests: NarrationRequest[],
  outDir: string,
  options: TtsOptions,
  warnings: string[]
): Promise<TtsClip[]> {
  const availability = await detectMacSay(process.platform);
  if (!availability.available) {
    warnings.push(`macos: ${availability.reason}`);
    return [];
  }
  const workDir = path.join(outDir, 'tts');
  fs.mkdirSync(workDir, { recursive: true });

  let voice = (options.voice ?? TTS.voice ?? '').trim();
  if (!voice) {
    const base = languageBase(options.language);
    if (base !== 'en') {
      const voices = await listMacVoices();
      const match = voices.find((candidate) => candidate.locale.toLowerCase().startsWith(base));
      if (match) voice = match.name;
    }
  }

  const clips: TtsClip[] = [];
  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    const stem = `line-${String(i + 1).padStart(2, '0')}`;
    const aiffPath = path.join(workDir, `${stem}.aiff`);
    const wavPath = path.join(workDir, `${stem}.wav`);
    try {
      const sayArgs = ['-o', aiffPath, '--data-format=LEF32@22050'];
      if (voice) sayArgs.push('-v', voice);
      sayArgs.push(request.text);
      const said = await runBinary('say', sayArgs, { timeoutMs: options.timeoutMs ?? 120_000 });
      if (said.code !== 0 || !fs.existsSync(aiffPath) || fs.statSync(aiffPath).size === 0) {
        warnings.push(`macos: say failed for step ${request.stepIndex} (${said.stderr.trim().slice(0, 160) || `exit ${said.code}`})`);
        continue;
      }
      const converted = await runFfmpeg(
        ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiffPath, '-ar', '48000', '-ac', '2', wavPath],
        { timeoutMs: 60_000 }
      );
      if (converted.code !== 0 || !fs.existsSync(wavPath) || fs.statSync(wavPath).size === 0) {
        warnings.push(`macos: could not convert ${stem}.aiff to wav (${converted.stderr.trim().slice(0, 160) || `exit ${converted.code}`})`);
        continue;
      }
      const durationMs = await measureClipMs(wavPath, request.text, warnings);
      clips.push({ stepIndex: request.stepIndex, text: request.text, startMs: request.startMs, audioPath: wavPath, durationMs });
    } catch (err) {
      warnings.push(`macos: step ${request.stepIndex} failed: ${(err as Error).message}`);
    }
  }
  return clips;
}

// ---------------------------------------------------------------------------
// Linux system voices: espeak-ng -> espeak -> pico2wave -> festival
// ---------------------------------------------------------------------------

export type LinuxBackendId = 'espeak-ng' | 'espeak' | 'pico2wave' | 'festival';
export type LinuxBackend = { id: LinuxBackendId; path: string; text2wave?: string };
export type LinuxAvailability = { available: boolean; reason: string; backend?: LinuxBackend };

let linuxAvailabilityPromise: Promise<LinuxAvailability> | null = null;

/** Probe Linux system voices in order (cached). No spawn: PATH lookups only. */
export function detectLinuxVoice(platform: NodeJS.Platform = process.platform): Promise<LinuxAvailability> {
  if (platform !== 'linux') return Promise.resolve({ available: false, reason: `Linux system voices are Linux-only (running on ${platform})` });
  if (!linuxAvailabilityPromise) {
    linuxAvailabilityPromise = (async () => {
      for (const id of ['espeak-ng', 'espeak', 'pico2wave', 'festival'] as const) {
        const found = which(id);
        if (!found) continue;
        const backend: LinuxBackend = { id, path: found };
        if (id === 'festival') {
          const text2wave = which('text2wave');
          if (text2wave) backend.text2wave = text2wave;
        }
        return { available: true, reason: `${id} at ${found}`, backend };
      }
      return { available: false, reason: 'no espeak-ng / espeak / pico2wave / festival found on PATH' };
    })();
  }
  return linuxAvailabilityPromise;
}

function espeakVoice(language: string | undefined): string {
  const tag = languageTag(language);
  const base = languageBase(language);
  return tag.includes('-') ? tag : base;
}

function picoLanguage(language: string | undefined): string {
  const base = languageBase(language);
  const map: Record<string, string> = {
    en: 'en-US',
    es: 'es-ES',
    de: 'de-DE',
    fr: 'fr-FR',
    it: 'it-IT'
  };
  return map[base] ?? 'en-US';
}

function escapeSchemeString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
}

async function festivalSynthesizeLine(
  backend: LinuxBackend,
  text: string,
  wavPath: string,
  timeoutMs: number
): Promise<{ ok: boolean; detail: string }> {
  if (backend.text2wave) {
    const res = await runBinary(backend.text2wave, ['-o', wavPath, '-'], { input: `${text}\n`, timeoutMs });
    if (res.code === 0 && fs.existsSync(wavPath) && fs.statSync(wavPath).size > 0) return { ok: true, detail: '' };
    return { ok: false, detail: res.stderr.trim().slice(0, 160) || `exit ${res.code}` };
  }
  const schemePath = wavPath.replace(/\\/g, '/').replace(/"/g, '\\"');
  const scheme = `(utt.save.wave (utt.synth (Utterance Text "${escapeSchemeString(text)}")) "${schemePath}" 'riff)`;
  const res = await runBinary(backend.path, ['-b', scheme], { timeoutMs });
  if (res.code === 0 && fs.existsSync(wavPath) && fs.statSync(wavPath).size > 0) return { ok: true, detail: '' };
  return { ok: false, detail: res.stderr.trim().slice(0, 160) || `exit ${res.code}` };
}

async function linuxSynthesize(
  requests: NarrationRequest[],
  outDir: string,
  options: TtsOptions,
  warnings: string[]
): Promise<TtsClip[]> {
  const availability = await detectLinuxVoice(process.platform);
  if (!availability.available || !availability.backend) {
    warnings.push(`linux: ${availability.reason}`);
    return [];
  }
  const backend = availability.backend;
  const workDir = path.join(outDir, 'tts');
  fs.mkdirSync(workDir, { recursive: true });
  const timeoutMs = options.timeoutMs ?? 120_000;
  const clips: TtsClip[] = [];

  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    const wavPath = path.join(workDir, `line-${String(i + 1).padStart(2, '0')}.wav`);
    try {
      let ok = false;
      let detail = '';
      if (backend.id === 'espeak-ng' || backend.id === 'espeak') {
        const voice = (options.voice ?? TTS.voice ?? '').trim() || espeakVoice(options.language);
        const res = await runBinary(backend.path, ['-v', voice, '-w', wavPath, request.text], { timeoutMs });
        ok = res.code === 0 && fs.existsSync(wavPath) && fs.statSync(wavPath).size > 0;
        detail = res.stderr.trim().slice(0, 160) || `exit ${res.code}`;
      } else if (backend.id === 'pico2wave') {
        const language = (options.voice ?? TTS.voice ?? '').trim() || picoLanguage(options.language);
        const res = await runBinary(backend.path, ['-l', language, '-w', wavPath, request.text], { timeoutMs });
        ok = res.code === 0 && fs.existsSync(wavPath) && fs.statSync(wavPath).size > 0;
        detail = res.stderr.trim().slice(0, 160) || `exit ${res.code}`;
      } else {
        const result = await festivalSynthesizeLine(backend, request.text, wavPath, timeoutMs);
        ok = result.ok;
        detail = result.detail;
      }
      if (!ok) {
        warnings.push(`linux/${backend.id}: failed for step ${request.stepIndex} (${detail})`);
        continue;
      }
      const durationMs = await measureClipMs(wavPath, request.text, warnings);
      clips.push({ stepIndex: request.stepIndex, text: request.text, startMs: request.startMs, audioPath: wavPath, durationMs });
    } catch (err) {
      warnings.push(`linux/${backend.id}: step ${request.stepIndex} failed: ${(err as Error).message}`);
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
// Provider resolution + description
// ---------------------------------------------------------------------------

export type ResolvedProvider = {
  provider: TtsProvider;
  warnings: string[];
};

let sapiProbeDir: string | null = null;

/** Availability of one provider on a given platform. Exposed via describeTtsProviders. */
export async function describeTtsProvider(
  id: TtsProvider,
  platform: NodeJS.Platform = process.platform
): Promise<TtsProviderInfo> {
  const label = TTS_PROVIDER_LABELS[id];
  const actual = process.platform;

  if (id === 'none') {
    return { id, label, available: true, reason: 'no audio; captions are still burned in', platform, offline: true };
  }
  if (id === 'openai') {
    const available = Boolean(openAiKey());
    return {
      id,
      label,
      available,
      reason: available ? 'OPENAI_API_KEY is set' : 'OPENAI_API_KEY is not set',
      platform,
      offline: false
    };
  }
  if (id === 'elevenlabs') {
    const available = Boolean(elevenLabsKey());
    return {
      id,
      label,
      available,
      reason: available ? 'ELEVENLABS_API_KEY is set' : 'ELEVENLABS_API_KEY is not set',
      platform,
      offline: false
    };
  }
  if (id === 'edge') {
    const availability = await detectEdgeTts();
    return {
      id,
      label,
      available: availability.available,
      reason: availability.available
        ? `python edge_tts via ${availability.executable}`
        : availability.reason ?? 'python edge_tts module not installed',
      platform,
      backend: availability.executable,
      offline: false
    };
  }
  if (id === 'sapi') {
    if (platform !== actual) {
      return { id, label, available: false, reason: `Windows SAPI is Windows-only (running on ${actual})`, platform, backend: 'sapi' };
    }
    if (platform !== 'win32') {
      return { id, label, available: false, reason: `Windows SAPI is Windows-only (running on ${platform})`, platform, backend: 'sapi' };
    }
    const voices = await probeSapiVoices(sapiProbeDir ?? path.join(process.cwd(), '.reelforge-tts-probe'));
    return {
      id,
      label,
      available: voices.length > 0,
      reason: voices.length > 0 ? `${voices.length} System.Speech voice(s), e.g. ${voices[0].name}` : 'no System.Speech voices installed',
      platform,
      backend: 'sapi',
      offline: true
    };
  }
  if (id === 'macos') {
    const availability = await detectMacSay(platform);
    return {
      id,
      label,
      available: availability.available,
      reason: availability.reason,
      platform,
      backend: 'say',
      offline: true
    };
  }
  // linux
  const availability = await detectLinuxVoice(platform);
  return {
    id,
    label,
    available: availability.available,
    reason: availability.reason,
    platform,
    backend: availability.backend?.id,
    offline: true
  };
}

/** Describe every provider (in `auto` order, then `none`) for a platform. */
export async function describeTtsProviders(platform: NodeJS.Platform = process.platform): Promise<TtsProviderInfo[]> {
  const ids: TtsProvider[] = [...AUTO_ORDER, 'none'];
  const info: TtsProviderInfo[] = [];
  for (const id of ids) {
    try {
      info.push(await describeTtsProvider(id, platform));
    } catch (err) {
      info.push({
        id,
        label: TTS_PROVIDER_LABELS[id],
        available: false,
        reason: `probe failed: ${(err as Error).message}`,
        platform
      });
    }
  }
  return info;
}

/**
 * Decide which provider will run. `auto` follows the documented chain and picks
 * the first available provider. An explicit provider that is unavailable
 * degrades to `none` with a warning rather than throwing.
 */
export async function resolveTtsProvider(
  requested?: string,
  deps: { workDir?: string } = {}
): Promise<ResolvedProvider> {
  const warnings: string[] = [];
  sapiProbeDir = deps.workDir ?? sapiProbeDir;
  const fromEnv = normalizeProvider(TTS.provider);
  const fromOptions = normalizeProvider(requested);
  let explicit: TtsProvider | null = null;
  if (fromOptions && fromOptions !== 'auto') explicit = fromOptions;
  else if (fromEnv && fromEnv !== 'auto') explicit = fromEnv;

  if (explicit) {
    if (explicit === 'none') return { provider: 'none', warnings };
    const info = await describeTtsProvider(explicit);
    if (info.available) return { provider: explicit, warnings };
    warnings.push(`tts: provider "${explicit}" is unavailable (${info.reason}); continuing without narration`);
    return { provider: 'none', warnings };
  }

  for (const id of AUTO_ORDER) {
    const info = await describeTtsProvider(id);
    if (info.available) return { provider: id, warnings };
  }

  warnings.push(
    'tts: no narration provider available (OPENAI_API_KEY / ELEVENLABS_API_KEY unset, edge-tts not installed, ' +
      'no OS voices: macOS say, Linux espeak-ng/espeak/pico2wave/festival, Windows SAPI) - rendering silent video with burned captions'
  );
  return { provider: 'none', warnings };
}

async function synthesizeWith(
  provider: TtsProvider,
  requests: NarrationRequest[],
  options: TtsOptions,
  warnings: string[]
): Promise<TtsClip[]> {
  switch (provider) {
    case 'openai':
      return openAiSynthesize(requests, options.outDir, options, warnings);
    case 'elevenlabs':
      return elevenLabsSynthesize(requests, options.outDir, options, warnings);
    case 'edge': {
      const availability = await detectEdgeTts();
      return edgeSynthesize(requests, options.outDir, options, availability, warnings);
    }
    case 'macos':
      return macosSynthesize(requests, options.outDir, options, warnings);
    case 'linux':
      return linuxSynthesize(requests, options.outDir, options, warnings);
    case 'sapi':
      return sapiSynthesize(requests, options.outDir, options, warnings);
    case 'none':
      return [];
  }
}

/**
 * Synthesize every narration request with the best available provider.
 * Per-line failures are warnings; a provider that yields nothing falls through
 * to the next provider in `auto` mode.
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

  const fromEnv = normalizeProvider(TTS.provider);
  const fromOptions = normalizeProvider(options.provider);
  let explicit: TtsProvider | null = null;
  if (fromOptions && fromOptions !== 'auto') explicit = fromOptions;
  else if (fromEnv && fromEnv !== 'auto') explicit = fromEnv;

  let chain: TtsProvider[];
  if (explicit) {
    if (explicit === 'none') return { provider: 'none', clips: [], warnings };
    const info = await describeTtsProvider(explicit);
    if (!info.available) {
      warnings.push(`tts: provider "${explicit}" is unavailable (${info.reason}); continuing without narration`);
      return { provider: 'none', clips: [], warnings };
    }
    chain = [explicit];
  } else {
    chain = [];
    for (const id of AUTO_ORDER) {
      const info = await describeTtsProvider(id);
      if (info.available) chain.push(id);
    }
    if (chain.length === 0) {
      warnings.push(
        'tts: no narration provider available (OPENAI_API_KEY / ELEVENLABS_API_KEY unset, edge-tts not installed, ' +
          'no OS voices: macOS say, Linux espeak-ng/espeak/pico2wave/festival, Windows SAPI) - rendering silent video with burned captions'
      );
      return { provider: 'none', clips: [], warnings };
    }
  }

  for (const provider of chain) {
    try {
      const clips = await synthesizeWith(provider, cleaned, options, warnings);
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
