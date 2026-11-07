/**
 * Bring-your-own-key provider catalog.
 *
 * Every LLM Reelforge uses is reached over HTTP and spoken to through one of two
 * protocols:
 *
 *  - `openai-chat` (default): `POST {baseUrl}/chat/completions`, which almost
 *    every inference provider now exposes;
 *  - `anthropic-messages`: Anthropic's native Messages API, translated to the
 *    same shape by packages/providers (see `buildChatRequest`).
 *
 * Transport quirks are data on each catalog entry (`authStyle`, `pathSuffix`,
 * `extraQuery`, `extraHeaders`) so Azure's `api-key` header + `api-version`
 * query and Anthropic's `x-api-key` + `anthropic-version` header need no
 * special cases elsewhere.
 *
 * `tier` is a coarse grouping for the dashboard and docs: `free` means the
 * provider offers a usable free tier / free models, `paid` means you need a
 * funded account, `local` means it runs on your own machine (or is a gateway you
 * host and point us at). Free tiers change; treat `tier` as a hint, not a SLA.
 *
 * Nothing here makes a network call; see packages/providers for resolution,
 * live model discovery, health probes and protocol translation.
 */

/** Catalog order is also the auto-detect priority (first key present wins). */
export const LLM_PROVIDER_IDS = [
  'gmi',
  'openai',
  'anthropic',
  'google-gemini',
  'openrouter',
  'groq',
  'deepseek',
  'mistral',
  'xai',
  'together',
  'fireworks',
  'cerebras',
  'nvidia-nim',
  'github-models',
  'huggingface',
  'sambanova',
  'deepinfra',
  'nebius',
  'novita',
  'hyperbolic',
  'moonshot',
  'zhipu',
  'dashscope',
  'perplexity',
  'azure-openai',
  'ollama',
  'lmstudio',
  'llamacpp',
  'vllm',
  'localai',
  'custom'
] as const;

export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

export const LLM_TIERS = ['free', 'paid', 'local'] as const;
export type LlmTier = (typeof LLM_TIERS)[number];

/** How the API key travels on the wire. Defaults to `bearer`. */
export const PROVIDER_AUTH_STYLES = ['bearer', 'api-key-header', 'x-api-key'] as const;
export type ProviderAuthStyle = (typeof PROVIDER_AUTH_STYLES)[number];

/** Wire protocol. Everything except Anthropic uses the OpenAI chat shape. */
export const PROVIDER_PROTOCOLS = ['openai-chat', 'anthropic-messages'] as const;
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

export type LlmProvider = {
  id: LlmProviderId;
  label: string;
  /** API root, without the trailing chat path. Empty only for user-supplied URLs. */
  baseUrl: string;
  /** Local providers need no key. */
  requiresKey: boolean;
  /** Env vars checked, in order, for the key (last entry is the shared fallback). */
  keyEnv: string[];
  /**
   * Preferred model id. Empty string means "ask the provider's /models
   * endpoint and take the first entry" - used where the catalog moves fast,
   * and for local servers where only the user knows what is loaded.
   */
  defaultModel: string;
  /** Shown in the dashboard when the provider is selected. */
  helpUrl?: string;
  note?: string;
  /** Coarse free / paid / local grouping. */
  tier: LlmTier;
  /** Defaults to `openai-chat`. */
  protocol?: ProviderProtocol;
  /** Defaults to `bearer`. */
  authStyle?: ProviderAuthStyle;
  /** Appended to `baseUrl` for chat; defaults to the protocol's path. */
  pathSuffix?: string;
  /**
   * Query parameters added to every request. Values may reference env vars with
   * `${NAME}` or `${NAME:-default}` (used by Azure's `api-version`).
   */
  extraQuery?: Record<string, string>;
  /** Extra static request headers (values support the same env syntax). */
  extraHeaders?: Record<string, string>;
  /** True when the user must supply the URL (Azure resource, custom gateway). */
  userSuppliedBaseUrl?: boolean;
};

