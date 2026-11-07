/**
 * Typed API client for the Reelforge HTTP surface (docs/ARCHITECTURE.md §2).
 *
 * Contract notes:
 *  - Success: `{ message, data }`; errors: `{ code, message, remediation }`.
 *  - Auth: `X-API-Key: rg_…` (the key lives in localStorage and never in a cookie).
 *  - URLs are relative: the Vite dev server proxies /api to :4400 and in
 *    production the API serves this bundle itself, so same-origin always works.
 *
 * The row types come from packages/core (@core) — the same file the API and the
 * worker build against — so a contract drift shows up as a type error here
 * instead of a blank table at runtime.
 */
// Row shapes come from packages/core — the exact file the API and worker build
// against — so a contract drift becomes a type error here instead of a blank
// table at runtime. Type-only import: none of core's Node-side code is bundled.
import type {
  ApiKeyRow,
  ArticleChannel,
  ArticleRow,
  DemoFailure,
  DemoOptions,
  DemoOutcome,
  DemoQuestion,
  DemoRequest,
  DemoRow,
  DemoStatus,
  EnvironmentRow,
  FlowRow,
  FlowStatus,
  FlowStepRow,
  GuideRow,
  NarrationLine,
  PresetRow,
  SignInMode,
  StepRow
} from '../../core/src/types.ts';

// ---------------------------------------------------------------------------
// Types layered on top of the shared contract
// ---------------------------------------------------------------------------

export type DemoStep = StepRow & { screenshotUrl?: string | null };

/** GET /api/demos/:id — the row plus the runtime view the dashboard renders. */
export type DemoDetail = DemoRow & {
  outcome?: DemoOutcome | string | null;
  failure?: DemoFailure | string | null;
  question?: DemoQuestion | string | null;
  videoUrl?: string | null;
  posterUrl?: string | null;
  steps?: DemoStep[];
  pollAfterSeconds?: number;
};

export type CreateDemoBody = Omit<DemoRequest, 'options'> & {
  /** `zoom` is a render option (ARCHITECTURE §5.2); the API accepts it in options. */
  options?: DemoOptions & { zoom?: number };
};

export type CreateDemoResult = {
  id: string;
  status?: DemoStatus;
  pollAfterSeconds?: number;
};

export type FlowDetail = {
  flow: FlowRow;
  steps: FlowStepRow[];
};

export type ReverifyResult = {
  status?: FlowStatus;
  staleSteps?: Array<{ idx: number; selector?: string | null; reason?: string }>;
  checkedAt?: string;
};

export type LoginCode = { code: string; expiresAt?: string; environmentId?: string };

/** POST /environments/:id/verify — no browser launch, just the stored sign-in. */
export type VerifyResult = { ok?: boolean; signInMode?: SignInMode; checkedAt?: string; reason?: string };

export type CreatedApiKey = ApiKeyRow & {
  /** Plaintext is returned exactly once, by design. */
  key?: string;
  plaintext?: string;
  apiKey?: string;
};

export type Health = {
  version?: string;
  features?: string[];
  status?: string;
  workspace?: string;
};

export type WorkspaceInfo = { id?: string; name: string };

export type AttachSessionBody = { storageState: unknown };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type Remediation = { action: string; hint?: string };

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly remediation?: Remediation;

  constructor(code: string, message: string, status: number, remediation?: Remediation) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.remediation = remediation;
  }
}

/** The API process is not answering at all (as opposed to answering with an error). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export function isNetworkError(error: unknown): error is NetworkError {
  return error instanceof NetworkError;
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

// ---------------------------------------------------------------------------
// Key storage
// ---------------------------------------------------------------------------

const KEY_STORAGE = 'reelforge.apiKey';
const ONBOARDED_STORAGE = 'reelforge.onboarded';

export function getApiKey(): string {
  try {
    return window.localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function setApiKey(key: string): void {
  try {
    const trimmed = key.trim();
    if (trimmed) window.localStorage.setItem(KEY_STORAGE, trimmed);
    else window.localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* private mode: the key simply does not persist */
  }
}

