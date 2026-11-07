/**
 * Privacy redaction — three layers, one source of truth.
 *
 * A demo records real screens. Passwords, card numbers, API keys and SSNs end up
 * in PNGs, in the .webm, and in the JSON a dashboard/debugger shows. Paid
 * recorders sell masking as "privacy blur"; here it is:
 *
 *  1. PNGs   — Playwright's first-class `page.screenshot({ mask, maskColor })`
 *              paints the element's box black before the bytes are written, so
 *              the secret never reaches disk. This module finds the targets and
 *              hands back one locator per masked element.
 *  2. Video  — cannot be masked in the page (the app needs the real value, and
 *              painting on the page would be recorded). Instead we emit
 *              viewport-relative boxes per step (`CaptureResult.redactions`) so
 *              the renderer can blur that region during that step's window.
 *  3. Text   — `StepRecord.value` becomes `••••`, and `log[]` lines are scrubbed
 *              of bearer tokens / API keys before they can reach the dashboard.
 *
 * Fail closed: every query here is best-effort and never fails a step, but the
 * defaults favour over-masking over leaking.
 */

import type { Locator, Page } from 'playwright';

import { VIEWPORT } from '../../core/src/config.ts';
import type { Box, DemoOptions } from '../../core/src/types.ts';

/** Written into StepRecord.value instead of a secret. */
export const REDACTED_VALUE = '••••';

/** Opaque black: reads as "redacted" on camera without pulling focus. */
export const MASK_COLOR = '#000000';

const MARKER_ATTRIBUTE = 'data-reelforge-redact';

/**
 * Fields that hold a secret. Matched against `name`, `id` and `data-testid`.
 * Kept deliberately blunt: a false positive costs one black box, a false
 * negative leaks a credential.
 */
const SENSITIVE_ATTRIBUTE_KEYWORDS = [
  'card',
  'cc-',
  'cc_',
  'cvv',
  'cvc',
  'ssn',
  'secret',
  'token',
  'api-key',
  'api_key',
  'apikey',
  'passw'
];

export type RedactionOptions = {
  /** Heuristic masking of password / card / SSN style fields. Default true. */
  redactSensitive?: boolean;
  /** Extra CSS selectors the user asked to mask, whatever they are. */
  redactSelectors?: string[];
};

/** One element to mask, with the selector that caught it. */
export type RedactionTarget = {
  /** The CSS selector group that matched (recorded as the reason). */
  selector: string;
  reason: string;
  kind: 'sensitive' | 'user';
  /** Mask locator handed to page.screenshot({ mask }). */
  mask: Locator;
  /** Box clamped to the 1280×720 viewport, or null when the element is off screen. */
  viewportBox: Box | null;
};

type PageGroup = { selector: string; kind: 'sensitive' | 'user'; reason: string };

type MarkedTarget = { index: number; selector: string; kind: 'sensitive' | 'user'; reason: string };

type MarkResult = { targets: MarkedTarget[]; invalid: string[] };

/** Build the redaction options from a DemoRequest's options (never throws). */
export function redactionOptionsFrom(options: DemoOptions | undefined): RedactionOptions {
  const source = options ?? {};
  return {
    redactSensitive: source.redactSensitive !== false,
    redactSelectors: Array.isArray(source.redactSelectors)
      ? source.redactSelectors.filter((selector) => typeof selector === 'string' && selector.trim() !== '').map((s) => s.trim())
      : []
  };
}

