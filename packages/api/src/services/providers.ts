/**
 * Workspace BYOK settings: DB reads/writes for `workspace_settings` plus the
 * catalog-with-status view the dashboard consumes.
 *
 * Security contract enforced here:
 * - a stored provider key is encrypted with core `encryptJson` before it touches
 *   SQLite, and is decrypted only to test it or to compute a `keyHint`;
 * - the API never returns the key itself (only `sk-…abcd`), and never logs it.
 */

import { nowIso } from '../../../core/src/ids.ts';
import { ApiError } from '../../../core/src/http.ts';
import {
  LLM_PROVIDERS,
  TTS_PROVIDERS,
  findLlmProvider,
  findTtsProvider,
  defaultSettingsReader,
  detectLocalProviders,
  discoverModels,
  maskKey,
  normalizeBaseUrl,
  providerSpecificEnvKey,
  readWorkspaceLlmStore,
  readWorkspaceTtsStore,
  resolveLlm,
  resolveTts,
  sealSecret,
  testProvider,
  LLM_SETTING_KEYS,
  TTS_SETTING_KEYS,
  type LlmProvider,
  type LlmTier,
  type ProviderSource,
  type ProviderTestResult,
  type WorkspaceSettingsReader
} from '../../../providers/src/index.ts';
import type { AuthContext } from '../auth.ts';
import { run } from '../dbq.ts';

// ---------------------------------------------------------------------------
// Wire types (frozen with the dashboard — see docs/PROVIDERS.md)
// ---------------------------------------------------------------------------

export type LlmActiveView = {
  providerId: string;
  model: string | null;
  baseUrl: string | null;
  source: ProviderSource;
  /** True when a key/local server was found automatically (no explicit choice). */
  detected: boolean;
};

export type LlmProviderView = {
  id: string;
  label: string;
  baseUrl: string;
  requiresKey: boolean;
  defaultModel: string;
  helpUrl: string | null;
  note: string | null;
  configured: boolean;
  source: ProviderSource;
  keyHint: string | null;
  model: string | null;
  tier: LlmTier;
  /** True for the card the auto-detect chose. */
  detected: boolean;
};

export type LlmStatusView = {
  active: LlmActiveView;
  providers: LlmProviderView[];
};

export type TtsActiveView = {
  providerId: string;
  voice: string | null;
  source: ProviderSource;
};

export type TtsProviderView = {
  id: string;
  label: string;
  requiresKey: boolean;
  offline: boolean;
  configured: boolean;
};

export type TtsStatusView = {
  active: TtsActiveView;
  providers: TtsProviderView[];
};

export type ProviderStatusView = {
  llm: LlmStatusView;
  tts: TtsStatusView;
};

export type LlmProviderInput = {
  providerId?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
};

export type TtsProviderInput = {
  providerId?: string;
  voice?: string;
};

export type ProviderSaveInput = {
  llm?: LlmProviderInput;
  tts?: TtsProviderInput;
};

export type ModelListResult = {
  models: string[];
  source: 'live' | 'default';
  message: string;
};

// ---------------------------------------------------------------------------
// Workspace settings writes
// ---------------------------------------------------------------------------

function reader(): WorkspaceSettingsReader {
  return defaultSettingsReader();
}