export function clearApiKey(): void {
  try {
    window.localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* ignore */
  }
}

/** "rg_9f3c…" — enough to recognise a key, not enough to leak it on screen. */
export function maskKey(key: string): string {
  if (!key) return '—';
  if (key.length <= 10) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 7)}…${key.slice(-2)}`;
}

export function hasSeenOnboarding(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDED_STORAGE) === '1';
  } catch {
    return false;
  }
}

export function markOnboarded(): void {
  try {
    window.localStorage.setItem(ONBOARDED_STORAGE, '1');
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
const API_PREFIX = `${API_BASE}/api`;

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Skip the X-API-Key header (only /health needs this today). */
  anonymous?: boolean;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const key = options.anonymous ? '' : getApiKey();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['X-API-Key'] = key;

  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
    });
  } catch (cause) {
    // fetch() only rejects for transport-level failures (down, DNS, aborted).
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new NetworkError(
      `Cannot reach the Reelforge API at ${API_PREFIX}. Start it with \`npm run api\` (port 4400) and try again.`
    );
  }

  const raw = await response.text();
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const envelope = (parsed ?? {}) as { code?: string; message?: string; remediation?: Remediation };
    const fallback = raw && raw.length < 300 && !parsed ? raw.trim() : '';
    throw new ApiError(
      envelope.code || `HTTP_${response.status}`,
      envelope.message || fallback || `${response.status} ${response.statusText}`.trim(),
      response.status,
      envelope.remediation
    );
  }

  if (parsed === null || parsed === undefined) return undefined as T;

  if (typeof parsed === 'object' && parsed !== null && 'data' in parsed) {
    return (parsed as { data: T }).data;
  }
  // Be forgiving if a future build returns a bare payload.
  return parsed as T;
}

