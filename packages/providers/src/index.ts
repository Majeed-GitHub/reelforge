/**
 * Reelforge bring-your-own-key provider layer.
 *
 * One resolution path for every model a Reelforge instance talks to:
 *
 *   env var  >  workspace_settings  >  nothing
 *
 * - `resolveLlm()` picks the planner endpoint/key/model. Environment variables
 *   win because they are the ops-level override; a key pasted in the dashboard
 *   (`workspace_settings`, AES-256-GCM encrypted at rest) is used otherwise.
 * - `resolveTts()` does the same for narration providers.
 * - `discoverModels()` lists an OpenAI-compatible `/models` catalog (works for
 *   GMI Cloud, OpenRouter, Ollama, LM Studio and any gateway — never throws).
 * - `testProvider()` does a minimal `/chat/completions` round trip and reports a
 *   typed `ProviderError` instead of crashing (401 vs 404 vs timeout).
 * - `maskKey()` is the only way a stored key may leave this module: the API
 *   returns `sk-…abcd`, never the secret.
 *
 * Nothing here performs network I/O at import time. The database is only
 * touched when a resolution actually needs the workspace fallback.
 */

import { decryptJson, encryptJson } from '../../core/src/crypto.ts';
import { getDb } from '../../core/src/db.ts';
import {
  LLM_PROVIDERS,
  TTS_PROVIDERS,
  LLM_PROVIDER_IDS,
  TTS_PROVIDER_IDS,
  findLlmProvider,
  findTtsProvider,
  type LlmProvider,
  type LlmProviderId,
  type TtsProvider,
  type TtsProviderId
} from '../../core/src/providers.ts';

export {
  LLM_PROVIDERS,
  TTS_PROVIDERS,
  LLM_PROVIDER_IDS,
  TTS_PROVIDER_IDS,
  findLlmProvider,
  findTtsProvider
};
export type { LlmProvider, LlmProviderId, TtsProvider, TtsProviderId };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Where a resolved setting came from. `none` means "not configured". */
export const PROVIDER_SOURCES = ['env', 'workspace', 'none'] as const;
export type ProviderSource = (typeof PROVIDER_SOURCES)[number];

/** Environment variables understood by the provider layer. */
export const PROVIDER_ENV = {
  llmProvider: 'REELFORGE_LLM_PROVIDER',
  llmBaseUrl: 'REELFORGE_LLM_BASE_URL',
  llmApiKey: 'REELFORGE_LLM_API_KEY',
  llmModel: 'REELFORGE_LLM_MODEL',
  ttsProvider: 'REELFORGE_TTS_PROVIDER',
  ttsVoice: 'REELFORGE_TTS_VOICE',
  ttsModel: 'REELFORGE_TTS_MODEL',
  /** Optional explicit workspace for headless/worker processes. */
  workspaceId: 'REELFORGE_WORKSPACE_ID'
} as const;

/** Keys written under `workspace_settings`. */
export const LLM_SETTING_KEYS = {
  provider: 'llm.provider',
  model: 'llm.model',
  baseUrl: 'llm.baseUrl',
  /** Encrypted blob (see `sealSecret`). */
  apiKey: 'llm.apiKey'
} as const;

export const TTS_SETTING_KEYS = {
  provider: 'tts.provider',
  voice: 'tts.voice',
  model: 'tts.model',
  /** Encrypted blob (see `sealSecret`). */
  apiKey: 'tts.apiKey'
} as const;

const SHARED_LLM_KEY_ENV = PROVIDER_ENV.llmApiKey;

/** The 0.1 default model, kept so env-only setups behave exactly as before. */
const LEGACY_DEFAULT_MODEL = 'gpt-4.1-mini';

const MODELS_TIMEOUT_MS = 8_000;
const TEST_TIMEOUT_MS = 12_000;

/** Narration endpoints are not in the core catalog (no key/base URL there). */
const TTS_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  elevenlabs: 'https://api.elevenlabs.io/v1'
};

const TTS_DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini-tts'
};

