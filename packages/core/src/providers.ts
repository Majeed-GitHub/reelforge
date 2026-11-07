/**
 * Bring-your-own-key provider catalog.
 *
 * Every LLM Reelforge uses goes through an OpenAI-compatible
 * `POST {baseUrl}/chat/completions`, which is what almost every inference
 * provider now exposes. That means the same planner works against GMI Cloud,
 * OpenAI, OpenRouter, Groq, Together, Fireworks, DeepSeek, a local Ollama, LM
 * Studio, or any custom gateway — you pick with one env var (or in the
 * dashboard), and paste your own key.
 *
 * Nothing here makes a network call; see packages/providers for resolution,
 * live model discovery and health probes.
 */

export const LLM_PROVIDER_IDS = [
  'gmi',
  'openai',
  'openrouter',
  'groq',
  'together',
  'fireworks',
  'deepseek',
  'ollama',
  'lmstudio',
  'custom'
] as const;

export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

export type LlmProvider = {
  id: LlmProviderId;
  label: string;
  /** OpenAI-compatible base URL, without the trailing /chat/completions. */
  baseUrl: string;
  /** Local providers need no key. */
  requiresKey: boolean;
  /** Env vars checked, in order, for the key. */
  keyEnv: string[];
  /**
   * Preferred model id. Empty string means "ask the provider's /models
   * endpoint and take the first entry" — used where the catalog moves fast.
   */
  defaultModel: string;
  /** Shown in the dashboard when the provider is selected. */
  helpUrl?: string;
  note?: string;
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
    note: 'OpenAI-compatible inference. Model ids look like vendor/model-name — fetch the list from your console.'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    keyEnv: ['OPENAI_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'gpt-4.1-mini',
    helpUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    keyEnv: ['OPENROUTER_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'anthropic/claude-sonnet-4',
    helpUrl: 'https://openrouter.ai/keys',
    note: 'One key, most frontier models. Model ids are vendor/model.'
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
    keyEnv: ['GROQ_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'llama-3.3-70b-versatile',
    helpUrl: 'https://console.groq.com/keys'
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    requiresKey: true,
    keyEnv: ['TOGETHER_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    helpUrl: 'https://api.together.ai/settings/api-keys'
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    requiresKey: true,
    keyEnv: ['FIREWORKS_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    helpUrl: 'https://fireworks.ai/account/api-keys'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresKey: true,
    keyEnv: ['DEEPSEEK_API_KEY', 'REELFORGE_LLM_API_KEY'],
    defaultModel: 'deepseek-chat',
    helpUrl: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    requiresKey: false,
    keyEnv: [],
    defaultModel: '',
    helpUrl: 'https://ollama.com/download',
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
    note: 'Start the local server in LM Studio, then pick it here.'
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    requiresKey: false,
    keyEnv: ['REELFORGE_LLM_API_KEY'],
    defaultModel: '',
    note: 'Any gateway that speaks /chat/completions. Set the base URL and model yourself.'
  }
];

/** Speech synthesis providers, in the order 'auto' tries them. */
export const TTS_PROVIDER_IDS = ['openai', 'elevenlabs', 'edge', 'sapi', 'none'] as const;
export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number];

export type TtsProvider = {
  id: TtsProviderId;
  label: string;
  requiresKey: boolean;
  keyEnv: string[];
  /** True when it needs nothing but the OS (or a python package). */
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
