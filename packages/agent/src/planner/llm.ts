/**
 * LLM planner: any OpenAI-compatible chat-completions endpoint decides one
 * action per turn from the observed element inventory (plus a screenshot when
 * the endpoint/model can take one).
 *
 * Everything here is defensive on purpose: models wrap JSON in fences, quote
 * keys, hallucinate refs and occasionally return prose. Anything that survives
 * parsing but does not validate throws `PlannerError`, and the planner factory
 * catches it and degrades to the offline scripted planner — a demo run must not
 * die because a model had a bad day.
 */

import type { Observation, PlannedAction, Planner, StepKind } from '../../../core/src/types.ts';
import { STEP_KINDS } from '../../../core/src/types.ts';
import {
  buildChatRequest,
  discoverModels,
  extractChatText,
  findLlmProvider,
  resolveLlm,
  type OpenAiChatMessage,
  type ResolvedLlm
} from '../../../providers/src/index.ts';

export class PlannerError extends Error {
  readonly code: string;

  constructor(message: string, code = 'PLANNER_ERROR') {
    super(message);
    this.name = 'PlannerError';
    this.code = code;
  }
}

export type LlmPlannerConfig = {
  instruction: string;
  /**
   * Endpoint settings. Anything omitted falls back to the BYOK provider layer
   * (`resolveLlm`: env > workspace key > nothing), so a key pasted in the
   * dashboard configures the planner without restarting anything.
   */
  baseUrl?: string;
  apiKey?: string;
  /** Empty means "ask the provider's /models endpoint and take the first id". */
  model?: string;
  /** Catalog id (`gmi`, `openai`, `ollama`, …), used for discovery + key rules. */
  providerId?: string;
  timeoutMs?: number;
  /** Also used to fill a login form when the instruction does not name the values. */
  credentials?: { username: string; password: string };
  /** Send a viewport screenshot with each observation. */
  useVision?: boolean;
};

const SYSTEM_PROMPT = `You are Reelforge's browser agent. You drive a real Chromium page to record a short, clear product demo.

Each turn you receive:
GOAL: the user's one-sentence instruction.
PAGE: the URL and title you are on.
ELEMENTS: the numbered interactive elements currently on screen, one per line:
  <ref> <role> "<accessible name>" [hint] [flags] [value="..."]

Reply with EXACTLY ONE JSON object and nothing else — no prose, no markdown fence:
{
  "kind": "click" | "type" | "goto" | "scroll" | "key" | "wait" | "done",
  "ref": <number copied from ELEMENTS, required for click and type>,
  "value": <text to type, key name to press, milliseconds to wait, pixels to scroll>,
  "url": <absolute URL, required for goto>,
  "narration": "<one or two short spoken sentences>",
  "reason": "<short internal reason, never spoken>",
  "blocked": { "why": "<why you cannot proceed>", "needsConfirmation": <true when the step is destructive> }
}

Rules:
- Take exactly one action per reply; the next page state arrives on your next turn.
- Use the ref of the element whose accessible name matches the goal. Never invent refs.
- Fill an input with "type" BEFORE clicking the submit button that sends the form.
- Never repeat the previous action if the page did not change; pick a different route or finish.
- The narration is what a presenter says on camera: present tense, third person or imperative, at most 20 words, never the word "I", never selectors, test ids or code.
- Steps that delete, remove, revoke, pay, charge or cancel are destructive. For those, do not act: reply with blocked and needsConfirmation true, unless the goal explicitly asks for it.
- Reply with kind "done" when the goal is achieved, or when it is clearly impossible on this page.`;

const USER_HINT = `Use only the refs listed above. One JSON object.`;

/** Best-effort repair of almost-JSON: fences, trailing commas, control chars. */
export function repairJson(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, ' ')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
    .replace(/'([^'\\]*)'\s*:/g, '"$1":');
}

/** Extract the first JSON object from model output. */
export function parseJsonObject(text: string): Record<string, unknown> {
  let body = text.trim();
  body = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new PlannerError('the model did not return a JSON object', 'LLM_INVALID_JSON');
  }
  const candidate = body.slice(start, end + 1);
  for (const attempt of [candidate, repairJson(candidate)]) {
    try {
      const parsed: unknown = JSON.parse(attempt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the repair pass
    }
  }
  throw new PlannerError('the model returned JSON that could not be parsed', 'LLM_INVALID_JSON');
}

