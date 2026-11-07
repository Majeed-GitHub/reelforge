/**
 * Self-test for the Reelforge BYOK provider layer.
 *
 *   node packages/providers/test/providers-selftest.ts
 *
 * Proves, without any real API key:
 *  a) resolution precedence — env beats workspace beats none;
 *  b) a workspace key survives encrypt/decrypt and never appears in API output
 *     (only a `sk-…abcd` hint does);
 *  c) wrong keys, 404s, dead and slow endpoints produce typed failures instead
 *     of crashes;
 *  d) OpenAI-style `{data:[{id}]}` (and Ollama `{models:[{name}]}`) discovery is
 *     parsed correctly.
 *
 * A local stub HTTP server stands in for the providers. The database lives in a
 * throwaway temp data dir, so `data/` is never touched. Exits 0 only when every
 * check passes.
 */

import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

// The core config reads REELFORGE_DATA_DIR at import time, so it must be set
// before anything from packages/core is imported (all of that is dynamic below).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'reelforge-providers-selftest-'));
process.env.REELFORGE_DATA_DIR = TMP_DATA;

const PROVIDER_ENV_VARS = [
  'REELFORGE_LLM_PROVIDER',
  'REELFORGE_LLM_BASE_URL',
  'REELFORGE_LLM_API_KEY',
  'REELFORGE_LLM_MODEL',
  'REELFORGE_TTS_PROVIDER',
  'REELFORGE_TTS_VOICE',
  'REELFORGE_WORKSPACE_ID',
  'GMI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'CEREBRAS_API_KEY',
  'NVIDIA_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
  'SAMBANOVA_API_KEY',
  'DEEPINFRA_API_KEY',
  'NEBIUS_API_KEY',
  'NOVITA_API_KEY',
  'HYPERBOLIC_API_KEY',
  'MOONSHOT_API_KEY',
  'ZHIPUAI_API_KEY',
  'ZHIPU_API_KEY',
  'DASHSCOPE_API_KEY',
  'PERPLEXITY_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_API_VERSION',
  'ELEVENLABS_API_KEY'
];

function clearProviderEnv(): void {
  for (const name of PROVIDER_ENV_VARS) delete process.env[name];
}

clearProviderEnv();
// Keep the real machine's Ollama/LM Studio out of the deterministic tests; the
// local-probe section passes an explicit env + stub target to test it.
process.env.REELFORGE_LLM_LOCAL_PROBE = 'off';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// Dynamic imports only: env (data dir) must be in place first.
const providers = await import('../src/index.ts');
const coreDb = await import('../../core/src/db.ts');
const coreIds = await import('../../core/src/ids.ts');
const coreHttp = await import('../../core/src/http.ts');
const apiServices = await import('../../api/src/services/providers.ts');
const apiRoutes = await import('../../api/src/routes/providers.ts');
const apiAuth = await import('../../api/src/auth.ts');
const plannerModule = await import('../../agent/src/planner/index.ts');
const Fastify = (await import('fastify')).default;

// ---------------------------------------------------------------------------
// Database fixtures (one workspace => the agent can resolve it by default)
// ---------------------------------------------------------------------------

const db = coreDb.getDb();
const NOW = new Date().toISOString();
const WORKSPACE_ID = 'ws_selftest';
const API_KEY = 'rg_0123456789abcdef0123456789abcdef';
db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(WORKSPACE_ID, 'Selftest', NOW);
db.prepare(
  'INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'
).run('key_selftest', WORKSPACE_ID, 'selftest', API_KEY.slice(0, 10), coreIds.sha256(API_KEY), NOW);

const auth = {
  workspaceId: WORKSPACE_ID,
  apiKeyId: 'key_selftest',
  keyName: 'selftest',
  prefix: API_KEY.slice(0, 10)
};

const WORKSPACE_SECRET = 'sk-workspace-secret-abcd1234';
const STUB_KEY = 'stub-key-abcdefghijklmnop';
const ANTHROPIC_STUB_KEY = 'sk-ant-selftest-0001';
const AZURE_STUB_KEY = 'az-selftest-key-0001';

// ---------------------------------------------------------------------------
// Stub provider server (OpenAI-compatible + Anthropic Messages + Azure)
// ---------------------------------------------------------------------------

type CapturedRequest = {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
};
const captured: CapturedRequest[] = [];