function upsertSetting(workspaceId: string, key: string, valueJson: string): void {
  run(
    `INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    workspaceId,
    key,
    valueJson,
    nowIso()
  );
}

function deleteSetting(workspaceId: string, key: string): void {
  run('DELETE FROM workspace_settings WHERE workspace_id = ? AND key = ?', workspaceId, key);
}

function deleteKeys(workspaceId: string, keys: readonly string[]): string[] {
  for (const key of keys) deleteSetting(workspaceId, key);
  return [...keys];
}

/** Validate a user-supplied base URL or throw Director's VALIDATION_ERROR. */
function validateBaseUrl(value: string): string {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'baseUrl must be an absolute http(s) URL, e.g. http://127.0.0.1:11434/v1.',
      { action: 'fix_request', hint: 'OpenAI-compatible gateways usually expose a path ending in /v1.' }
    );
  }
  return normalized;
}

function requireProvider(providerId: string): LlmProvider {
  const provider = findLlmProvider(providerId);
  if (!provider) {
    throw new ApiError('VALIDATION_ERROR', `Unknown LLM provider "${providerId}".`, {
      action: 'fix_request',
      hint: `Valid providers: ${LLM_PROVIDERS.map((p) => p.id).join(', ')}. Use "none" to clear the workspace override.`
    });
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Reads / status
// ---------------------------------------------------------------------------

function envValue(name: string): string {
  const raw = process.env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * GET /api/providers — the catalog plus what is actually in effect.
 *
 * `source` is `env` when an environment variable is in effect for that provider,
 * `workspace` when the dashboard-saved setting is, and `none` otherwise.
 * `keyHint` is the only key material ever returned.
 */
export function providerStatus(auth: AuthContext): ProviderStatusView {
  const workspaceId = auth.workspaceId;
  const settingsReader = reader();
  const llmStore = readWorkspaceLlmStore(workspaceId, settingsReader);
  const ttsStore = readWorkspaceTtsStore(workspaceId, settingsReader);
  const resolvedLlm = resolveLlm({ workspaceId, reader: settingsReader });
  const resolvedTts = resolveTts({ workspaceId, reader: settingsReader });
  const explicitEnvProvider = envValue('REELFORGE_LLM_PROVIDER').toLowerCase();
  const explicitEnvTts = envValue('REELFORGE_TTS_PROVIDER').toLowerCase();

  const llmActive: LlmActiveView = {
    providerId: resolvedLlm.source === 'none' ? 'none' : resolvedLlm.providerId,
    model: resolvedLlm.model || null,
    baseUrl: resolvedLlm.baseUrl || null,
    source: resolvedLlm.source,
    detected: resolvedLlm.detected
  };

  const llmProviders: LlmProviderView[] = LLM_PROVIDERS.map((provider) => {
    const inEffect = resolvedLlm.source !== 'none' && resolvedLlm.providerId === provider.id;
    const specificEnv = providerSpecificEnvKey(provider);
    const workspaceMatch = llmStore.providerId === provider.id;
    const workspaceConfigured = workspaceMatch && (Boolean(llmStore.apiKey) || !provider.requiresKey);

    let source: ProviderSource = 'none';
    if (inEffect) source = resolvedLlm.source;
    else if (specificEnv) source = 'env';
    else if (workspaceConfigured) source = 'workspace';

    const keyValue = inEffect
      ? resolvedLlm.apiKey || null
      : specificEnv?.value ?? (workspaceMatch ? llmStore.apiKey : null);
    const model = inEffect
      ? resolvedLlm.model || null
      : workspaceMatch
        ? llmStore.model || provider.defaultModel || null
        : provider.defaultModel || null;

    return {
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      requiresKey: provider.requiresKey,
      defaultModel: provider.defaultModel,
      helpUrl: provider.helpUrl ?? null,
      note: provider.note ?? null,
      configured: Boolean(inEffect || specificEnv || workspaceConfigured),
      source,
      keyHint: maskKey(keyValue),
      model,
      tier: provider.tier,
      detected: Boolean(inEffect && resolvedLlm.detected)
    };
  });

  // If env explicitly selects a provider, reflect that even when the card's
  // provider-specific key variable is not the source of the credential.
  if (explicitEnvProvider && explicitEnvProvider !== 'auto' && explicitEnvProvider !== 'none') {
    const card = llmProviders.find((provider) => provider.id === explicitEnvProvider);
    if (card && resolvedLlm.source === 'env' && resolvedLlm.providerId === card.id) {
      card.source = 'env';
      card.configured = true;
    }
  }

  const ttsActive: TtsActiveView = {
    providerId: resolvedTts.providerId,
    voice: resolvedTts.voice || null,
    source: resolvedTts.source
  };

  const ttsProviders: TtsProviderView[] = TTS_PROVIDERS.map((provider) => {
    const inEffect = resolvedTts.source !== 'none' && resolvedTts.providerId === provider.id;
    const envKeyPresent = (provider.keyEnv ?? []).some((name) => Boolean(envValue(name)));
    const envSelected = explicitEnvTts === provider.id;
    const workspaceMatch = ttsStore.providerId === provider.id;
    const keyed = provider.requiresKey;
    return {
      id: provider.id,
      label: provider.label,
      requiresKey: keyed,
      offline: provider.offline === true,
      configured: Boolean(
        inEffect ||
          (keyed ? envKeyPresent : envSelected) ||
          (workspaceMatch && (!keyed || Boolean(ttsStore.apiKey))) ||
          provider.offline === true ||
          provider.id === 'none'
      )
    };
  });

  return { llm: { active: llmActive, providers: llmProviders }, tts: { active: ttsActive, providers: ttsProviders } };
}

/**
 * GET /api/providers — refresh the short local-server probe (cached for a
 * minute) before assembling the status, so "install Ollama and run" shows up as
 * the active provider with `detected: true`.
 */
export async function providerStatusWithDetection(auth: AuthContext): Promise<ProviderStatusView> {
  await detectLocalProviders();
  return providerStatus(auth);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function saveLlm(auth: AuthContext, input: LlmProviderInput): void {
  const rawProviderId = (input.providerId ?? '').trim().toLowerCase();
  if (!rawProviderId) {
    throw new ApiError('VALIDATION_ERROR', 'llm.providerId is required.', { action: 'fix_request' });
  }

  // `none` (and a legacy empty value) clears the workspace override; env still wins.
  if (rawProviderId === 'none') {
    deleteKeys(auth.workspaceId, [
      LLM_SETTING_KEYS.provider,
      LLM_SETTING_KEYS.model,
      LLM_SETTING_KEYS.baseUrl,
      LLM_SETTING_KEYS.apiKey
    ]);
    return;
  }

  const provider = requireProvider(rawProviderId);
  const before = readWorkspaceLlmStore(auth.workspaceId, reader());
  const switching = before.providerId !== provider.id;

  const providedBase = input.baseUrl === undefined ? undefined : input.baseUrl.trim();
  const normalizedBase = providedBase ? validateBaseUrl(providedBase) : null;
  const prospectiveBase = normalizedBase ?? (switching ? null : before.baseUrl);
  if (!prospectiveBase && !provider.baseUrl) {
    throw new ApiError('VALIDATION_ERROR', `${provider.label} needs a baseUrl.`, {
      action: 'fix_request',
      hint:
        provider.id === 'azure-openai'
          ? 'Set baseUrl to https://<resource>.openai.azure.com/openai/deployments/<deployment> and model to the deployment name.'
          : 'Send { "llm": { "providerId": "custom", "baseUrl": "https://gateway.example/v1", "model": "…" } }.'
    });
  }

  upsertSetting(auth.workspaceId, LLM_SETTING_KEYS.provider, JSON.stringify(provider.id));
  if (switching) {
    deleteSetting(auth.workspaceId, LLM_SETTING_KEYS.model);
    deleteSetting(auth.workspaceId, LLM_SETTING_KEYS.baseUrl);
    deleteSetting(auth.workspaceId, LLM_SETTING_KEYS.apiKey);
  }

  if (input.model !== undefined) {
    const model = input.model.trim();
    if (model) upsertSetting(auth.workspaceId, LLM_SETTING_KEYS.model, JSON.stringify(model));
    else deleteSetting(auth.workspaceId, LLM_SETTING_KEYS.model);
  }

  if (input.baseUrl !== undefined) {
    if (normalizedBase) upsertSetting(auth.workspaceId, LLM_SETTING_KEYS.baseUrl, JSON.stringify(normalizedBase));
    else deleteSetting(auth.workspaceId, LLM_SETTING_KEYS.baseUrl);
  }

  if (input.apiKey !== undefined) {
    const apiKey = input.apiKey.trim();
    if (apiKey) upsertSetting(auth.workspaceId, LLM_SETTING_KEYS.apiKey, sealSecret({ apiKey }));
    else deleteSetting(auth.workspaceId, LLM_SETTING_KEYS.apiKey);
  }
}

function saveTts(auth: AuthContext, input: TtsProviderInput): void {
  const providerId = (input.providerId ?? '').trim().toLowerCase();
  if (!providerId) {
    throw new ApiError('VALIDATION_ERROR', 'tts.providerId is required.', { action: 'fix_request' });
  }
  const provider = findTtsProvider(providerId);
  if (!provider) {
    throw new ApiError('VALIDATION_ERROR', `Unknown TTS provider "${providerId}".`, {
      action: 'fix_request',
      hint: `Valid providers: ${TTS_PROVIDERS.map((p) => p.id).join(', ')}.`
    });
  }

  const before = readWorkspaceTtsStore(auth.workspaceId, reader());
  const switching = before.providerId !== provider.id;
  upsertSetting(auth.workspaceId, TTS_SETTING_KEYS.provider, JSON.stringify(provider.id));
  if (switching) {
    deleteSetting(auth.workspaceId, TTS_SETTING_KEYS.model);
    deleteSetting(auth.workspaceId, TTS_SETTING_KEYS.apiKey);
  }
  if (input.voice !== undefined) {
    const voice = input.voice.trim();
    if (voice) upsertSetting(auth.workspaceId, TTS_SETTING_KEYS.voice, JSON.stringify(voice));
    else deleteSetting(auth.workspaceId, TTS_SETTING_KEYS.voice);
  }
}

/**
 * POST /api/providers — save a provider selection (and optionally a key/model/
 * base URL). Returns the fresh status view, never the stored key.
 */
export function saveProviders(auth: AuthContext, input: ProviderSaveInput): ProviderStatusView {
  if (!input.llm && !input.tts) {
    throw new ApiError('VALIDATION_ERROR', 'Nothing to update: send `llm` and/or `tts`.', {
      action: 'fix_request',
      hint: 'Example: { "llm": { "providerId": "gmi", "apiKey": "…", "model": "…" } }.'
    });
  }
  if (input.llm) saveLlm(auth, input.llm);
  if (input.tts) saveTts(auth, input.tts);
  return providerStatus(auth);
}

/** DELETE /api/providers — clear every workspace override (env still wins). */
export function clearProviders(auth: AuthContext): ProviderStatusView {
  deleteKeys(auth.workspaceId, [
    LLM_SETTING_KEYS.provider,
    LLM_SETTING_KEYS.model,
    LLM_SETTING_KEYS.baseUrl,
    LLM_SETTING_KEYS.apiKey,
    TTS_SETTING_KEYS.provider,
    TTS_SETTING_KEYS.voice,
    TTS_SETTING_KEYS.model,
    TTS_SETTING_KEYS.apiKey
  ]);
  return providerStatus(auth);
}

// ---------------------------------------------------------------------------
// Probe endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/providers/models — live discovery with the workspace/env credential.
 * Falls back to the catalog's default model so the UI always has a usable value.
 */
export async function listProviderModels(
  auth: AuthContext,
  providerIdRaw: string,
  baseUrlRaw?: string
): Promise<ModelListResult> {
  const providerId = (providerIdRaw ?? '').trim().toLowerCase();
  const provider = findLlmProvider(providerId);
  if (!provider) {
    throw new ApiError('VALIDATION_ERROR', `Unknown LLM provider "${providerId}".`, {
      action: 'fix_request',
      hint: `Valid providers: ${LLM_PROVIDERS.map((p) => p.id).join(', ')}.`
    });
  }

  let baseUrl: string | undefined;
  if (baseUrlRaw && baseUrlRaw.trim()) {
    baseUrl = validateBaseUrl(baseUrlRaw.trim());
  } else {
    // Custom gateways keep their base URL in the workspace; use it for discovery.
    const store = readWorkspaceLlmStore(auth.workspaceId, reader());
    if (store.providerId === provider.id && store.baseUrl) baseUrl = validateBaseUrl(store.baseUrl);
  }

  const discovery = await discoverModels(provider, { workspaceId: auth.workspaceId, baseUrl });
  if (discovery.ok) {
    return {
      models: discovery.models,
      source: 'live',
      message: `${discovery.models.length} models from ${provider.label}.`
    };
  }

  const fallback = provider.defaultModel ? [provider.defaultModel] : [];
  const error = discovery.error;
  const detail = error ? `${error.code}: ${error.message}` : 'unknown error';
  return {
    models: fallback,
    source: 'default',
    message: `Live model discovery failed (${detail}). ${fallback.length ? 'Showing the catalog default.' : 'Set the base URL and key, then retry.'}`
  };
}

/**
 * POST /api/providers/test — probe the selected provider. A provider-side
 * failure is a normal result (`ok:false` + typed error), not an API error.
 */
export async function runProviderTest(
  auth: AuthContext,
  input: { providerId: string; apiKey?: string; baseUrl?: string; model?: string }
): Promise<ProviderTestResult> {
  const providerId = (input.providerId ?? '').trim().toLowerCase();
  if (!providerId || providerId === 'none') {
    throw new ApiError('VALIDATION_ERROR', 'providerId is required and cannot be "none".', {
      action: 'fix_request',
      hint: `Valid providers: ${LLM_PROVIDERS.map((p) => p.id).join(', ')}.`
    });
  }
  let baseUrl = input.baseUrl?.trim() || undefined;
  if (baseUrl) baseUrl = validateBaseUrl(baseUrl);

  return testProvider({
    providerId,
    apiKey: input.apiKey,
    baseUrl,
    model: input.model,
    workspaceId: auth.workspaceId
  });
}