/** Hand validator (no zod): enforces the PlannedAction contract. */
export function validateAction(raw: Record<string, unknown>, observation: Observation): PlannedAction {
  const kindText = String(raw.kind ?? '').trim().toLowerCase();
  if (!(STEP_KINDS as readonly string[]).includes(kindText)) {
    throw new PlannerError(`unknown action kind "${String(raw.kind)}"`, 'LLM_INVALID_ACTION');
  }
  const kind = kindText as StepKind;

  if (raw.blocked && typeof raw.blocked === 'object') {
    const blocked = raw.blocked as Record<string, unknown>;
    return {
      kind,
      narration: typeof raw.narration === 'string' ? raw.narration : '',
      reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 240) : undefined,
      blocked: {
        why:
          typeof blocked.why === 'string' && blocked.why.trim()
            ? blocked.why.trim()
            : 'The planner is not allowed to take this step.',
        needsConfirmation: blocked.needsConfirmation === true
      }
    };
  }

  const action: PlannedAction = { kind };
  if (typeof raw.reason === 'string') action.reason = raw.reason.slice(0, 240);
  if (typeof raw.narration === 'string') action.narration = raw.narration.slice(0, 240);
  if (typeof raw.value === 'string') action.value = raw.value;
  else if (typeof raw.value === 'number' && Number.isFinite(raw.value)) action.value = String(raw.value);
  if (typeof raw.text === 'string') action.text = raw.text;
  if (typeof raw.url === 'string') action.url = raw.url.trim();

  const rawRef = raw.ref;
  const refNumber =
    typeof rawRef === 'number' ? rawRef : typeof rawRef === 'string' && rawRef.trim() !== '' ? Number(rawRef) : Number.NaN;
  if (Number.isFinite(refNumber)) {
    const element = observation.elements.find((candidate) => candidate.ref === refNumber);
    if (!element) {
      throw new PlannerError(
        `the model referenced element ${refNumber}, which is not in the current element list`,
        'LLM_INVALID_REF'
      );
    }
    action.ref = element.ref;
    // Always take the selector from the observation, never from the model.
    action.selector = element.selector;
  } else if (typeof raw.selector === 'string' && raw.selector.trim()) {
    action.selector = raw.selector.trim();
  }

  if (kind === 'click' && action.ref === undefined && !action.selector) {
    throw new PlannerError('a click needs a ref from ELEMENTS', 'LLM_INVALID_ACTION');
  }
  if (kind === 'type') {
    if (action.value === undefined) throw new PlannerError('a type action needs a value', 'LLM_INVALID_ACTION');
    if (action.ref === undefined && !action.selector) {
      throw new PlannerError('a type action needs a ref from ELEMENTS', 'LLM_INVALID_ACTION');
    }
  }
  if (kind === 'goto' && !action.url) {
    throw new PlannerError('a goto action needs an absolute url', 'LLM_INVALID_ACTION');
  }
  if (kind === 'key' && action.value === undefined) action.value = 'Enter';
  if (kind === 'wait' && action.value === undefined) action.value = '600';
  if (kind === 'scroll' && action.value === undefined) action.value = '600';
  return action;
}

function historyLines(observation: Observation): string {
  if (!observation.history.length) return 'HISTORY: (nothing yet)';
  const lines = observation.history
    .slice(-8)
    .map((action, index) => {
      const target = action.selector ? ` on ${action.selector}` : '';
      return `${observation.history.length - Math.min(8, observation.history.length) + index + 1}. ${action.kind}${target}`;
    });
  return ['HISTORY:', ...lines].join('\n');
}

/** Config after provider resolution; everything the request loop needs. */
type EffectiveLlmConfig = {
  instruction: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId: string;
  timeoutMs: number;
  credentials?: { username: string; password: string };
  useVision?: boolean;
};

export class LlmPlanner implements Planner {
  readonly name = 'llm';
  readonly wantsScreenshot: boolean;

