/**
 * Narration lines: one present-tense sentence per step, spoken by the renderer.
 *
 * Two sources, one shape:
 *  - the planner (scripted or LLM) usually supplies `action.narration`;
 *  - otherwise this module templates it from the element, and (when a key is
 *    configured) asks the LLM for a nicer line.
 *
 * House style, enforced by `cleanNarration`: 1–2 short sentences, present tense,
 * third person or imperative, never "I", never a selector or test id.
 */

import type { ElementRef, PlannedAction } from '../../core/src/types.ts';
import { LLM } from '../../core/src/config.ts';

export type LlmSettings = {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
};

const SECRETISH = /password|passcode|secret|token|api[-_ ]?key|ssn|card/i;
const SELECTORISH =
  /(`[^`]*`|data-testid\s*=\s*["']?[\w-]+["']?|\[data-testid[^\]]*\]|selector\s*[:=]\s*\S+|test\s*id\s*[:=]\s*\S+|#[A-Za-z][\w-]*\s*>\s*|\.\w+-\w+)/gi;

function lowerFirst(text: string): string {
  if (!text) return text;
  if (/^[A-Z]{2,}/.test(text)) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** "Project name field" -> "the project name" */
function spokenLabel(element?: ElementRef): string {
  const raw = (element?.name ?? '').trim();
  if (!raw) return 'the field';
  const cleaned = raw.replace(/\s*(field|input|box|textbox)$/i, '').trim() || raw;
  return `the ${lowerFirst(cleaned)}`;
}

/**
 * Template narration for a step. Deterministic, offline, and the baseline the
 * LLM narrator is compared against.
 */
export function templateNarration(action: PlannedAction, element?: ElementRef): string {
  const name = (element?.name ?? '').trim();
  switch (action.kind) {
    case 'click': {
      if (!name) return 'Click the control.';
      if (element?.role === 'link' && /^(projects?|team|billing|dashboard|settings|home|account|members?|people)$/i.test(name)) {
        return sentence(`Open the ${name} page`);
      }
      return sentence(`Click ${name}`);
    }
    case 'type': {
      if (SECRETISH.test(element?.name ?? '') || SECRETISH.test(action.selector ?? '')) {
        return 'Type the password.';
      }
      return sentence(`Type ${spokenLabel(element)}`);
    }
    case 'goto': {
      let label = '';
      try {
        const path = new URL(action.url ?? '').pathname.replace(/\/+$/, '');
        const last = path.split('/').filter(Boolean).pop();
        if (last) label = `the ${last.replace(/[-_]+/g, ' ')} page`;
      } catch {
        label = '';
      }
      return label ? sentence(`Open ${label}`) : 'Open the page.';
    }
    case 'scroll':
      return 'Scroll down to see more.';
    case 'key':
      return action.value === 'Enter' || action.value === undefined ? 'Press Enter.' : `Press ${action.value}.`;
    case 'wait':
      return 'Let the page settle.';
    case 'done':
      return '';
    default:
      return '';
  }
}

/** Strip anything that must never be spoken on camera. */
export function cleanNarration(text: string | undefined | null): string {
  if (!text) return '';
  let out = String(text)
    .replace(SELECTORISH, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!out) return '';
  out = out.replace(/^(so|and|then|okay|ok|alright),?\s+/i, '');
  return out;
}

/** A line is usable only if it is on-style. */
export function isUsableNarration(text: string): boolean {
  if (!text) return false;
  if (/\bI\b/.test(text)) return false;
  if (/selector|test\s*id|data-testid/i.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.length <= 40;
}

export function llmConfigured(settings: LlmSettings = LLM): boolean {
  if ((settings.provider ?? 'auto') === 'none') return false;
  return Boolean((settings.apiKey ?? '').trim());
}

async function llmNarration(
  action: PlannedAction,
  element: ElementRef | undefined,
  history: PlannedAction[],
  instruction: string,
  settings: LlmSettings
): Promise<string> {
  const baseUrl = (settings.baseUrl ?? LLM.baseUrl).replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const recent = history
    .slice(-4)
    .map((h) => `${h.kind}${h.narration ? `: ${h.narration}` : ''}`)
    .join('\n');

  const body = {
    model: settings.model ?? LLM.model,
    temperature: 0.4,
    max_tokens: 120,
    messages: [
      {
        role: 'system',
        content:
          'You write the spoken narration for a recorded product demo. ' +
          'Reply with one or two short sentences (max 22 words), present tense, third person or imperative. ' +
          'Never say "I". Never mention selectors, ids, test ids or technical details. ' +
          'No quotation marks, no stage directions. Describe what the viewer sees happening.'
      },
      {
        role: 'user',
        content: [
          `Demo goal: ${instruction}`,
          `Action being performed now: ${action.kind}${element ? ` on "${element.name}"` : ''}${action.value && !SECRETISH.test(element?.name ?? '') ? ` with the value "${action.value}"` : ''}`,
          recent ? `Recent actions:\n${recent}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      }
    ]
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.timeoutMs ?? LLM.timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey ?? ''}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`narration LLM HTTP ${response.status}`);
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? '';
    return cleanNarration(content.replace(/^["'“”]+|["'“”]+$/g, ''));
  } finally {
    clearTimeout(timeout);
  }
}

export type Narrator = {
  /** Best available line for this step. Never throws, never empty for real actions. */
  narrate: (action: PlannedAction, element?: ElementRef, history?: PlannedAction[], instruction?: string) => Promise<string>;
};

export type NarratorConfig = {
  llm?: LlmSettings | null;
  instruction?: string;
};

/**
 * Build a narrator. With no LLM key this is pure templating — which is exactly
 * what the offline demo path wants: zero network, zero credentials.
 */
export function createNarrator(config: NarratorConfig = {}): Narrator {
  const settings = config.llm ?? LLM;
  const useLlm = llmConfigured(settings);

  return {
    async narrate(action, element, history = [], instruction = config.instruction ?? ''): Promise<string> {
      const templated = templateNarration(action, element);
      if (!useLlm) return templated;
      try {
        const line = await llmNarration(action, element, history, instruction, settings);
        if (isUsableNarration(line)) return line;
      } catch {
        // Offline, rate-limited, or the endpoint is not an LLM — template stands.
      }
      return templated;
    }
  };
}

/** Synchronous template-only narrator, for tests and the offline planner. */
export function templateOnlyNarrator(): Narrator {
  return {
    async narrate(action, element) {
      return templateNarration(action, element);
    }
  };
}