export const LLM_PROVIDERS: LlmProvider[] = [
  {
    id: 'gmi',
    label: 'GMI Cloud',
    baseUrl: 'https://api.gmi-serving.com/v1',
    requiresKey: true,
    keyEnv: ['GMI_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: '',
    helpUrl: 'https://www.gmicloud.ai/',
    tier: 'paid',
    note: "Maintainer's default. OpenAI-compatible; model ids look like vendor/model-name - discover them from the console."
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    keyEnv: ['OPENAI_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'gpt-4.1-mini',
    helpUrl: 'https://platform.openai.com/api-keys',
    tier: 'paid'
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    requiresKey: true,
    keyEnv: ['ANTHROPIC_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'claude-sonnet-4-5',
    helpUrl: 'https://console.anthropic.com/settings/keys',
    tier: 'paid',
    protocol: 'anthropic-messages',
    authStyle: 'x-api-key',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
    note: 'Native Messages API (not OpenAI-compatible) - Reelforge translates requests and vision blocks for you.'
  },
  {
    id: 'google-gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresKey: true,
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'gemini-2.5-flash',
    helpUrl: 'https://aistudio.google.com/apikey',
    tier: 'free',
    note: 'Uses Gemini\'s OpenAI-compatible endpoint; the base URL must keep the trailing /openai path.'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    keyEnv: ['OPENROUTER_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'anthropic/claude-sonnet-4',
    helpUrl: 'https://openrouter.ai/keys',
    tier: 'free',
    note: 'One key, most frontier models; several :free models need no credits. Model ids are vendor/model.'
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
    keyEnv: ['GROQ_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'llama-3.3-70b-versatile',
    helpUrl: 'https://console.groq.com/keys',
    tier: 'free',
    note: 'Generous free tier and very low latency; good default for long demo runs.'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresKey: true,
    keyEnv: ['DEEPSEEK_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'deepseek-chat',
    helpUrl: 'https://platform.deepseek.com/api_keys',
    tier: 'paid',
    note: 'Very cheap reasoning/chat models.'
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    requiresKey: true,
    keyEnv: ['MISTRAL_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'mistral-large-latest',
    helpUrl: 'https://console.mistral.ai/api-keys',
    tier: 'free',
    note: 'Free "Experiment" tier for evaluation; production keys are pay-as-you-go.'
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    requiresKey: true,
    keyEnv: ['XAI_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'grok-4',
    helpUrl: 'https://console.x.ai/',
    tier: 'paid'
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    requiresKey: true,
    keyEnv: ['TOGETHER_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    helpUrl: 'https://api.together.ai/settings/api-keys',
    tier: 'paid',
    note: 'Starter credits on signup; open-weight models at low cost.'
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    requiresKey: true,
    keyEnv: ['FIREWORKS_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    helpUrl: 'https://fireworks.ai/account/api-keys',
    tier: 'paid'
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    requiresKey: true,
    keyEnv: ['CEREBRAS_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'llama-3.3-70b',
    helpUrl: 'https://cloud.cerebras.ai/',
    tier: 'free',
    note: 'Free developer tier; extremely fast inference.'
  },
  {
    id: 'nvidia-nim',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    requiresKey: true,
    keyEnv: ['NVIDIA_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'meta/llama-3.3-70b-instruct',
    helpUrl: 'https://build.nvidia.com/',
    tier: 'free',
    note: 'Free API credits for NVIDIA-hosted open models.'
  },
  {
    id: 'github-models',
    label: 'GitHub Models',
    baseUrl: 'https://models.inference.ai.azure.com',
    requiresKey: true,
    keyEnv: ['GITHUB_TOKEN', 'GH_TOKEN', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'gpt-4o-mini',
    helpUrl: 'https://github.com/settings/tokens',
    tier: 'free',
    note: 'Free with a GitHub PAT that has models:read (or a classic token with the models scope). Base URL has no /v1.'
  },
  {
    id: 'huggingface',
    label: 'Hugging Face Router',
    baseUrl: 'https://router.huggingface.co/v1',
    requiresKey: true,
    keyEnv: ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    helpUrl: 'https://huggingface.co/settings/tokens',
    tier: 'free',
    note: 'Free monthly inference credits. Some router models need a ":provider" suffix.'
  },
  {
    id: 'sambanova',
    label: 'SambaNova',
    baseUrl: 'https://api.sambanova.ai/v1',
    requiresKey: true,
    keyEnv: ['SAMBANOVA_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
    helpUrl: 'https://cloud.sambanova.ai/apis',
    tier: 'free',
    note: 'Free developer tier with fast Llama hosting.'
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    requiresKey: true,
    keyEnv: ['DEEPINFRA_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
    helpUrl: 'https://deepinfra.com/dash/api_keys',
    tier: 'paid',
    note: 'Pay-per-token open-weight hosting; base URL includes /v1/openai.'
  },
  {
    id: 'nebius',
    label: 'Nebius AI Studio',
    baseUrl: 'https://api.studio.nebius.ai/v1',
    requiresKey: true,
    keyEnv: ['NEBIUS_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
    helpUrl: 'https://studio.nebius.ai/',
    tier: 'paid'
  },
  {
    id: 'novita',
    label: 'Novita AI',
    baseUrl: 'https://api.novita.ai/v3/openai',
    requiresKey: true,
    keyEnv: ['NOVITA_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    helpUrl: 'https://novita.ai/settings/key-management',
    tier: 'paid',
    note: 'Base URL includes the /v3/openai compatibility path.'
  },
  {
    id: 'hyperbolic',
    label: 'Hyperbolic',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    requiresKey: true,
    keyEnv: ['HYPERBOLIC_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    helpUrl: 'https://app.hyperbolic.xyz/settings',
    tier: 'paid'
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    requiresKey: true,
    keyEnv: ['MOONSHOT_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'moonshot-v1-8k',
    helpUrl: 'https://platform.moonshot.cn/console/api-keys',
    tier: 'paid'
  },
  {
    id: 'zhipu',
    label: 'Zhipu GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    requiresKey: true,
    keyEnv: ['ZHIPUAI_API_KEY', 'ZHIPU_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'glm-4-plus',
    helpUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    tier: 'paid',
    note: 'OpenAI-compatible v4 path (contains /paas/v4).'
  },
  {
    id: 'dashscope',
    label: 'Alibaba DashScope (Qwen)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    requiresKey: true,
    keyEnv: ['DASHSCOPE_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'qwen-plus',
    helpUrl: 'https://bailian.console.aliyun.com/',
    tier: 'free',
    note: 'Free quota on Alibaba Model Studio; international keys may need a different region host.'
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai',
    requiresKey: true,
    keyEnv: ['PERPLEXITY_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'sonar',
    helpUrl: 'https://www.perplexity.ai/settings/api',
    tier: 'paid',
    note: 'Search-grounded chat. Base URL has no /v1 and /models is not always available.'
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    baseUrl: '',
    requiresKey: true,
    keyEnv: ['AZURE_OPENAI_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: '',
    helpUrl: 'https://learn.microsoft.com/azure/ai-services/openai/',
    tier: 'paid',
    authStyle: 'api-key-header',
    extraQuery: { 'api-version': '${AZURE_OPENAI_API_VERSION:-2025-04-01-preview}' },
    userSuppliedBaseUrl: true,
    note: 'Set baseUrl to https://<resource>.openai.azure.com/openai/deployments/<deployment> and model to the deployment name; sends the api-key header + api-version query.'
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    requiresKey: false,
    keyEnv: [],
    defaultModel: '',
    helpUrl: 'https://ollama.com/download',
    tier: 'local',
    note: 'Runs on your machine. No key, no data leaves the box. Pull a vision-capable model for best results.'
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://127.0.0.1:1234/v1',
    requiresKey: false,
    keyEnv: [],
    defaultModel: '',
    helpUrl: 'https://lmstudio.ai/',
    tier: 'local',
    note: 'Start the local server in LM Studio, then pick it here.'
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp server (local)',
    baseUrl: 'http://127.0.0.1:8080/v1',
    requiresKey: false,
    keyEnv: [],
    defaultModel: '',
    helpUrl: 'https://github.com/ggml-org/llama.cpp',
    tier: 'local',
    note: 'Run llama-server --host 127.0.0.1 --port 8080; the /v1 path is OpenAI-compatible.'
  },
  {
    id: 'vllm',
    label: 'vLLM (local)',
    baseUrl: 'http://127.0.0.1:8000/v1',
    requiresKey: false,
    keyEnv: [],
    defaultModel: '',
    helpUrl: 'https://docs.vllm.ai/',
    tier: 'local',
    note: 'Run `vllm serve <model>`; exposes an OpenAI-compatible /v1 server.'
  },
  {
    id: 'localai',
    label: 'LocalAI (local)',
    baseUrl: 'http://127.0.0.1:8080/v1',
    requiresKey: false,
    keyEnv: [],
    defaultModel: '',
    helpUrl: 'https://localai.io/',
    tier: 'local',
    note: 'LocalAI serves an OpenAI-compatible API; point it at the models you have installed.'
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    requiresKey: false,
    keyEnv: ['REELFORGE_LLM_API_KEY'],
    defaultModel: '',
    helpUrl: '',
    tier: 'local',
    userSuppliedBaseUrl: true,
    note: 'Any gateway that speaks /chat/completions (LiteLLM, an internal proxy, a hosted clone). Set baseUrl and model yourself.'
  }
];

/** Speech synthesis providers, in the order 'auto' tries them. */
export const TTS_PROVIDER_IDS = ['openai', 'elevenlabs', 'edge', 'sapi', 'none'] as const;
export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number];

export type TtsProvider = {
  id: TtsProviderId;
  label: string;
  requiresKey: boolean;
  /** Env vars checked for a key. Empty/absent for offline providers. */
  keyEnv?: string[];
  offline?: boolean;
  note?: string;
};

export const TTS_PROVIDERS: TtsProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI TTS',
    requiresKey: true,
    keyEnv: ['OPENAI_API_KEY'],
    note: 'gpt-4o-mini-tts. Natural voices in many languages.'
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    requiresKey: true,
    keyEnv: ['ELEVENLABS_API_KEY'],
    note: 'Best-sounding narration if you already have a key.'
  },
  {
    id: 'edge',
    label: 'edge-tts (free)',
    requiresKey: false,
    offline: true,
    note: 'Neural voices via Microsoft Edge. Needs `pip install edge-tts`.'
  },
  {
    id: 'sapi',
    label: 'Windows SAPI',
    requiresKey: false,
    offline: true,
    note: 'Built into Windows. Zero setup, robotic but intelligible.'
  },
  { id: 'none', label: 'Silent (captions only)', requiresKey: false, keyEnv: [] }
];

export function findLlmProvider(id: string): LlmProvider | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id);
}

export function findTtsProvider(id: string): TtsProvider | undefined {
  return TTS_PROVIDERS.find((p) => p.id === id);
}