  private readonly config: EffectiveLlmConfig;
  /** Filled lazily from the provider's /models endpoint when no model is set. */
  private model: string;

  constructor(config: LlmPlannerConfig) {
    // BYOK: env first, then the workspace's encrypted key, then whatever the
    // caller passed explicitly. A missing key only blocks providers that need
    // one, which is what makes Ollama / LM Studio work without credentials.
    const resolved: ResolvedLlm = resolveLlm();
    const providerId = (config.providerId ?? resolved.providerId).trim() || 'custom';
    const provider = findLlmProvider(providerId);
    const pick = (value: string | undefined, fallback: string): string =>
      value && value.trim() ? value.trim() : fallback;

    const baseUrl = pick(config.baseUrl, resolved.baseUrl || provider?.baseUrl || '').replace(/\/+$/, '');
    const apiKey = pick(config.apiKey, resolved.apiKey);
    const model = pick(config.model, resolved.model);
    const requiresKey = provider ? provider.requiresKey : true;

    if (requiresKey && !apiKey) throw new PlannerError('no API key configured', 'LLM_NO_KEY');
    if (!baseUrl) throw new PlannerError('no LLM base URL configured', 'LLM_NO_BASE_URL');

    this.config = {
      instruction: config.instruction,
      baseUrl,
      apiKey,
      model,
      providerId,
      timeoutMs: config.timeoutMs ?? 60_000,
      credentials: config.credentials,
      useVision: config.useVision
    };
    this.model = model;
    this.wantsScreenshot = config.useVision !== false;
  }

  /** A model id, discovering one from the provider when none is configured. */
  private async effectiveModel(): Promise<string> {
    if (this.model) return this.model;
    const discoveryProvider = findLlmProvider(this.config.providerId) ? this.config.providerId : 'custom';
    const discovery = await discoverModels(discoveryProvider, {
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl
    });
    if (!discovery.ok || discovery.models.length === 0) {
      const detail = discovery.error ? `${discovery.error.code}: ${discovery.error.message}` : 'no models returned';
      throw new PlannerError(`could not discover a model for ${this.config.providerId} (${detail})`, 'LLM_NO_MODEL');
    }
    this.model = discovery.models[0];
    return this.model;
  }

  private userMessage(observation: Observation): string {
    return [
      `GOAL: ${this.config.instruction}`,
      `PAGE: ${observation.url} — ${observation.title}`,
      `STEP: ${observation.step}`,
      this.config.credentials
        ? `TEST ACCOUNT: email ${this.config.credentials.username} / password ${this.config.credentials.password} (type these only into the email and password fields when a sign-in form is shown).`
        : '',
      historyLines(observation),
      'ELEMENTS:',
      observation.domDigest,
      USER_HINT
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  async next(observation: Observation): Promise<PlannedAction> {
    const content = await this.complete(observation);
    const parsed = parseJsonObject(content);
    return validateAction(parsed, observation);
  }

  private async complete(observation: Observation): Promise<string> {
    const model = await this.effectiveModel();
    const text = this.userMessage(observation);
    const userContent: OpenAiChatMessage['content'] =
      this.wantsScreenshot && observation.screenshotBase64
        ? [
            { type: 'text', text },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${observation.screenshotBase64}`, detail: 'low' }
            }
          ]
        : text;
    // The provider layer owns protocol + transport quirks (Anthropic Messages,
    // Azure api-key/api-version, extra headers, path suffixes).
    const request = buildChatRequest({
      providerId: this.config.providerId,
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: 0.2,
      maxTokens: 400
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 60_000);
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new PlannerError(
          `LLM endpoint returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`,
          'LLM_HTTP_ERROR'
        );
      }
      const json: unknown = await response.json();
      const content = extractChatText(json, this.config.providerId);
      if (!content.trim()) throw new PlannerError('LLM returned an empty message', 'LLM_EMPTY_RESPONSE');
      return content;
    } catch (error) {
      if (error instanceof PlannerError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new PlannerError(`LLM request failed: ${reason}`, 'LLM_REQUEST_FAILED');
    } finally {
      clearTimeout(timer);
    }
  }
}