export type EnvBag = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function envValue(env: EnvBag, name: string): string {
  const raw = env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Validate and normalise an OpenAI-compatible base URL. Returns `null` when the
 * value is not an absolute http(s) URL (local Ollama/LM Studio included).
 */
export function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return stripTrailingSlash(url.toString());
  } catch {
    return null;
  }
}

/**
 * The only representation of a key the API may return: `sk-…abcd`.
 * Nothing else is ever exposed (no length, no prefix beyond 3 chars).
 */
export function maskKey(key: string | null | undefined): string | null {
  const value = (key ?? '').trim();
  if (!value) return null;
  if (value.length <= 4) return '…';
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Workspace settings storage (encrypted secrets)
// ---------------------------------------------------------------------------

/**
 * Read-only view of `workspace_settings`. Injectable so tests never need a real
 * database and so callers can scope resolution to one workspace explicitly.
 */
export type WorkspaceSettingsReader = {
  /** Raw `value_json` for (workspace, key), or null. */
  get(workspaceId: string, key: string): string | null;
  /**
   * Workspace used when no workspace id is supplied. Returns a value only when
   * exactly one workspace exists — a multi-tenant worker must not guess (and
   * must never resolve another tenant's key).
   */
  defaultWorkspaceId?(): string | null;
};

/** The real reader: `workspace_settings` in the core SQLite database. */
export function defaultSettingsReader(): WorkspaceSettingsReader {
  return {
    get(workspaceId: string, key: string): string | null {
      try {
        const stmt = getDb().prepare('SELECT value_json FROM workspace_settings WHERE workspace_id = ? AND key = ?');
        const row = stmt.get(workspaceId, key) as unknown as { value_json?: string } | undefined;
        return typeof row?.value_json === 'string' ? row.value_json : null;
      } catch {
        return null;
      }
    },
    defaultWorkspaceId(): string | null {
      try {
        const countRow = getDb().prepare('SELECT COUNT(*) AS n FROM workspaces').get() as unknown as
          | { n?: number | bigint }
          | undefined;
        if (Number(countRow?.n ?? 0) !== 1) return null;
        const row = getDb().prepare('SELECT id FROM workspaces LIMIT 1').get() as unknown as
          | { id?: string }
          | undefined;
        return typeof row?.id === 'string' ? row.id : null;
      } catch {
        return null;
      }
    }
  };
}

/** JSON-encode a non-secret setting. */
export function encodeSetting(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Decode a non-secret setting; null when absent or malformed. */
export function decodeSetting(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Encrypt a secret for `workspace_settings.value_json`:
 * `JSON.stringify(encryptJson(value))`. The resulting `v1.<iv>.<tag>.<ct>`
 * blob is AES-256-GCM with the instance keyfile (`data/.secret`).
 */
export function sealSecret(value: unknown): string {
  return JSON.stringify(encryptJson(value));
}

/**
 * Decrypt a stored secret. Accepts both shapes we have ever written:
 * the JSON-quoted blob and `{ encrypted: "v1.…" }`. Never throws.
 */
export function openSecret(raw: string | null | undefined): unknown {
  const decoded = decodeSetting(raw);
  let blob: string | null = null;
  if (typeof decoded === 'string') blob = decoded;
  else if (decoded && typeof decoded === 'object') {
    const candidate = (decoded as { encrypted?: unknown }).encrypted;
    if (typeof candidate === 'string') blob = candidate;
  }
  if (!blob) return null;
  try {
    return decryptJson<unknown>(blob);
  } catch {
    return null;
  }
}

function secretString(reader: WorkspaceSettingsReader, workspaceId: string, key: string): string | null {
  const value = openSecret(reader.get(workspaceId, key));
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const record = value as { apiKey?: unknown; key?: unknown; secret?: unknown };
    for (const candidate of [record.apiKey, record.key, record.secret]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  return null;
}

function stringSetting(reader: WorkspaceSettingsReader, workspaceId: string, key: string): string | null {
  const value = decodeSetting(reader.get(workspaceId, key));
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export type WorkspaceLlmStore = {
  providerId: string | null;
  model: string | null;
  baseUrl: string | null;
  apiKey: string | null;
};

export type WorkspaceTtsStore = {
  providerId: string | null;
  voice: string | null;
  model: string | null;
  apiKey: string | null;
};

/** Decrypted workspace LLM settings (the key is decrypted here, never logged). */
export function readWorkspaceLlmStore(
  workspaceId: string,
  reader: WorkspaceSettingsReader = defaultSettingsReader()
): WorkspaceLlmStore {
  return {
    providerId: stringSetting(reader, workspaceId, LLM_SETTING_KEYS.provider),
    model: stringSetting(reader, workspaceId, LLM_SETTING_KEYS.model),
    baseUrl: stringSetting(reader, workspaceId, LLM_SETTING_KEYS.baseUrl),
    apiKey: secretString(reader, workspaceId, LLM_SETTING_KEYS.apiKey)
  };
}

/** Decrypted workspace TTS settings. */
export function readWorkspaceTtsStore(
  workspaceId: string,
  reader: WorkspaceSettingsReader = defaultSettingsReader()
): WorkspaceTtsStore {
  return {
    providerId: stringSetting(reader, workspaceId, TTS_SETTING_KEYS.provider),
    voice: stringSetting(reader, workspaceId, TTS_SETTING_KEYS.voice),
    model: stringSetting(reader, workspaceId, TTS_SETTING_KEYS.model),
    apiKey: secretString(reader, workspaceId, TTS_SETTING_KEYS.apiKey)
  };
}

// ---------------------------------------------------------------------------
// Environment keys
// ---------------------------------------------------------------------------

/**
 * The provider's *own* key variable, ignoring the shared
 * `REELFORGE_LLM_API_KEY` fallback that every catalog entry lists. Used to show
 * per-card "set by environment" state without claiming one shared key configures
 * all providers at once.
 */
export function providerSpecificEnvKey(
  provider: LlmProvider,
  env: EnvBag = process.env
): { name: string; value: string } | null {
  for (const name of provider.keyEnv) {
    if (name === SHARED_LLM_KEY_ENV) continue;
    const value = envValue(env, name);
    if (value) return { name, value };
  }
  return null;
}

/** Any env var that can key this provider, including the shared fallback. */
export function providerAnyEnvKey(
  provider: LlmProvider,
  env: EnvBag = process.env
): { name: string; value: string } | null {
  for (const name of provider.keyEnv) {
    const value = envValue(env, name);
    if (value) return { name, value };
  }
  return null;
}

/** Convenience: env key for a catalog id. */
export function providerEnvKey(providerId: string, env: EnvBag = process.env): { name: string; value: string } | null {
  const provider = findLlmProvider(providerId);
  return provider ? providerAnyEnvKey(provider, env) : null;
}

function ttsEnvKey(provider: TtsProvider, env: EnvBag): { name: string; value: string } | null {
  for (const name of provider.keyEnv ?? []) {
    const value = envValue(env, name);
    if (value) return { name, value };
  }
  return null;
}

// ---------------------------------------------------------------------------
// LLM resolution
// ---------------------------------------------------------------------------

export type ResolvedLlm = {
  providerId: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  source: ProviderSource;
};

export type ResolveOptions = {
  /** Defaults to `process.env`. */
  env?: EnvBag;
  /** Workspace to read settings for; `null` disables the workspace fallback. */
  workspaceId?: string | null;
  /** Defaults to the SQLite-backed reader. */
  reader?: WorkspaceSettingsReader;
};

const NONE_LLM: ResolvedLlm = {
  providerId: 'none',
  label: 'Offline scripted planner',
  baseUrl: '',
  apiKey: '',
  model: '',
  source: 'none'
};

function customProvider(label: string, baseUrl: string): LlmProvider {
  return {
    id: 'custom',
    label,
    baseUrl,
    requiresKey: false,
    keyEnv: [SHARED_LLM_KEY_ENV],
    defaultModel: ''
  };
}

function resolveWorkspaceId(
  options: ResolveOptions,
  env: EnvBag,
  reader: WorkspaceSettingsReader
): string | null {
  if (options.workspaceId !== undefined) return options.workspaceId;
  const fromEnv = envValue(env, PROVIDER_ENV.workspaceId);
  if (fromEnv) return fromEnv;
  return reader.defaultWorkspaceId?.() ?? null;
}

function resolveLlmFromEnv(env: EnvBag, reader: WorkspaceSettingsReader, workspaceId: string | null): ResolvedLlm | null {
  const rawProvider = envValue(env, PROVIDER_ENV.llmProvider).toLowerCase();
  if (rawProvider === 'none') {
    return { ...NONE_LLM, label: 'Disabled by REELFORGE_LLM_PROVIDER' };
  }

  const envBaseUrl = envValue(env, PROVIDER_ENV.llmBaseUrl);
  const envModel = envValue(env, PROVIDER_ENV.llmModel);

  let provider: LlmProvider | null = null;
  let autoSelected = false;

  if (rawProvider && rawProvider !== 'auto') {
    // Explicit provider (unknown ids behave like a custom gateway).
    provider = findLlmProvider(rawProvider) ?? customProvider(`Custom (${rawProvider})`, '');
  } else if (envBaseUrl) {
    // 0.1 compatibility: REELFORGE_LLM_BASE_URL alone selects a custom gateway.
    provider = customProvider('Custom (OpenAI-compatible)', envBaseUrl);
    autoSelected = true;
  } else {
    // Auto-detect: first provider-specific key wins, then the legacy shared key
    // mapped to OpenAI (which is what 0.1's config.LLM did).
    for (const candidate of LLM_PROVIDERS) {
      if (candidate.id === 'custom') continue;
      if (providerSpecificEnvKey(candidate, env)) {
        provider = candidate;
        break;
      }
    }
    if (!provider && envValue(env, SHARED_LLM_KEY_ENV)) {
      provider = findLlmProvider('openai') ?? null;
    }
  }

  if (!provider) return null;

  const baseUrl = stripTrailingSlash(envBaseUrl || provider.baseUrl);
  if (!baseUrl) return null;

  let apiKey = providerAnyEnvKey(provider, env)?.value ?? '';
  let source: ProviderSource;

  if (apiKey) {
    source = 'env';
  } else if (!provider.requiresKey) {
    // A keyless local endpoint is only usable when it was selected explicitly;
    // a bare REELFORGE_LLM_BASE_URL never enabled the planner in 0.1.
    if (autoSelected) return null;
    source = 'env';
  } else {
    // Env chose the provider but the key lives in the dashboard: allow that mix.
    source = 'none';
    if (workspaceId) {
      const store = readWorkspaceLlmStore(workspaceId, reader);
      if (store.apiKey && (!store.providerId || store.providerId === provider.id)) {
        apiKey = store.apiKey;
        source = 'workspace';
      }
    }
  }

  if (source === 'none') return null;

  const model = envModel || provider.defaultModel || (autoSelected ? LEGACY_DEFAULT_MODEL : '');
  return { providerId: provider.id, label: provider.label, baseUrl, apiKey, model, source };
}

function resolveLlmFromWorkspace(store: WorkspaceLlmStore): ResolvedLlm | null {
  if (!store.providerId && !store.apiKey && !store.baseUrl) return null;
  const providerId = store.providerId || (store.baseUrl ? 'custom' : 'openai');
  const provider = findLlmProvider(providerId);
  const baseUrl = stripTrailingSlash(store.baseUrl || provider?.baseUrl || '');
  if (!baseUrl) return null;
  const requiresKey = provider ? provider.requiresKey : true;
  if (requiresKey && !store.apiKey) return null;
  return {
    providerId,
    label: provider?.label ?? 'Custom (OpenAI-compatible)',
    baseUrl,
    apiKey: store.apiKey ?? '',
    model: store.model || provider?.defaultModel || '',
    source: 'workspace'
  };
}

/**
 * Resolve the planner endpoint: env first, then the workspace's encrypted
 * settings, then `source: 'none'` (which means "keep the offline planner").
 *
 * The returned `apiKey` is a secret — callers must never log or return it.
 */
export function resolveLlm(options: ResolveOptions = {}): ResolvedLlm {
  const env = options.env ?? process.env;
  const reader = options.reader ?? defaultSettingsReader();

  // An explicit `none` disables the model regardless of anything stored.
  if (envValue(env, PROVIDER_ENV.llmProvider).toLowerCase() === 'none') {
    return { ...NONE_LLM, label: 'Disabled by REELFORGE_LLM_PROVIDER' };
  }

  const workspaceId = resolveWorkspaceId(options, env, reader);
  const fromEnv = resolveLlmFromEnv(env, reader, workspaceId);
  if (fromEnv) return fromEnv;

  if (workspaceId) {
    const store = readWorkspaceLlmStore(workspaceId, reader);
    if ((store.providerId ?? '').toLowerCase() === 'none') return NONE_LLM;
    const fromWorkspace = resolveLlmFromWorkspace(store);
    if (fromWorkspace) return fromWorkspace;
  }

  return NONE_LLM;
}

// ---------------------------------------------------------------------------
// TTS resolution
// ---------------------------------------------------------------------------

export type ResolvedTts = {
  providerId: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  source: ProviderSource;
};

function ttsResult(
  provider: TtsProvider,
  source: ProviderSource,
  voice: string,
  apiKey: string,
  model?: string | null
): ResolvedTts {
  return {
    providerId: provider.id,
    label: provider.label,
    baseUrl: TTS_BASE_URLS[provider.id] ?? '',
    apiKey,
    model: (model ?? '') || TTS_DEFAULT_MODELS[provider.id] || '',
    voice,
    source
  };
}

/**
 * Resolve the narration provider: env > workspace > offline default.
 *
 * `providerId` is always a concrete provider (`sapi`, `edge`, `openai`,
 * `elevenlabs` or `none`); the render pipeline's `auto` handling is mirrored by
 * picking the platform's offline voice when nothing is configured.
 */
export function resolveTts(options: ResolveOptions = {}): ResolvedTts {
  const env = options.env ?? process.env;
  const reader = options.reader ?? defaultSettingsReader();
  const workspaceId = resolveWorkspaceId(options, env, reader);
  const envVoice = envValue(env, PROVIDER_ENV.ttsVoice);
  const explicit = envValue(env, PROVIDER_ENV.ttsProvider).toLowerCase();

  if (explicit && explicit !== 'auto') {
    const provider = findTtsProvider(explicit);
    if (provider) {
      const key = ttsEnvKey(provider, env)?.value ?? '';
      if (!provider.requiresKey || key) return ttsResult(provider, 'env', envVoice, key);
    }
  }

  for (const id of ['openai', 'elevenlabs'] as const) {
    const provider = findTtsProvider(id);
    if (!provider) continue;
    const key = ttsEnvKey(provider, env);
    if (key) return ttsResult(provider, 'env', envVoice, key.value);
  }

  if (workspaceId) {
    const store = readWorkspaceTtsStore(workspaceId, reader);
    const provider = store.providerId ? findTtsProvider(store.providerId) : undefined;
    if (provider) {
      if (!provider.requiresKey || store.apiKey) {
        return ttsResult(provider, 'workspace', store.voice || envVoice, store.apiKey ?? '', store.model);
      }
    }
  }

  // Offline default: Windows SAPI on Windows, edge-tts elsewhere (matching the
  // render pipeline's auto chain as closely as we can without shelling out).
  const fallback = findTtsProvider(process.platform === 'win32' ? 'sapi' : 'edge') ?? findTtsProvider('none');
  if (!fallback) {
    return { providerId: 'none', label: 'Silent', baseUrl: '', apiKey: '', model: '', voice: '', source: 'none' };
  }
  return ttsResult(fallback, 'none', envVoice, '');
}

// ---------------------------------------------------------------------------
// Typed provider errors
// ---------------------------------------------------------------------------

export const PROVIDER_ERROR_CODES = [
  'PROVIDER_CONFIG',
  'PROVIDER_UNAUTHORIZED',
  'PROVIDER_NOT_FOUND',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNREACHABLE',
  'PROVIDER_HTTP_ERROR',
  'PROVIDER_BAD_RESPONSE'
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/** The clean, typed failure surface of the whole provider layer. */
export type ProviderError = {
  code: ProviderErrorCode;
  message: string;
  status?: number;
  hint?: string;
};

function configError(message: string, hint?: string): ProviderError {
  return hint ? { code: 'PROVIDER_CONFIG', message, hint } : { code: 'PROVIDER_CONFIG', message };
}

function bodySnippet(body: string): string {
  const text = body.replace(/\s+/g, ' ').trim();
  return text ? ` ${text.slice(0, 240)}` : '';
}

function statusError(status: number, body: string, url: string): ProviderError {
  const snippet = bodySnippet(body);
  if (status === 401 || status === 403) {
    return {
      code: 'PROVIDER_UNAUTHORIZED',
      status,
      message: `The provider rejected the API key (HTTP ${status}).${snippet}`,
      hint: 'Paste the key exactly, without a "Bearer " prefix, and check the key belongs to this provider.'
    };
  }
  if (status === 404) {
    return {
      code: 'PROVIDER_NOT_FOUND',
      status,
      message: `No OpenAI-compatible endpoint at ${url} (HTTP 404).${snippet}`,
      hint: 'Base URLs usually end in /v1 (Ollama: http://127.0.0.1:11434/v1). For GMI use the serving URL from the console; for OpenRouter https://openrouter.ai/api/v1.'
    };
  }
  if (status === 429) {
    return {
      code: 'PROVIDER_RATE_LIMITED',
      status,
      message: `The provider rate-limited the request (HTTP 429).${snippet}`,
      hint: 'Retry shortly or use a smaller/faster model; check your plan limits in the provider console.'
    };
  }
  return {
    code: 'PROVIDER_HTTP_ERROR',
    status,
    message: `The provider returned HTTP ${status}.${snippet}`,
    hint: 'Check the provider status page and your account/billing state.'
  };
}

function transportError(error: unknown, timeoutMs: number): ProviderError {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return {
      code: 'PROVIDER_TIMEOUT',
      message: `The provider did not answer within ${Math.round(timeoutMs / 1000)}s.`,
      hint: 'Cold local models can take a while to load. Check the host/port, or raise the timeout.'
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'PROVIDER_UNREACHABLE',
    message: `Could not reach the provider: ${message}`,
    hint: 'Check the base URL and that the gateway (or local Ollama/LM Studio server) is running.'
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ response: Response } | { error: ProviderError }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response };
  } catch (error) {
    return { error: transportError(error, timeoutMs) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Credentials for a direct provider probe
// ---------------------------------------------------------------------------

export type ProviderRequestOptions = {
  env?: EnvBag;
  workspaceId?: string | null;
  reader?: WorkspaceSettingsReader;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
};

/**
 * Key for one provider when probing it directly: explicit argument, then env,
 * then the workspace key belonging to that same provider.
 */
function requestCredential(provider: LlmProvider, options: ProviderRequestOptions): string {
  const explicit = (options.apiKey ?? '').trim();
  if (explicit) return explicit;
  const env = options.env ?? process.env;
  const fromEnv = providerAnyEnvKey(provider, env)?.value;
  if (fromEnv) return fromEnv;
  if (options.workspaceId) {
    const store = readWorkspaceLlmStore(options.workspaceId, options.reader);
    if (store.apiKey && (!store.providerId || store.providerId === provider.id)) return store.apiKey;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/**
 * Extract model ids from anything providers actually return:
 * OpenAI `{data:[{id}]}`, Ollama `{models:[{name}]}`, a bare array, or
 * `{models:["…"]}`. Unknown shapes yield `[]` instead of throwing.
 */
export function parseModelIds(payload: unknown): string[] {
  const ids = new Set<string>();
  const collect = (entries: unknown): void => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry === 'string') {
        if (entry.trim()) ids.add(entry.trim());
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as { id?: unknown; name?: unknown; model?: unknown };
      const candidate =
        (typeof record.id === 'string' && record.id) ||
        (typeof record.name === 'string' && record.name) ||
        (typeof record.model === 'string' && record.model) ||
        '';
      if (candidate.trim()) ids.add(candidate.trim());
    }
  };

  if (Array.isArray(payload)) {
    collect(payload);
  } else if (payload && typeof payload === 'object') {
    const record = payload as { data?: unknown; models?: unknown; result?: unknown };
    collect(record.data);
    collect(record.models);
    collect(record.result);
  }

  return [...ids].sort((a, b) => a.localeCompare(b));
}

export type ModelDiscovery = {
  models: string[];
  ok: boolean;
  latencyMs: number;
  error: ProviderError | null;
};

/**
 * List the provider's models via GET `{baseUrl}/models`. Never throws: a bad
 * key, a wrong path or a dead local server comes back as `ok:false` + typed
 * `error`, so the dashboard can explain it.
 */
export async function discoverModels(
  providerInput: string | LlmProvider,
  options: ProviderRequestOptions = {}
): Promise<ModelDiscovery> {
  const started = Date.now();
  const provider =
    typeof providerInput === 'string' ? findLlmProvider(providerInput) ?? null : providerInput;
  if (!provider) {
    return {
      models: [],
      ok: false,
      latencyMs: 0,
      error: configError(`Unknown provider "${String(providerInput)}".`)
    };
  }

  const baseUrl = stripTrailingSlash((options.baseUrl ?? '').trim() || provider.baseUrl);
  if (!baseUrl) {
    return {
      models: [],
      ok: false,
      latencyMs: Date.now() - started,
      error: configError('No base URL configured for this provider.', 'Set an OpenAI-compatible base URL (…/v1).')
    };
  }

  const apiKey = requestCredential(provider, options);
  const url = `${baseUrl}/models`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const outcome = await fetchWithTimeout(url, { method: 'GET', headers }, options.timeoutMs ?? MODELS_TIMEOUT_MS);
  if ('error' in outcome) {
    return { models: [], ok: false, latencyMs: Date.now() - started, error: outcome.error };
  }

  const response = outcome.response;
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    return { models: [], ok: false, latencyMs: Date.now() - started, error: statusError(response.status, text, url) };
  }

  let payload: unknown = null;
  try {
    payload = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return {
      models: [],
      ok: false,
      latencyMs: Date.now() - started,
      error: {
        code: 'PROVIDER_BAD_RESPONSE',
        status: response.status,
        message: `The models endpoint returned something that is not JSON.${bodySnippet(text)}`,
        hint: 'Check the base URL points at an OpenAI-compatible /v1 path.'
      }
    };
  }

  const models = parseModelIds(payload);
  if (models.length === 0) {
    return {
      models: [],
      ok: false,
      latencyMs: Date.now() - started,
      error: {
        code: 'PROVIDER_BAD_RESPONSE',
        status: response.status,
        message: 'The models endpoint answered but returned no model ids.',
        hint: 'Expected an OpenAI-style {"data":[{"id":"…"}]} list (Ollama also serves that at /v1/models).'
      }
    };
  }

  return { models, ok: true, latencyMs: Date.now() - started, error: null };
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

export type ProviderTestInput = ProviderRequestOptions & {
  providerId?: string;
};

export type ProviderTestResult = {
  ok: boolean;
  latencyMs: number;
  model: string;
  error: ProviderError | null;
};

function testFailure(started: number, model: string, error: ProviderError): ProviderTestResult {
  return { ok: false, latencyMs: Date.now() - started, model, error };
}

/**
 * Minimal `/chat/completions` round trip ("say ok"). Never throws: wrong keys,
 * wrong paths and dead endpoints all come back as `{ ok:false, error }`.
 */
export async function testProvider(input: ProviderTestInput = {}): Promise<ProviderTestResult> {
  const started = Date.now();
  const env = input.env ?? process.env;
  const explicitId = (input.providerId ?? '').trim().toLowerCase();
  const resolved = explicitId
    ? null
    : resolveLlm({ env, workspaceId: input.workspaceId, reader: input.reader });
  const providerId = explicitId || resolved?.providerId || 'none';

  if (providerId === 'none') {
    return testFailure(
      started,
      '',
      configError('No LLM provider is selected.', 'Pick a provider and save a key (or run fully local with Ollama).')
    );
  }

  const provider = findLlmProvider(providerId);
  if (!provider) {
    return testFailure(
      started,
      '',
      configError(`Unknown provider "${providerId}".`, `Valid providers: ${LLM_PROVIDERS.map((p) => p.id).join(', ')}.`)
    );
  }

  const store = input.workspaceId
    ? readWorkspaceLlmStore(input.workspaceId, input.reader)
    : { providerId: null, model: null, baseUrl: null, apiKey: null };
  const storedBase = store.providerId === providerId ? store.baseUrl : null;
  const storedModel = store.providerId === providerId ? store.model : null;
  const resolvedBase = resolved && resolved.providerId === providerId ? resolved.baseUrl : '';
  const resolvedModel = resolved && resolved.providerId === providerId ? resolved.model : '';

  const baseUrl = stripTrailingSlash(
    (input.baseUrl ?? '').trim() || storedBase || resolvedBase || provider.baseUrl
  );
  if (!baseUrl) {
    return testFailure(
      started,
      '',
      configError('No base URL configured for this provider.', 'Set an OpenAI-compatible base URL (…/v1).')
    );
  }

  const apiKey = requestCredential(provider, { ...input, env });
  if (provider.requiresKey && !apiKey) {
    return testFailure(
      started,
      '',
      configError('No API key is configured for this provider.', `Set ${provider.keyEnv[0] ?? 'an API key'} or save a key in the dashboard.`)
    );
  }

  let model = (input.model ?? '').trim() || storedModel || resolvedModel || provider.defaultModel || '';
  if (!model) {
    const discovery = await discoverModels(provider, { ...input, env, apiKey, baseUrl });
    if (!discovery.ok || discovery.models.length === 0) {
      return testFailure(
        started,
        '',
        discovery.error ?? configError('Could not pick a model to test with.', 'Set a model id explicitly.')
      );
    }
    model = discovery.models[0];
  }

  const url = `${baseUrl}/chat/completions`;
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Reply with the single word "ok".' }],
    max_tokens: 8,
    temperature: 0,
    stream: false
  });

  const outcome = await fetchWithTimeout(
    url,
    { method: 'POST', headers, body },
    input.timeoutMs ?? TEST_TIMEOUT_MS
  );
  if ('error' in outcome) return testFailure(started, model, outcome.error);

  const response = outcome.response;
  const text = await response.text().catch(() => '');
  if (!response.ok) return testFailure(started, model, statusError(response.status, text, url));

  let payload: unknown = null;
  try {
    payload = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return testFailure(
      started,
      model,
      {
        code: 'PROVIDER_BAD_RESPONSE',
        status: response.status,
        message: `The chat endpoint answered with non-JSON.${bodySnippet(text)}`,
        hint: 'The base URL is probably not an OpenAI-compatible API root.'
      }
    );
  }

  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  const choices = record?.choices;
  const looksLikeCompletion =
    Array.isArray(choices) && choices.length > 0
      ? true
      : Boolean(record && typeof record.model === 'string' && 'usage' in record);
  if (!looksLikeCompletion) {
    return testFailure(
      started,
      model,
      {
        code: 'PROVIDER_BAD_RESPONSE',
        status: response.status,
        message: 'The endpoint answered but did not return an OpenAI chat completion.',
        hint: 'Check the base URL ends in /v1 and the provider is OpenAI-compatible.'
      }
    );
  }

  const repliedModel = record && typeof record.model === 'string' && record.model.trim() ? record.model.trim() : model;
  return { ok: true, latencyMs: Date.now() - started, model: repliedModel, error: null };
}