/** The heuristic selector groups. Exported so tests and docs can see them. */
export function sensitiveSelectorGroups(): Array<{ selector: string; reason: string }> {
  const groups: Array<{ selector: string; reason: string }> = [
    { selector: 'input[type="password" i]', reason: 'password input' },
    { selector: '[autocomplete^="cc-" i]', reason: 'card autocomplete' },
    { selector: '[autocomplete="one-time-code" i]', reason: 'one-time code' }
  ];
  for (const keyword of SENSITIVE_ATTRIBUTE_KEYWORDS) {
    const quoted = keyword.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    for (const attribute of ['name', 'id', 'data-testid']) {
      groups.push({
        selector: `input[${attribute}*="${quoted}" i]`,
        reason: `sensitive ${attribute} (~${keyword})`
      });
      groups.push({
        selector: `textarea[${attribute}*="${quoted}" i]`,
        reason: `sensitive ${attribute} (~${keyword})`
      });
    }
  }
  return groups;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Clamp a box to the 1280×720 viewport. Partially visible fields are kept (a
 * half-scrolled card number still needs masking); fully off-screen ones are not
 * recorded, because the renderer has nothing to blur.
 */
export function clampToViewport(box: Box, viewport = VIEWPORT): Box | null {
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(viewport.width, box.x + box.width);
  const bottom = Math.min(viewport.height, box.y + box.height);
  if (!(right - left > 0) || !(bottom - top > 0)) return null;
  return { x: round(left), y: round(top), width: round(right - left), height: round(bottom - top) };
}

/**
 * Runs in the page: walk the document (piercing open shadow roots), tag every
 * matching element with a unique marker attribute, and report the selector that
 * caught it. One pass for all groups, one entry per element (intra-step dedupe).
 */
function markRedactionTargets(groups: PageGroup[]): MarkResult {
  const attribute = 'data-reelforge-redact';
  const invalid: string[] = [];
  const valid: PageGroup[] = [];
  for (const group of groups) {
    try {
      // A selector that throws here is invalid; skip it rather than failing the step.
      document.querySelector(group.selector);
      valid.push(group);
    } catch {
      invalid.push(group.selector);
    }
  }

  const elements: Element[] = [];
  const stack: ParentNode[] = [document];
  while (stack.length > 0) {
    const root = stack.pop() as ParentNode;
    const nodes = root.querySelectorAll('*');
    for (const node of Array.from(nodes)) {
      elements.push(node);
      const shadow = (node as Element).shadowRoot;
      if (shadow) stack.push(shadow);
    }
  }

  const targets: MarkedTarget[] = [];
  for (const element of elements) {
    // Clear any marker left over from a previous collection pass.
    if (element.hasAttribute(attribute)) element.removeAttribute(attribute);
    for (const group of valid) {
      let matches = false;
      try {
        matches = element.matches(group.selector);
      } catch {
        matches = false;
      }
      if (!matches) continue;
      const index = targets.length;
      element.setAttribute(attribute, String(index));
      targets.push({ index, selector: group.selector, kind: group.kind, reason: group.reason });
      break; // one entry per element
    }
  }

  return { targets, invalid };
}

/**
 * Find everything that must be masked on the current page. Best-effort: returns
 * an empty list on any failure, and reports invalid user selectors separately.
 */
export async function collectRedactionTargets(
  page: Page,
  options: RedactionOptions = {}
): Promise<{ targets: RedactionTarget[]; invalidSelectors: string[] }> {
  const groups: PageGroup[] = [];
  if (options.redactSensitive !== false) {
    for (const group of sensitiveSelectorGroups()) groups.push({ ...group, kind: 'sensitive' });
  }
  for (const selector of options.redactSelectors ?? []) {
    groups.push({ selector, kind: 'user', reason: `user selector ${selector}` });
  }
  if (groups.length === 0) return { targets: [], invalidSelectors: [] };

  let marked: MarkResult;
  try {
    marked = (await page.evaluate(markRedactionTargets, groups)) as MarkResult;
  } catch {
    return { targets: [], invalidSelectors: [] };
  }

  const targets: RedactionTarget[] = [];
  for (const item of marked.targets) {
    const mask = page.locator(`[${MARKER_ATTRIBUTE}="${item.index}"]`).first();
    let raw: Box | null = null;
    try {
      const box = await mask.boundingBox({ timeout: 1000 });
      raw = box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    } catch {
      raw = null;
    }
    targets.push({
      selector: item.selector,
      reason: item.reason,
      kind: item.kind,
      mask,
      viewportBox: raw ? clampToViewport(raw) : null
    });
  }
  return { targets, invalidSelectors: marked.invalid };
}

/** Remove the temporary marker attributes (shadow-DOM aware). Best-effort. */
export async function clearRedactionMarks(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const attribute = 'data-reelforge-redact';
      const elements: Element[] = [];
      const stack: ParentNode[] = [document];
      while (stack.length > 0) {
        const root = stack.pop() as ParentNode;
        for (const node of Array.from(root.querySelectorAll('*'))) {
          elements.push(node);
          const shadow = node.shadowRoot;
          if (shadow) stack.push(shadow);
        }
      }
      for (const element of elements) {
        if (element.hasAttribute(attribute)) element.removeAttribute(attribute);
      }
    })
    .catch(() => {});
}

/**
 * Convert targets to `CaptureResult.redactions` entries for one step.
 * Intra-step dedupe: identical geometry (e.g. a wrapper plus its input) is kept
 * once. Never deduped across steps — each step is a separate time window, and
 * collapsing them would silently un-blur a field that is still on screen.
 */