const stub = http.createServer((request, response) => {
  const url = request.url ?? '/';
  const authorization = String(request.headers.authorization ?? '');
  const send = (status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const readBody = (): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      request.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}') as Record<string, unknown>);
        } catch {
          resolve({});
        }
      });
    });

  if (url === '/v1/models') {
    if (authorization !== `Bearer ${STUB_KEY}`) {
      send(401, { error: { message: 'invalid api key' } });
      return;
    }
    send(200, {
      object: 'list',
      data: [{ id: 'stub-gamma' }, { id: 'stub-alpha' }, { id: 'stub-beta' }]
    });
    return;
  }

  if (url === '/v1-empty/models') {
    send(200, { object: 'list', data: [] });
    return;
  }

  if (url === '/keyless/models') {
    send(200, { models: [{ name: 'llama3:latest' }, { name: 'qwen2.5:7b' }] });
    return;
  }

  if (url === '/v1/chat/completions') {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    request.on('end', () => {
      if (authorization !== `Bearer ${STUB_KEY}`) {
        send(401, { error: { message: 'invalid api key' } });
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw || '{}') as Record<string, unknown>;
      } catch {
        body = {};
      }
      if (body.model === 'missing-model') {
        send(404, { error: { message: 'the model does not exist' } });
        return;
      }
      send(200, {
        id: 'chatcmpl-selftest',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 }
      });
    });
    return;
  }

  if (url === '/local/models') {
    send(200, { object: 'list', data: [{ id: 'local-model-alpha' }, { id: 'local-model-beta' }] });
    return;
  }

  // Anthropic Messages API stub: x-api-key auth, translated body.
  if (url === '/anthropic/v1/messages') {
    void readBody().then((body) => {
      captured.push({ url, headers: request.headers, body });
      if (request.headers['x-api-key'] !== ANTHROPIC_STUB_KEY) {
        send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
        return;
      }
      const content =
        body.model === 'claude-planner'
          ? '{"kind":"done","narration":"The demo is complete."}'
          : 'ok';
      send(200, {
        id: 'msg_selftest',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: content }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 1 }
      });
    });
    return;
  }

  // Azure OpenAI stub: api-key header + api-version query.
  if (url.startsWith('/azure/')) {
    void readBody().then((body) => {
      captured.push({ url, headers: request.headers, body });
      if (request.headers['api-key'] !== AZURE_STUB_KEY) {
        send(401, { error: { message: 'invalid api-key' } });
        return;
      }
      send(200, {
        id: 'chatcmpl-azure',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }
      });
    });
    return;
  }

  if (url.startsWith('/slow/')) {
    // Never answer: exercises the timeout path.
    return;
  }

  send(404, { error: { message: `no stub route for ${url}` } });
});

await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
const stubPort = (stub.address() as AddressInfo).port;
const stubBase = `http://127.0.0.1:${stubPort}/v1`;
const emptyBase = `http://127.0.0.1:${stubPort}/v1-empty`;
const keylessBase = `http://127.0.0.1:${stubPort}/keyless`;
const slowBase = `http://127.0.0.1:${stubPort}/slow`;
const localProbeBase = `http://127.0.0.1:${stubPort}/local`;
const anthropicBase = `http://127.0.0.1:${stubPort}/anthropic/v1`;
const azureBase = `http://127.0.0.1:${stubPort}/azure/openai/deployments/gpt-4o`;