/** The API occasionally nests lists; accept the shapes we have seen. */
function asList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of [
      'items',
      'rows',
      'results',
      'data',
      'demos',
      'flows',
      'steps',
      'articles',
      'guides',
      'environments',
      'keys',
      'apiKeys',
      'lines',
      'voices',
      'transcript'
    ]) {
      const candidate = record[key];
      if (Array.isArray(candidate)) return candidate as T[];
    }
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export const api = {
  /** Public: used for the "API online/offline" indicator. */
  async health(): Promise<Health> {
    return request<Health>('/health', { anonymous: true });
  },

  async workspace(): Promise<WorkspaceInfo> {
    const data = asRecord(await request<unknown>('/workspace'));
    return { id: typeof data.id === 'string' ? data.id : undefined, name: typeof data.name === 'string' ? data.name : 'Default workspace' };
  },

  demos: {
    async list(): Promise<DemoRow[]> {
      return asList<DemoRow>(await request<unknown>('/demos'));
    },

    async get(id: string): Promise<DemoDetail> {
      return (await request<DemoDetail>(`/demos/${encodeURIComponent(id)}`)) ?? ({} as DemoDetail);
    },

    async create(body: CreateDemoBody): Promise<CreateDemoResult> {
      const data = asRecord(await request<unknown>('/demos', { method: 'POST', body }));
      return { id: String(data.id ?? ''), status: data.status as DemoStatus | undefined, pollAfterSeconds: data.pollAfterSeconds as number | undefined };
    },

    async transcript(id: string): Promise<NarrationLine[]> {
      return asList<NarrationLine>(await request<unknown>(`/demos/${encodeURIComponent(id)}/transcript`));
    },

    async answer(id: string, optionId: string): Promise<void> {
      await request<unknown>(`/demos/${encodeURIComponent(id)}/question/answer`, {
        method: 'POST',
        body: { optionId }
      });
    },

    async cancel(id: string): Promise<void> {
      await request<unknown>(`/demos/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    }
  },

  environments: {
    async list(): Promise<EnvironmentRow[]> {
      return asList<EnvironmentRow>(await request<unknown>('/environments'));
    },

    async get(id: string): Promise<EnvironmentRow> {
      return (await request<EnvironmentRow>(`/environments/${encodeURIComponent(id)}`)) ?? ({} as EnvironmentRow);
    },

    async create(body: {
      name: string;
      baseUrl: string;
      signInMode: SignInMode;
      credentials?: { username: string; password: string };
    }): Promise<EnvironmentRow> {
      return (await request<EnvironmentRow>('/environments', { method: 'POST', body })) ?? ({} as EnvironmentRow);
    },

    async verify(id: string): Promise<VerifyResult> {
      return asRecord(await request<unknown>(`/environments/${encodeURIComponent(id)}/verify`, { method: 'POST' })) as VerifyResult;
    },

    async attachSession(id: string, storageState: unknown): Promise<void> {
      await request<unknown>(`/environments/${encodeURIComponent(id)}/session`, {
        method: 'POST',
        body: { storageState }
      });
    },

    async loginCode(id: string): Promise<LoginCode> {
      const data = asRecord(await request<unknown>(`/environments/${encodeURIComponent(id)}/login-code`, { method: 'POST' }));
      return {
        code: String(data.code ?? ''),
        expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : typeof data.expires_at === 'string' ? data.expires_at : undefined,
        environmentId: id
      };
    }
  },

  graph: {
    async flows(environmentId: string): Promise<FlowRow[]> {
      return asList<FlowRow>(await request<unknown>(`/environments/${encodeURIComponent(environmentId)}/graph/flows`));
    },

    async flow(environmentId: string, flowId: string): Promise<FlowDetail> {
      const data = await request<unknown>(
        `/environments/${encodeURIComponent(environmentId)}/graph/flows/${encodeURIComponent(flowId)}`
      );
      const record = asRecord(data);
      const flow = (record.flow ?? data) as FlowRow;
      const steps = asList<FlowStepRow>(record.steps ?? record.flowSteps ?? data);
      return { flow, steps };
    },

    async reverify(environmentId: string, flowId: string): Promise<ReverifyResult> {
      return asRecord(
        await request<unknown>(
          `/environments/${encodeURIComponent(environmentId)}/graph/flows/${encodeURIComponent(flowId)}/reverify`,
          { method: 'POST' }
        )
      ) as ReverifyResult;
    }
  },

  articles: {
    async list(): Promise<ArticleRow[]> {
      return asList<ArticleRow>(await request<unknown>('/articles'));
    },

    async get(id: string): Promise<ArticleRow> {
      return (await request<ArticleRow>(`/articles/${encodeURIComponent(id)}`)) ?? ({} as ArticleRow);
    },

    async update(id: string, patch: { title?: string; excerpt?: string; body_md?: string; channel?: ArticleChannel }): Promise<ArticleRow> {
      return (await request<ArticleRow>(`/articles/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })) ?? ({} as ArticleRow);
    },

    async publish(id: string): Promise<ArticleRow | void> {
      return request<ArticleRow>(`/articles/${encodeURIComponent(id)}/publish`, { method: 'POST' });
    },

    /** Unpublish is not in the public table; fall back to a status patch if absent. */
    async unpublish(id: string): Promise<ArticleRow | void> {
      try {
        return await request<ArticleRow>(`/articles/${encodeURIComponent(id)}/unpublish`, { method: 'POST' });
      } catch (error) {
        if (isApiError(error) && (error.status === 404 || error.status === 405)) {
          return request<ArticleRow>(`/articles/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: 'draft' } });
        }
        throw error;
      }
    },

    async fromFlow(body: { flowId: string; channel: ArticleChannel; environmentId?: string }): Promise<ArticleRow> {
      return (await request<ArticleRow>('/articles/from-flow', { method: 'POST', body })) ?? ({} as ArticleRow);
    }
  },

  guides: {
    async list(): Promise<GuideRow[]> {
      return asList<GuideRow>(await request<unknown>('/guides'));
    },

    async get(id: string): Promise<GuideRow> {
      return (await request<GuideRow>(`/guides/${encodeURIComponent(id)}`)) ?? ({} as GuideRow);
    },

    /** Publish/unpublish: POST /publish when available, else PATCH status. */
    async setLive(id: string, live: boolean): Promise<void> {
      if (live) {
        try {
          await request<unknown>(`/guides/${encodeURIComponent(id)}/publish`, { method: 'POST' });
          return;
        } catch (error) {
          if (!(isApiError(error) && (error.status === 404 || error.status === 405))) throw error;
        }
      }
      await request<unknown>(`/guides/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { status: live ? 'live' : 'draft' }
      });
    }
  },

  presets: {
    async list(): Promise<PresetRow[]> {
      return asList<PresetRow>(await request<unknown>('/presets'));
    },

    async voices(): Promise<string[]> {
      const data = await request<unknown>('/presets/voices');
      if (Array.isArray(data)) {
        return data.map((voice) => (typeof voice === 'string' ? voice : String(asRecord(voice).id ?? asRecord(voice).name ?? ''))).filter(Boolean);
      }
      return asList<unknown>(data)
        .map((voice) => (typeof voice === 'string' ? voice : String(asRecord(voice).id ?? asRecord(voice).name ?? '')))
        .filter(Boolean);
    }
  },

  keys: {
    async list(): Promise<ApiKeyRow[]> {
      return asList<ApiKeyRow>(await request<unknown>('/api-keys'));
    },

    async create(name: string): Promise<CreatedApiKey> {
      return (await request<CreatedApiKey>('/api-keys', { method: 'POST', body: { name } })) ?? ({} as CreatedApiKey);
    },

    async revoke(id: string): Promise<void> {
      await request<unknown>(`/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }
  },

  domains: {
    async attest(host: string): Promise<void> {
      await request<unknown>('/domains/attest', { method: 'POST', body: { host } });
    }
  }
};

/** The public origin the API is reachable at, for snippets and share links. */
export function apiOrigin(): string {
  if (API_BASE) return API_BASE.replace(/\/$/, '');
  return window.location.origin;
}

/** Pull the plaintext out of whichever field name the create-key route used. */
export function plaintextKey(key: CreatedApiKey): string {
  return key.key ?? key.plaintext ?? key.apiKey ?? '';
}

// ---------------------------------------------------------------------------
// v0.2 — bring-your-own-key providers, exports, sharing, webhooks
// ---------------------------------------------------------------------------

export type ProviderSource = 'env' | 'workspace' | 'none';

export type LlmProviderState = {
  id: string;
  label: string;
  baseUrl: string;
  /** 'free' | 'paid' | 'local' — grouped in the picker when present. */
  tier?: 'free' | 'paid' | 'local' | string;
  /** True when the provider's key was found in the environment automatically. */
  detected?: boolean;
  requiresKey: boolean;
  defaultModel?: string;
  helpUrl?: string;
  note?: string;
  configured: boolean;
  source: ProviderSource;
  /** Masked only, e.g. "sk-…4f2a". Never the real key. */
  keyHint: string | null;
  model: string | null;
};

export type TtsProviderState = {
  id: string;
  label: string;
  requiresKey: boolean;
  offline?: boolean;
  configured: boolean;
  note?: string;
};

export type ProvidersState = {
  llm: {
    active: { providerId: string; model: string | null; baseUrl: string | null; source: ProviderSource };
    providers: LlmProviderState[];
  };
  tts: {
    active: { providerId: string; voice: string | null; source: ProviderSource };
    providers: TtsProviderState[];
  };
};

export type ProviderTestResult = {
  ok: boolean;
  latencyMs?: number;
  model?: string;
  error?: string | null;
};

export type ExportKind = 'gif' | 'vtt' | 'walkthrough';
export type DemoExport = {
  id: string;
  kind: ExportKind | string;
  status: 'queued' | 'complete' | 'failed' | string;
  url?: string | null;
  bytes?: number | null;
};

export type WebhookState = {
  url: string | null;
  hasSecret: boolean;
  lastDelivery?: { at?: string; ok?: boolean; status?: number } | null;
};

export type WebhookTestResult = { delivered: boolean; status?: number; latencyMs?: number };

export const apiV2 = {
  providers: {
    async get(): Promise<ProvidersState> {
      return (await request<ProvidersState>('/providers')) ?? ({ llm: { active: { providerId: 'none', model: null, baseUrl: null, source: 'none' }, providers: [] }, tts: { active: { providerId: 'none', voice: null, source: 'none' }, providers: [] } } as ProvidersState);
    },

    async save(body: {
      llm?: { providerId: string; apiKey?: string; model?: string; baseUrl?: string };
      tts?: { providerId: string; voice?: string };
    }): Promise<ProvidersState> {
      return (await request<ProvidersState>('/providers', { method: 'POST', body })) ?? (await apiV2.providers.get());
    },

    async clear(): Promise<ProvidersState> {
      return (await request<ProvidersState>('/providers', { method: 'DELETE' })) ?? (await apiV2.providers.get());
    },

    async models(providerId: string, baseUrl?: string): Promise<string[]> {
      const query = new URLSearchParams({ provider: providerId });
      if (baseUrl) query.set('baseUrl', baseUrl);
      const data = asRecord(await request<unknown>(`/providers/models?${query.toString()}`));
      const list = Array.isArray(data.models) ? data.models : asList<unknown>(data);
      return list.map((m) => (typeof m === 'string' ? m : String(asRecord(m).id ?? ''))).filter(Boolean);
    },

    async test(body: { providerId: string; apiKey?: string; baseUrl?: string; model?: string }): Promise<ProviderTestResult> {
      const data = asRecord(await request<unknown>('/providers/test', { method: 'POST', body }));
      return {
        ok: Boolean(data.ok),
        latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : undefined,
        model: typeof data.model === 'string' ? data.model : undefined,
        error: typeof data.error === 'string' ? data.error : null
      };
    }
  },

  exports: {
    async list(demoId: string): Promise<DemoExport[]> {
      const data = asRecord(await request<unknown>(`/demos/${encodeURIComponent(demoId)}/exports`));
      if (Array.isArray(data.exports)) return data.exports as DemoExport[];
      return asList<DemoExport>(data);
    },

    async request(demoId: string, kind: ExportKind): Promise<DemoExport> {
      const data = asRecord(await request<unknown>(`/demos/${encodeURIComponent(demoId)}/exports`, { method: 'POST', body: { kind } }));
      return { id: String(data.id ?? ''), kind, status: String(data.status ?? 'queued') };
    },

    /**
     * Builds the interactive walkthrough (a standalone HTML player for the
     * recorded steps). Progress is reported through list() as kind
     * 'walkthrough'; the ready row carries the url to open.
     */
    async requestWalkthrough(demoId: string): Promise<DemoExport> {
      const data = asRecord(
        await request<unknown>(`/demos/${encodeURIComponent(demoId)}/walkthrough`, { method: 'POST', body: {} })
      );
      return { id: String(data.id ?? ''), kind: 'walkthrough', status: String(data.status ?? 'queued') };
    }
  },

  share: {
    async link(demoId: string): Promise<{ url: string; expiresAt?: string | null }> {
      const data = asRecord(await request<unknown>(`/demos/${encodeURIComponent(demoId)}/share`));
      return { url: String(data.url ?? ''), expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : null };
    }
  },

  webhooks: {
    async get(): Promise<WebhookState> {
      const data = asRecord(await request<unknown>('/webhooks'));
      return {
        url: typeof data.url === 'string' ? data.url : null,
        hasSecret: Boolean(data.hasSecret),
        lastDelivery: (data.lastDelivery as WebhookState['lastDelivery']) ?? null
      };
    },

    async save(body: { url: string; secret?: string | null }): Promise<WebhookState> {
      await request<unknown>('/webhooks', { method: 'POST', body });
      return apiV2.webhooks.get();
    },

    async test(): Promise<WebhookTestResult> {
      const data = asRecord(await request<unknown>('/webhooks/test', { method: 'POST', body: {} }));
      return {
        delivered: Boolean(data.delivered),
        status: typeof data.status === 'number' ? data.status : undefined,
        latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : undefined
      };
    }
  }
};