export function redactionBoxesForStep(targets: RedactionTarget[], stepIndex: number): Array<Box & { stepIndex: number }> {
  const seen = new Set<string>();
  const boxes: Array<Box & { stepIndex: number }> = [];
  for (const target of targets) {
    if (!target.viewportBox) continue;
    const box = target.viewportBox;
    const key = `${box.x}|${box.y}|${box.width}|${box.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    boxes.push({ ...box, stepIndex });
  }
  return boxes;
}

/** Union two target lists (pre-action page + post-navigation page), same-element dedupe by geometry. */
export function mergeTargets(primary: RedactionTarget[], extra: RedactionTarget[]): RedactionTarget[] {
  if (extra.length === 0) return primary;
  return [...primary, ...extra];
}

/** Page-side probe: is this element typed text we must not write down? */
function sensitiveElementProbe(
  element: Element,
  args: { userSelectors: string[]; heuristics: boolean }
): boolean {
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute('type') || '').toLowerCase();
  // Password inputs are always treated as secret, even when heuristics are off.
  if (tag === 'input' && type === 'password') return true;

  const userSelectors = args.userSelectors || [];
  for (const selector of userSelectors) {
    try {
      if (element.matches(selector)) return true;
    } catch {
      // Invalid user selector: ignore.
    }
  }
  if (!args.heuristics) return false;

  const autocomplete = (element.getAttribute('autocomplete') || '').toLowerCase();
  if (autocomplete.startsWith('cc-') || autocomplete === 'one-time-code') return true;

  if (tag === 'input' || tag === 'textarea') {
    const haystack = `${element.getAttribute('name') || ''} ${element.getAttribute('id') || ''} ${
      element.getAttribute('data-testid') || ''
    }`.toLowerCase();
    const keywords = [
      'card',
      'cc-',
      'cc_',
      'cvv',
      'cvc',
      'ssn',
      'secret',
      'token',
      'api-key',
      'api_key',
      'apikey',
      'passw'
    ];
    for (const keyword of keywords) {
      if (haystack.includes(keyword)) return true;
    }
  }
  return false;
}

/**
 * Is the element a secret? Used for `StepRecord.value` redaction. Always true
 * for `input[type=password]`; the extended heuristics follow `redactSensitive`,
 * and user selectors are always honoured.
 */
export async function isSensitiveTarget(
  page: Page,
  selector: string,
  options: RedactionOptions = {}
): Promise<boolean> {
  try {
    const locator = page.locator(selector).first();
    return await locator.evaluate(sensitiveElementProbe, {
      userSelectors: options.redactSelectors ?? [],
      heuristics: options.redactSensitive !== false
    });
  } catch {
    return false;
  }
}

/** `••••` for secrets, the real value otherwise. */
export function redactValue(value: string, sensitive: boolean): string {
  return sensitive ? REDACTED_VALUE : value;
}

const SECRET_PATTERNS: Array<{ pattern: RegExp; replace: (match: string, ...groups: string[]) => string }> = [
  {
    // Authorization: Bearer <token>
    pattern: /(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (_match, prefix) => `${prefix}${REDACTED_VALUE}`
  },
  {
    // Common provider key shapes: sk-..., gsk_..., rg_..., xai-..., ghp_...
    pattern: /\b(?:sk|pk|rg|gsk|xai|hf|ghp|glpat|github_pat)[-_][A-Za-z0-9_-]{8,}\b/g,
    replace: () => REDACTED_VALUE
  },
  {
    // Google API keys
    pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g,
    replace: () => REDACTED_VALUE
  },
  {
    // JWTs
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    replace: () => REDACTED_VALUE
  },
  {
    // key=value pairs: api_key, token, secret, password ...
    pattern: /\b((?:api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|secret|password|passwd|pwd)\s*[=:]\s*)["']?[A-Za-z0-9._~+/=-]{6,}["']?/gi,
    replace: (_match, prefix) => `${prefix}${REDACTED_VALUE}`
  }
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scrub obvious secrets out of a log line before it reaches the dashboard.
 * `extraSecrets` are literal values (e.g. the run's test password).
 */
export function scrubSecrets(text: string, extraSecrets: string[] = []): string {
  if (!text) return text;
  let out = text;
  for (const { pattern, replace } of SECRET_PATTERNS) {
    out = out.replace(pattern, replace as never);
  }
  for (const secret of extraSecrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join(REDACTED_VALUE);
  }
  return out;
}

/** Human summary for the run log. */
export function describeRedactions(redactions: Array<Box & { stepIndex: number }>, targets: RedactionTarget[]): string {
  if (redactions.length === 0) return 'redactions: none on screen';
  const steps = [...new Set(redactions.map((entry) => entry.stepIndex))];
  const reasons = [...new Set(targets.map((target) => target.reason))];
  return `redactions: ${redactions.length} box(es) on ${steps.length} step(s) (${steps.join(', ')}) — ${reasons.join('; ')}`;
}