/** A base URL on which nothing is listening (connection refused). */
async function unreachableBase(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1`;
}

// ---------------------------------------------------------------------------
// 1. maskKey / encryption primitives
// ---------------------------------------------------------------------------

check('maskKey keeps only a hint', providers.maskKey('sk-abcdef123456') === 'sk-…3456', String(providers.maskKey('sk-abcdef123456')));
check('maskKey returns null for no key', providers.maskKey('') === null && providers.maskKey(null) === null);
check('maskKey never echoes a short key', providers.maskKey('abc') === '…', String(providers.maskKey('abc')));

const sealed = providers.sealSecret({ apiKey: 'sk-round-trip-0000' });
check('sealSecret encrypts (no plaintext in the blob)', sealed.startsWith('"v1.') && !sealed.includes('sk-round-trip-0000'), sealed.slice(0, 16) + '…');
const opened = providers.openSecret(sealed) as { apiKey?: string };
check('openSecret decrypts the round trip', opened?.apiKey === 'sk-round-trip-0000', String(opened?.apiKey));

// ---------------------------------------------------------------------------
// 1b. v0.3 catalog: universal provider coverage (data, not special cases)
// ---------------------------------------------------------------------------

const catalog = providers.LLM_PROVIDERS;
check('catalog covers 30+ providers', catalog.length >= 30, `${catalog.length} providers`);
const catalogIds = catalog.map((provider) => provider.id);
check('catalog ids are unique', new Set(catalogIds).size === catalogIds.length, `${catalogIds.length} ids`);
check(
  'LLM_PROVIDER_IDS mirrors the catalog order',
  providers.LLM_PROVIDER_IDS.length === catalog.length &&
    providers.LLM_PROVIDER_IDS.every((id: string, index: number) => catalog[index]?.id === id)
);

const tierProblems: string[] = [];
const keyProblems: string[] = [];
const urlProblems: string[] = [];
for (const provider of catalog) {
  if (provider.tier !== 'free' && provider.tier !== 'paid' && provider.tier !== 'local') {
    tierProblems.push(`${provider.id}:${String(provider.tier)}`);
  }
  if (provider.requiresKey) {
    if (!Array.isArray(provider.keyEnv) || provider.keyEnv.length === 0) keyProblems.push(`${provider.id}:no keyEnv`);
    if (!provider.keyEnv?.includes('REELFORGE_LLM_API_KEY')) {
      keyProblems.push(`${provider.id}:no shared fallback`);
    }
    if (!provider.keyEnv?.every((name: string) => /^[A-Z0-9_]+$/.test(name))) {
      keyProblems.push(`${provider.id}:bad env name`);
    }
  } else if (provider.id !== 'custom' && provider.tier !== 'local') {
    keyProblems.push(`${provider.id}:keyless but tier=${provider.tier}`);
  }
  if (provider.userSuppliedBaseUrl) continue;
  try {
    const parsed = new URL(provider.baseUrl);
    const protocolOk =
      provider.tier === 'local'
        ? parsed.protocol === 'http:' || parsed.protocol === 'https:'
        : parsed.protocol === 'https:';
    if (!protocolOk) urlProblems.push(`${provider.id}:${provider.baseUrl}`);
  } catch {
    urlProblems.push(`${provider.id}:${provider.baseUrl || '(empty)'}`);
  }
}
check('every provider has a free/paid/local tier', tierProblems.length === 0, tierProblems.join(', '));
check('every keyed provider has key env vars incl. the shared fallback', keyProblems.length === 0, keyProblems.join(', '));
check(
  'every provider has an https base URL (http only for local presets)',
  urlProblems.length === 0,
  urlProblems.join(', ')
);

const anthropicEntry = catalog.find((provider) => provider.id === 'anthropic');
check(
  'Anthropic declares the Messages protocol, x-api-key auth and the version header',
  anthropicEntry?.protocol === 'anthropic-messages' &&
    anthropicEntry?.authStyle === 'x-api-key' &&
    anthropicEntry?.extraHeaders?.['anthropic-version'] === '2023-06-01'
);
const azureEntry = catalog.find((provider) => provider.id === 'azure-openai');
check(
  'Azure declares the api-key header, api-version query and a user-supplied URL',
  azureEntry?.authStyle === 'api-key-header' &&
    Boolean(azureEntry?.extraQuery?.['api-version']) &&
    azureEntry?.userSuppliedBaseUrl === true
);
const geminiEntry = catalog.find((provider) => provider.id === 'google-gemini');
check(
  'Gemini keeps its /openai compatibility suffix',
  /\/v1beta\/openai$/.test(geminiEntry?.baseUrl ?? ''),
  geminiEntry?.baseUrl ?? ''
);
check(
  'local presets include Ollama, LM Studio, llama.cpp, vLLM and LocalAI',
  ['ollama', 'lmstudio', 'llamacpp', 'vllm', 'localai'].every((id) => catalogIds.includes(id))
);

// --- Transport quirks are data and build the right request ------------------

const anthropicRequest = providers.buildChatRequest({
  providerId: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: 'sk-ant-builder',
  model: 'claude-builder',
  messages: [
    { role: 'system', content: 'SYSTEM RULES' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
      ]
    }
  ],
  maxTokens: 64,
  temperature: 0
});
check(
  'Anthropic adapter posts to /v1/messages',
  anthropicRequest.url === 'https://api.anthropic.com/v1/messages',
  anthropicRequest.url
);
check(
  'Anthropic auth uses x-api-key plus anthropic-version (no bearer)',
  anthropicRequest.headers['x-api-key'] === 'sk-ant-builder' &&
    anthropicRequest.headers['anthropic-version'] === '2023-06-01' &&
    !anthropicRequest.headers.authorization
);
const anthropicMessages = anthropicRequest.body.messages as Array<{ role: string; content: unknown }>;
const anthropicBlocks = anthropicMessages[0]?.content as Array<Record<string, unknown>>;
const imageBlock = anthropicBlocks?.[1] as
  | { type?: string; source?: { type?: string; media_type?: string; data?: string } }
  | undefined;
check(
  'Anthropic adapter lifts system and translates the screenshot to a base64 image block',
  anthropicRequest.body.system === 'SYSTEM RULES' &&
    anthropicMessages.length === 1 &&
    anthropicMessages[0]?.role === 'user' &&
    imageBlock?.type === 'image' &&
    imageBlock?.source?.type === 'base64' &&
    imageBlock?.source?.media_type === 'image/png' &&
    imageBlock?.source?.data === 'AAAA'
);
check('Anthropic adapter forwards max_tokens', anthropicRequest.body.max_tokens === 64);
check(
  'extractChatText joins Anthropic text blocks',
  providers.extractChatText({ content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] }, 'anthropic') ===
    'hello world'
);

const azureRequest = providers.buildChatRequest({
  providerId: 'azure-openai',
  baseUrl: 'https://example-resource.openai.azure.com/openai/deployments/gpt-4o',
  apiKey: 'az-builder-key',
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
  env: { AZURE_OPENAI_API_VERSION: '2025-02-01' }
});
check(
  'Azure builds the api-key header and the api-version query',
  azureRequest.url ===
    'https://example-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-02-01' &&
    azureRequest.headers['api-key'] === 'az-builder-key' &&
    !azureRequest.headers.authorization,
  azureRequest.url
);
const azureDefaultRequest = providers.buildChatRequest({
  providerId: 'azure-openai',
  baseUrl: 'https://example-resource.openai.azure.com/openai/deployments/gpt-4o',
  apiKey: 'az-builder-key',
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
  env: {}
});
check(
  'Azure api-version has a documented default when unset',
  azureDefaultRequest.url.includes('api-version=2025-04-01-preview'),
  azureDefaultRequest.url
);

const geminiRequest = providers.buildChatRequest({
  providerId: 'google-gemini',
  baseUrl: geminiEntry?.baseUrl ?? '',
  apiKey: 'gemini-key',
  model: 'gemini-2.5-flash',
  messages: [{ role: 'user', content: 'hi' }]
});
check(
  'OpenAI-style providers keep the bearer header and /chat/completions path',
  geminiRequest.url === 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' &&
    geminiRequest.headers.authorization === 'Bearer gemini-key',
  geminiRequest.url
);

// ---------------------------------------------------------------------------
// 2. Save a workspace key through the real service
// ---------------------------------------------------------------------------

const saved = apiServices.saveProviders(auth, {
  llm: { providerId: 'openai', apiKey: WORKSPACE_SECRET, model: 'gpt-workspace' }
});
const savedOpenai = saved.llm.providers.find((provider) => provider.id === 'openai');
check(
  'POST service saves the provider and returns a masked hint',
  savedOpenai?.configured === true && savedOpenai?.keyHint === 'sk-…1234',
  String(savedOpenai?.keyHint)
);
check('saved status never contains the plaintext key', !JSON.stringify(saved).includes(WORKSPACE_SECRET));

const rawKeyRow = db
  .prepare('SELECT value_json FROM workspace_settings WHERE workspace_id = ? AND key = ?')
  .get(WORKSPACE_ID, 'llm.apiKey') as { value_json?: string } | undefined;
const rawValue = rawKeyRow?.value_json ?? '';
check(
  'workspace_settings stores ciphertext, not the key',
  rawValue.startsWith('"v1.') && !rawValue.includes(WORKSPACE_SECRET),
  rawValue.slice(0, 16) + '…'
);
const storedStore = providers.readWorkspaceLlmStore(WORKSPACE_ID);
check(
  'the stored key decrypts back to the same secret',
  storedStore.providerId === 'openai' && storedStore.apiKey === WORKSPACE_SECRET && storedStore.model === 'gpt-workspace',
  `${storedStore.providerId}/${storedStore.model}`
);

// ---------------------------------------------------------------------------
// 3. Resolution precedence
// ---------------------------------------------------------------------------

clearProviderEnv();
process.env.REELFORGE_LLM_PROVIDER = 'groq';
process.env.GROQ_API_KEY = 'gsk-env-selftest-1234567890';
process.env.REELFORGE_LLM_MODEL = 'env-model';
const envResolved = providers.resolveLlm({ workspaceId: WORKSPACE_ID });
check(
  'env wins over the workspace',
  envResolved.source === 'env' &&
    envResolved.providerId === 'groq' &&
    envResolved.baseUrl === 'https://api.groq.com/openai/v1' &&
    envResolved.apiKey === 'gsk-env-selftest-1234567890' &&
    envResolved.model === 'env-model',
  `${envResolved.providerId}/${envResolved.source}/${envResolved.model}`
);

clearProviderEnv();
const workspaceResolved = providers.resolveLlm({ workspaceId: WORKSPACE_ID });
check(
  'workspace wins when env is empty',
  workspaceResolved.source === 'workspace' &&
    workspaceResolved.providerId === 'openai' &&
    workspaceResolved.baseUrl === 'https://api.openai.com/v1' &&
    workspaceResolved.apiKey === WORKSPACE_SECRET &&
    workspaceResolved.model === 'gpt-workspace',
  `${workspaceResolved.providerId}/${workspaceResolved.source}/${workspaceResolved.model}`
);

const defaultWorkspaceResolved = providers.resolveLlm();
check(
  'a single-workspace instance resolves without an explicit workspace id',
  defaultWorkspaceResolved.source === 'workspace' && defaultWorkspaceResolved.providerId === 'openai',
  `${defaultWorkspaceResolved.providerId}/${defaultWorkspaceResolved.source}`
);

const emptyResolved = providers.resolveLlm({ workspaceId: 'ws_no_settings' });
check(
  'nothing configured resolves to source none',
  emptyResolved.source === 'none' && emptyResolved.providerId === 'none' && emptyResolved.apiKey === '',
  emptyResolved.source
);

process.env.REELFORGE_LLM_PROVIDER = 'none';
const disabledResolved = providers.resolveLlm({ workspaceId: WORKSPACE_ID });
check('REELFORGE_LLM_PROVIDER=none disables the planner even with a stored key', disabledResolved.source === 'none');
clearProviderEnv();

process.env.REELFORGE_LLM_PROVIDER = 'openai';
const mixedResolved = providers.resolveLlm({ workspaceId: WORKSPACE_ID });
check(
  'env can pick the provider while the workspace supplies the key',
  mixedResolved.source === 'workspace' && mixedResolved.providerId === 'openai' && mixedResolved.apiKey === WORKSPACE_SECRET,
  `${mixedResolved.providerId}/${mixedResolved.source}`
);
clearProviderEnv();

process.env.REELFORGE_LLM_PROVIDER = 'ollama';
const ollamaResolved = providers.resolveLlm({ workspaceId: 'ws_no_settings' });
check(
  'Ollama resolves with no key at all',
  ollamaResolved.source === 'env' &&
    ollamaResolved.providerId === 'ollama' &&
    ollamaResolved.apiKey === '' &&
    ollamaResolved.baseUrl === 'http://127.0.0.1:11434/v1',
  `${ollamaResolved.providerId}/${ollamaResolved.baseUrl}`
);
clearProviderEnv();

process.env.REELFORGE_LLM_API_KEY = 'sk-legacy-shared-0000';
const legacyResolved = providers.resolveLlm({ workspaceId: 'ws_no_settings' });
check(
  'legacy REELFORGE_LLM_API_KEY maps to OpenAI defaults (0.1 behaviour preserved)',
  legacyResolved.source === 'env' &&
    legacyResolved.providerId === 'openai' &&
    legacyResolved.baseUrl === 'https://api.openai.com/v1' &&
    legacyResolved.model === 'gpt-4.1-mini',
  `${legacyResolved.providerId}/${legacyResolved.model}`
);
clearProviderEnv();

process.env.OPENROUTER_API_KEY = 'sk-or-env-selftest-0000';
const autoResolved = providers.resolveLlm({ workspaceId: 'ws_no_settings' });
check(
  'auto-detect picks the provider whose key var is present',
  autoResolved.source === 'env' &&
    autoResolved.providerId === 'openrouter' &&
    autoResolved.apiKey === 'sk-or-env-selftest-0000' &&
    autoResolved.detected === true,
  `${autoResolved.providerId}/detected=${autoResolved.detected}`
);
clearProviderEnv();

// Documented auto-detect priority: catalog order, provider-specific keys only.
process.env.OPENAI_API_KEY = 'sk-openai-autodetect';
process.env.ANTHROPIC_API_KEY = 'sk-ant-autodetect';
process.env.GROQ_API_KEY = 'gsk-groq-autodetect';
const detectedWinner = providers.resolveLlm({ workspaceId: 'ws_no_settings' });
check(
  'auto-detect with three keys follows catalog priority (OpenAI wins)',
  detectedWinner.providerId === 'openai' &&
    detectedWinner.source === 'env' &&
    detectedWinner.detected === true &&
    detectedWinner.apiKey === 'sk-openai-autodetect',
  `${detectedWinner.providerId}/detected=${detectedWinner.detected}`
);
process.env.REELFORGE_LLM_PROVIDER = 'groq';
const explicitWinner = providers.resolveLlm({ workspaceId: 'ws_no_settings' });
check(
  'an explicit REELFORGE_LLM_PROVIDER beats auto-detect',
  explicitWinner.providerId === 'groq' && explicitWinner.detected === false,
  `${explicitWinner.providerId}/detected=${explicitWinner.detected}`
);
clearProviderEnv();

process.env.REELFORGE_LLM_API_KEY = 'sk-shared-autodetect-0000';
const sharedWinner = providers.resolveLlm({ workspaceId: 'ws_no_settings' });
check(
  'the shared REELFORGE_LLM_API_KEY maps to OpenAI and marks detected:true',
  sharedWinner.providerId === 'openai' && sharedWinner.source === 'env' && sharedWinner.detected === true,
  `${sharedWinner.providerId}/detected=${sharedWinner.detected}`
);
clearProviderEnv();

// Local auto-detect: best-effort /models probe, cached for the sync resolver.
providers.resetLocalProbeCache();
const localProbeEnv = { REELFORGE_LLM_LOCAL_PROBE: 'on' };
const localFound = await providers.detectLocalProviders({
  env: localProbeEnv,
  targets: [{ providerId: 'ollama', baseUrl: localProbeBase }],
  force: true,
  timeoutMs: 800
});
check(
  'local auto-detect probes /models and reports the reachable preset',
  localFound?.providerId === 'ollama' && localFound?.models.includes('local-model-alpha'),
  `${localFound?.providerId}/${JSON.stringify(localFound?.models)}`
);
const localResolved = providers.resolveLlm({ env: localProbeEnv, workspaceId: 'ws_no_settings' });
check(
  'resolveLlm consumes the cached local probe as source env + detected:true',
  localResolved.providerId === 'ollama' &&
    localResolved.source === 'env' &&
    localResolved.detected === true &&
    localResolved.baseUrl === localProbeBase,
  `${localResolved.providerId}/${localResolved.source}/${localResolved.baseUrl}`
);
const cachedProbe = await providers.detectLocalProviders({
  env: localProbeEnv,
  targets: [{ providerId: 'lmstudio', baseUrl: 'http://127.0.0.1:1/v1' }],
  timeoutMs: 50
});
check('the local probe result is cached (no re-probe)', cachedProbe?.providerId === 'ollama', String(cachedProbe?.providerId));
providers.resetLocalProbeCache();
const offlineAfterReset = providers.resolveLlm({ env: localProbeEnv, workspaceId: 'ws_no_settings' });
check(
  'after a reset with no keys and no local server, resolution is offline',
  offlineAfterReset.source === 'none' && offlineAfterReset.detected === false
);

// ---------------------------------------------------------------------------
// 4. Model discovery (local stub)
// ---------------------------------------------------------------------------

const live = await providers.discoverModels('openai', { apiKey: STUB_KEY, baseUrl: stubBase });
check(
  'discovery parses an OpenAI-style {data:[{id}]} response',
  live.ok && JSON.stringify(live.models) === JSON.stringify(['stub-alpha', 'stub-beta', 'stub-gamma']),
  JSON.stringify(live.models)
);
check('discovery reports latency and no error', typeof live.latencyMs === 'number' && live.error === null);

const ollamaModels = await providers.discoverModels('ollama', { baseUrl: keylessBase });
check(
  'discovery works keyless and parses Ollama-style {models:[{name}]}',
  ollamaModels.ok && ollamaModels.models.includes('llama3:latest') && ollamaModels.models.includes('qwen2.5:7b'),
  JSON.stringify(ollamaModels.models)
);

const parsedIds = providers.parseModelIds({ data: [{ id: 'x' }, { id: 'y' }] });
check('parseModelIds handles a bare OpenAI payload', JSON.stringify(parsedIds) === JSON.stringify(['x', 'y']), JSON.stringify(parsedIds));

const unauthorizedDiscovery = await providers.discoverModels('openai', { apiKey: 'wrong-key', baseUrl: stubBase });
check(
  'discovery returns a typed failure instead of throwing',
  !unauthorizedDiscovery.ok &&
    unauthorizedDiscovery.models.length === 0 &&
    unauthorizedDiscovery.error?.code === 'PROVIDER_UNAUTHORIZED' &&
    unauthorizedDiscovery.error?.status === 401,
  unauthorizedDiscovery.error?.code ?? 'no error'
);

const emptyDiscovery = await providers.discoverModels('openai', { apiKey: STUB_KEY, baseUrl: emptyBase });
check(
  'an empty catalog is a typed bad-response, not a crash',
  !emptyDiscovery.ok && emptyDiscovery.error?.code === 'PROVIDER_BAD_RESPONSE',
  emptyDiscovery.error?.code ?? 'no error'
);

const unreachableDiscovery = await providers.discoverModels('openai', {
  apiKey: STUB_KEY,
  baseUrl: await unreachableBase()
});
check(
  'an unreachable base URL is a typed failure',
  !unreachableDiscovery.ok &&
    (unreachableDiscovery.error?.code === 'PROVIDER_UNREACHABLE' ||
      unreachableDiscovery.error?.code === 'PROVIDER_TIMEOUT'),
  unreachableDiscovery.error?.code ?? 'no error'
);

// ---------------------------------------------------------------------------
// 5. Connection tests (success and every failure mode)
// ---------------------------------------------------------------------------

const goodTest = await providers.testProvider({
  providerId: 'openai',
  apiKey: STUB_KEY,
  baseUrl: stubBase,
  model: 'stub-alpha'
});
check(
  'connection test succeeds and reports latency',
  goodTest.ok && goodTest.model === 'stub-alpha' && typeof goodTest.latencyMs === 'number' && goodTest.error === null,
  `model=${goodTest.model} latency=${goodTest.latencyMs}ms`
);

const wrongKeyTest = await providers.testProvider({
  providerId: 'openai',
  apiKey: 'sk-wrong-key-0000',
  baseUrl: stubBase,
  model: 'stub-alpha'
});
check(
  'a wrong key is a clean 401 failure (PROVIDER_UNAUTHORIZED)',
  !wrongKeyTest.ok && wrongKeyTest.error?.code === 'PROVIDER_UNAUTHORIZED' && wrongKeyTest.error?.status === 401,
  wrongKeyTest.error?.code ?? 'no error'
);

const notFoundTest = await providers.testProvider({
  providerId: 'openai',
  apiKey: STUB_KEY,
  baseUrl: stubBase,
  model: 'missing-model'
});
check(
  'a 404 is a clean PROVIDER_NOT_FOUND failure',
  !notFoundTest.ok && notFoundTest.error?.code === 'PROVIDER_NOT_FOUND' && notFoundTest.error?.status === 404,
  notFoundTest.error?.code ?? 'no error'
);

const unreachableTest = await providers.testProvider({
  providerId: 'openai',
  apiKey: STUB_KEY,
  baseUrl: await unreachableBase(),
  model: 'stub-alpha',
  timeoutMs: 2000
});
check(
  'an unreachable base URL is a clean typed failure',
  !unreachableTest.ok &&
    (unreachableTest.error?.code === 'PROVIDER_UNREACHABLE' || unreachableTest.error?.code === 'PROVIDER_TIMEOUT'),
  unreachableTest.error?.code ?? 'no error'
);

const timeoutTest = await providers.testProvider({
  providerId: 'openai',
  apiKey: STUB_KEY,
  baseUrl: slowBase,
  model: 'stub-alpha',
  timeoutMs: 300
});
check(
  'a slow endpoint times out cleanly (PROVIDER_TIMEOUT)',
  !timeoutTest.ok && timeoutTest.error?.code === 'PROVIDER_TIMEOUT',
  timeoutTest.error?.code ?? 'no error'
);

const noKeyTest = await providers.testProvider({ providerId: 'openai', baseUrl: stubBase, model: 'stub-alpha', workspaceId: 'ws_no_settings' });
check(
  'a missing key is a typed PROVIDER_CONFIG failure',
  !noKeyTest.ok && noKeyTest.error?.code === 'PROVIDER_CONFIG',
  noKeyTest.error?.code ?? 'no error'
);

// --- Anthropic Messages adapter, end to end against the stub ----------------

captured.length = 0;
const anthropicTest = await providers.testProvider({
  providerId: 'anthropic',
  apiKey: ANTHROPIC_STUB_KEY,
  baseUrl: anthropicBase,
  model: 'claude-sonnet-4-5'
});
const anthropicCall = captured.find((entry) => entry.url === '/anthropic/v1/messages');
const anthropicCallMessages = (anthropicCall?.body.messages ?? []) as Array<{ role: string }>;
check(
  'testProvider speaks the Anthropic Messages API (x-api-key + version, translated body)',
  anthropicTest.ok &&
    anthropicTest.model === 'claude-sonnet-4-5' &&
    anthropicCall?.headers['x-api-key'] === ANTHROPIC_STUB_KEY &&
    !anthropicCall?.headers.authorization &&
    anthropicCall?.headers['anthropic-version'] === '2023-06-01' &&
    typeof anthropicCall?.body.max_tokens === 'number' &&
    !anthropicCallMessages.some((message) => message.role === 'system'),
  `${anthropicTest.ok}/${String(anthropicTest.error?.code ?? 'ok')}`
);

captured.length = 0;
const anthropicPlanner = new plannerModule.LlmPlanner({
  instruction: 'Record a demo.',
  providerId: 'anthropic',
  baseUrl: anthropicBase,
  apiKey: ANTHROPIC_STUB_KEY,
  model: 'claude-planner'
});
const plannerAction = await anthropicPlanner.next({
  step: 0,
  url: 'https://example.test/',
  title: 'Example',
  domDigest: '<button role="button">Go</button>',
  elements: [],
  history: [],
  goal: 'Record a demo.'
});
const plannerCall = captured.find((entry) => entry.url === '/anthropic/v1/messages');
check(
  'the planner runs through the Anthropic adapter end to end',
  plannerAction.kind === 'done' && typeof plannerCall?.body.system === 'string',
  `${plannerAction.kind}/${String(plannerCall?.body.system).slice(0, 28)}…`
);

// --- Azure api-key header + api-version query, end to end -------------------

captured.length = 0;
const azureTest = await providers.testProvider({
  providerId: 'azure-openai',
  apiKey: AZURE_STUB_KEY,
  baseUrl: azureBase,
  model: 'gpt-4o'
});
const azureCall = captured.find((entry) => entry.url.startsWith('/azure/'));
check(
  'testProvider sends Azure the api-key header and api-version query',
  azureTest.ok &&
    azureCall?.headers['api-key'] === AZURE_STUB_KEY &&
    String(azureCall?.url).includes('api-version=2025-04-01-preview'),
  `${azureTest.ok}/${String(azureCall?.url)}`
);

// ---------------------------------------------------------------------------
// 6. HTTP routes (real Fastify app + auth, in-process via inject)
// ---------------------------------------------------------------------------

const app = Fastify({ logger: false });
apiAuth.attachAuth(app);
app.setErrorHandler((error: unknown, _request, reply) => {
  if (error instanceof coreHttp.ApiError) {
    reply.code(error.status).send(coreHttp.err(error.code, error.message, error.remediation));
    return;
  }
  const status = Number((error as { statusCode?: unknown })?.statusCode ?? 500);
  const message = error instanceof Error ? error.message : String(error);
  reply.code(status).send(coreHttp.err(status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR', message));
});
await app.register(apiRoutes.default);
await app.ready();

// Auto-detect is exposed on the wire: a fresh key with no explicit provider.
clearProviderEnv();
process.env.OPENAI_API_KEY = 'sk-openai-route-detect';
const detectedResponse = await app.inject({
  method: 'GET',
  url: '/api/providers',
  headers: { 'x-api-key': API_KEY }
});
const detectedBody = JSON.parse(detectedResponse.body) as {
  data?: {
    llm?: {
      active?: { providerId?: string; source?: string; detected?: boolean };
      providers?: Array<{ id: string; detected?: boolean; tier?: string }>;
    };
  };
};
check(
  'GET /api/providers exposes active.detected for an auto-detected env key',
  detectedResponse.statusCode === 200 &&
    detectedBody.data?.llm?.active?.providerId === 'openai' &&
    detectedBody.data?.llm?.active?.source === 'env' &&
    detectedBody.data?.llm?.active?.detected === true &&
    detectedBody.data?.llm?.providers?.find((provider) => provider.id === 'openai')?.detected === true,
  JSON.stringify(detectedBody.data?.llm?.active)
);
check(
  'GET /api/providers exposes the free/paid/local tier for every card',
  detectedBody.data?.llm?.providers?.every(
    (provider) => provider.tier === 'free' || provider.tier === 'paid' || provider.tier === 'local'
  ) === true
);

clearProviderEnv();

const unauthenticated = await app.inject({ method: 'GET', url: '/api/providers' });
check(
  'GET /api/providers requires an API key',
  unauthenticated.statusCode === 401 && JSON.parse(unauthenticated.body).code === 'UNAUTHORIZED',
  `HTTP ${unauthenticated.statusCode}`
);

const statusResponse = await app.inject({
  method: 'GET',
  url: '/api/providers',
  headers: { 'x-api-key': API_KEY }
});
const statusBody = JSON.parse(statusResponse.body) as {
  message?: string;
  data?: {
    llm?: {
      active?: { providerId?: string; source?: string; model?: string | null };
      providers?: Array<{ id: string; keyHint?: string | null }>;
    };
    tts?: { providers?: unknown[] };
  };
};
const openaiCard = statusBody.data?.llm?.providers?.find((provider) => provider.id === 'openai');
check(
  'GET /api/providers returns {message,data} with the llm+tts catalog',
  statusResponse.statusCode === 200 &&
    typeof statusBody.message === 'string' &&
    Array.isArray(statusBody.data?.llm?.providers) &&
    Array.isArray(statusBody.data?.tts?.providers),
  `HTTP ${statusResponse.statusCode}`
);
check(
  'GET never returns the stored key — only the keyHint',
  !statusResponse.body.includes(WORKSPACE_SECRET) && openaiCard?.keyHint === 'sk-…1234',
  String(openaiCard?.keyHint)
);
check(
  'GET active reflects the workspace selection',
  statusBody.data?.llm?.active?.providerId === 'openai' &&
    statusBody.data?.llm?.active?.source === 'workspace' &&
    statusBody.data?.llm?.active?.model === 'gpt-workspace',
  JSON.stringify(statusBody.data?.llm?.active)
);

const postSave = await app.inject({
  method: 'POST',
  url: '/api/providers',
  headers: { 'x-api-key': API_KEY },
  payload: { llm: { providerId: 'openai', apiKey: STUB_KEY, model: 'stub-alpha' } }
});
const postSaveBody = JSON.parse(postSave.body) as {
  data?: { llm?: { providers?: Array<{ id: string; keyHint?: string | null; source?: string }> } };
};
const postOpenaiCard = postSaveBody.data?.llm?.providers?.find((provider) => provider.id === 'openai');
check(
  'POST /api/providers saves the key and returns the GET shape',
  postSave.statusCode === 200 && postOpenaiCard?.source === 'workspace' && postOpenaiCard?.keyHint === 'stu…mnop',
  String(postOpenaiCard?.keyHint)
);
check('POST response never contains the posted key', !postSave.body.includes(STUB_KEY));

const modelsResponse = await app.inject({
  method: 'GET',
  url: `/api/providers/models?provider=openai&baseUrl=${encodeURIComponent(stubBase)}`,
  headers: { 'x-api-key': API_KEY }
});
const modelsBody = JSON.parse(modelsResponse.body) as { data?: { models?: string[]; source?: string } };
check(
  'GET /api/providers/models returns live models from the stored key',
  modelsResponse.statusCode === 200 &&
    modelsBody.data?.source === 'live' &&
    Array.isArray(modelsBody.data?.models) &&
    modelsBody.data.models.includes('stub-alpha'),
  `${modelsResponse.statusCode} ${JSON.stringify(modelsBody.data?.models)}`
);
check('the models response never contains the key', !modelsResponse.body.includes(STUB_KEY));

const testResponse = await app.inject({
  method: 'POST',
  url: '/api/providers/test',
  headers: { 'x-api-key': API_KEY },
  payload: { providerId: 'openai', baseUrl: stubBase, model: 'stub-alpha' }
});
const testBody = JSON.parse(testResponse.body) as {
  data?: { ok?: boolean; latencyMs?: number; model?: string; error?: unknown };
};
check(
  'POST /api/providers/test uses the stored key and reports ok/latencyMs/model/error',
  testResponse.statusCode === 200 &&
    testBody.data?.ok === true &&
    typeof testBody.data?.latencyMs === 'number' &&
    testBody.data?.model === 'stub-alpha' &&
    testBody.data?.error === null,
  JSON.stringify(testBody.data)
);

const testFailure = await app.inject({
  method: 'POST',
  url: '/api/providers/test',
  headers: { 'x-api-key': API_KEY },
  payload: { providerId: 'openai', baseUrl: stubBase, model: 'stub-alpha', apiKey: 'wrong-key' }
});
const testFailureBody = JSON.parse(testFailure.body) as { data?: { ok?: boolean; error?: { code?: string } } };
check(
  'POST /api/providers/test returns ok:false + typed error for a bad key',
  testFailure.statusCode === 200 &&
    testFailureBody.data?.ok === false &&
    testFailureBody.data?.error?.code === 'PROVIDER_UNAUTHORIZED',
  String(testFailureBody.data?.error?.code)
);

const badProvider = await app.inject({
  method: 'POST',
  url: '/api/providers',
  headers: { 'x-api-key': API_KEY },
  payload: { llm: { providerId: 'not-a-real-provider' } }
});
check(
  'POST /api/providers rejects an unknown provider with VALIDATION_ERROR',
  badProvider.statusCode === 400 && JSON.parse(badProvider.body).code === 'VALIDATION_ERROR',
  `HTTP ${badProvider.statusCode}`
);

const ttsSave = await app.inject({
  method: 'POST',
  url: '/api/providers',
  headers: { 'x-api-key': API_KEY },
  payload: { tts: { providerId: 'edge', voice: 'en-US-AriaNeural' } }
});
const ttsBody = JSON.parse(ttsSave.body) as {
  data?: { tts?: { active?: { providerId?: string; voice?: string | null; source?: string } } };
};
check(
  'POST /api/providers saves the narration provider/voice',
  ttsSave.statusCode === 200 &&
    ttsBody.data?.tts?.active?.providerId === 'edge' &&
    ttsBody.data?.tts?.active?.voice === 'en-US-AriaNeural' &&
    ttsBody.data?.tts?.active?.source === 'workspace',
  JSON.stringify(ttsBody.data?.tts?.active)
);

const clearedNone = await app.inject({
  method: 'POST',
  url: '/api/providers',
  headers: { 'x-api-key': API_KEY },
  payload: { llm: { providerId: 'none' } }
});
const clearedNoneBody = JSON.parse(clearedNone.body) as { data?: { llm?: { active?: { providerId?: string; source?: string } } } };
check(
  'POST /api/providers with providerId "none" clears the workspace override',
  clearedNone.statusCode === 200 &&
    clearedNoneBody.data?.llm?.active?.providerId === 'none' &&
    clearedNoneBody.data?.llm?.active?.source === 'none',
  JSON.stringify(clearedNoneBody.data?.llm?.active)
);

const deleted = await app.inject({ method: 'DELETE', url: '/api/providers', headers: { 'x-api-key': API_KEY } });
const deletedBody = JSON.parse(deleted.body) as {
  data?: { llm?: { active?: { providerId?: string; source?: string } }; tts?: { active?: { source?: string } } };
};
check(
  'DELETE /api/providers clears both llm and tts workspace settings',
  deleted.statusCode === 200 &&
    deletedBody.data?.llm?.active?.source === 'none' &&
    deletedBody.data?.tts?.active?.source === 'none',
  JSON.stringify({ llm: deletedBody.data?.llm?.active, tts: deletedBody.data?.tts?.active })
);

// ---------------------------------------------------------------------------
// 7. The agent planner actually consumes resolveLlm()
// ---------------------------------------------------------------------------

clearProviderEnv();
const scriptedPlanner = plannerModule.createPlanner({ instruction: 'Record a demo.' });
check(
  'no configuration keeps the scripted planner untouched',
  scriptedPlanner.name === 'scripted',
  scriptedPlanner.name
);

process.env.REELFORGE_LLM_PROVIDER = 'ollama';
const ollamaPlanner = plannerModule.createPlanner({ instruction: 'Record a demo.' });
check(
  'a keyless local provider selects the LLM planner through resolveLlm()',
  ollamaPlanner.name === 'llm',
  ollamaPlanner.name
);

clearProviderEnv();
apiServices.saveProviders(auth, { llm: { providerId: 'openai', apiKey: 'sk-planner-workspace-key-0001' } });
const workspacePlanner = plannerModule.createPlanner({ instruction: 'Record a demo.' });
check(
  'a dashboard-saved workspace key selects the LLM planner',
  workspacePlanner.name === 'llm',
  workspacePlanner.name
);

// ---------------------------------------------------------------------------
// Clean up: no servers left behind, temp data removed
// ---------------------------------------------------------------------------

await app.close();
stub.closeAllConnections?.();
await new Promise<void>((resolve) => stub.close(() => resolve()));
coreDb.closeDb();
fs.rmSync(TMP_DATA, { recursive: true, force: true });

console.log('');
if (failures > 0) {
  console.error(`PROVIDERS SELFTEST FAIL: ${failures} of ${checks.length} checks failed`);
  process.exit(1);
}
console.log(`PROVIDERS SELFTEST PASS: ${checks.length} checks passed`);
console.log('  precedence: env > workspace > none · AES-256-GCM round trip · masked API output · typed failures · model discovery');
process.exit(0);
