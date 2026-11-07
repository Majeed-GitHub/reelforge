/**
 * Observer: turn the live page into the `Observation` the planner reasons about.
 *
 * The expensive part (selector generation, accessibility names, visibility) runs
 * inside the page in one `evaluate`, so a step costs one round-trip instead of
 * ~100. Selectors are generated with the same priority the Product Graph relies
 * on — data-testid > id > aria-label > name > structural nth-of-type path — so a
 * recorded flow can be reverified later (see reverify.ts).
 */

import type { Locator, Page } from 'playwright';
import type { ElementRef, Observation, PlannedAction } from '../../core/src/types.ts';

export type ObserveOptions = {
  /** Loop index (0-based); also recorded on the observation. */
  step?: number;
  /** The user's one-sentence instruction. */
  goal?: string;
  /** Actions already taken in this run. */
  history?: PlannedAction[];
  /**
   * Capture a viewport PNG as base64. Only vision-capable planners ask for this,
   * because a screenshot per step is the single most expensive part of a run.
   */
  screenshot?: boolean;
  /**
   * Locators to paint over before the screenshot is encoded — sensitive fields
   * must never reach a planner (or a log) as pixels.
   */
  mask?: Locator[];
  /** Fill colour for masked regions. Defaults to opaque black. */
  maskColor?: string;
  /** Maximum elements to inventory (default 120). */
  limit?: number;
};

type DomScan = {
  url: string;
  title: string;
  elements: ElementRef[];
  digestLines: string[];
};

type ScanResult = {
  url: string;
  title: string;
  elements: Array<{
    ref: number;
    role: string;
    name: string;
    tag: string;
    selector: string;
    box: { x: number; y: number; width: number; height: number };
    destructive: boolean;
    disabled: boolean;
    hint: string;
    value?: string;
  }>;
  digestLines: string[];
};

/** Observe the page and assemble a planner-ready observation. */
export async function observe(page: Page, opts: ObserveOptions = {}): Promise<Observation> {
  const scan = (await page.evaluate(scanDom, { limit: opts.limit ?? 120 })) as ScanResult;

  let screenshotBase64: string | undefined;
  if (opts.screenshot) {
    try {
      const buffer = await page.screenshot({
        type: 'png',
        ...(opts.mask && opts.mask.length > 0 ? { mask: opts.mask, maskColor: opts.maskColor ?? '#000000' } : {})
      });
      screenshotBase64 = Buffer.from(buffer).toString('base64');
    } catch {
      // A screenshot is a nice-to-have; never fail an observation over it.
    }
  }

  return {
    step: opts.step ?? 0,
    url: scan.url,
    title: scan.title,
    screenshotBase64,
    domDigest: scan.digestLines.join('\n'),
    elements: scan.elements.map((el) => ({
      ref: el.ref,
      role: el.role,
      name: el.name,
      tag: el.tag,
      selector: el.selector,
      box: el.box,
      destructive: el.destructive,
      disabled: el.disabled
    })),
    history: opts.history ?? [],
    goal: opts.goal ?? ''
  };
}

/** Compact one-line-per-element digest, useful in logs and LLM prompts. */
export function digestFrom(observation: Observation): string {
  return observation.domDigest;
}

/**
 * Runs in the page. Must stay self-contained: Playwright serialises this
 * function's source, so it may not reference anything from module scope.
 * (Type annotations are erased by Node before the source is serialised.)
 */
function scanDom(arg: { limit: number }): ScanResult {
  const LIMIT = arg && typeof arg.limit === 'number' && arg.limit > 0 ? arg.limit : 120;
  const CANDIDATE_SELECTOR = [
    'a',
    'button',
    'input',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[data-testid]',
    '[onclick]'
  ].join(', ');

  const DESTRUCTIVE = /(^|[^a-z])(delete|deletes|remove|removes|revoke|revokes|pay|pays|purchase|charge|refund|deactivate|destroy|cancel subscription|downgrade)([^a-z]|$)/i;
  const VIEWPORT_PAD = 2;

  function clean(value: string | null | undefined, max = 90): string {
    if (!value) return '';
    const text = String(value).replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
  }

  function cssEscape(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, (ch) => `\\${ch}`);
  }

  function quoted(value: string): string {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function attrSelector(tag: string, attr: string, value: string): string {
    return `${tag}[${attr}="${quoted(value)}"]`;
  }

  function nthOfType(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent) return tag;
    let index = 1;
    for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.tagName === el.tagName) index += 1;
    }
    return `${tag}:nth-of-type(${index})`;
  }

  /** data-testid > id > aria-label > name > structural path under an anchor. */
  function stableSelector(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${quoted(testId)}"]`;
    const id = el.getAttribute('id');
    if (id) return `#${cssEscape(id)}`;
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return attrSelector(tag, 'aria-label', ariaLabel);
    const name = el.getAttribute('name');
    if (name) return attrSelector(tag, 'name', name);
    return pathSelector(el);
  }

  function pathSelector(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    let anchored = false;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const id = node.getAttribute('id');
      const testId = node.getAttribute('data-testid');
      if (node !== el && id) {
        parts.unshift(`#${cssEscape(id)}`);
        anchored = true;
        break;
      }
      if (node !== el && testId) {
        parts.unshift(`[data-testid="${String(testId).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`);
        anchored = true;
        break;
      }
      if (node === document.body) {
        break;
      }
      parts.unshift(nthOfType(node));
      node = node.parentElement;
    }
    if (!anchored) parts.unshift('body');
    return parts.join(' > ');
  }

  function labelTextFor(el: Element): string {
    const id = el.getAttribute('id');
    if (id) {
      const escaped = String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const label = document.querySelector(`label[for="${escaped}"]`);
      if (label) return clean(label.textContent);
    }
    const wrapping = el.closest('label');
    if (wrapping) {
      const own = clean(el.textContent);
      const whole = clean(wrapping.textContent);
      return whole.replace(own, '').trim() || whole;
    }
    return '';
  }

  function accessibleName(el: Element): string {
    const ariaLabel = clean(el.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((token) => document.getElementById(token))
        .filter((node): node is HTMLElement => Boolean(node))
        .map((node) => clean(node.textContent))
        .filter(Boolean);
      if (parts.length) return clean(parts.join(' '));
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        const value = clean((el as HTMLInputElement).value);
        if (value) return value;
      }
      const fromLabel = labelTextFor(el);
      if (fromLabel) return fromLabel;
      const alt = clean(el.getAttribute('alt'));
      if (alt) return alt;
      const placeholder = clean(el.getAttribute('placeholder'));
      if (placeholder) return placeholder;
      const name = clean(el.getAttribute('name'));
      if (name) return name;
      const title = clean(el.getAttribute('title'));
      if (title) return title;
      return type === 'password' ? 'Password' : '';
    }
    if (tag === 'textarea' || tag === 'select') {
      const fromLabel = labelTextFor(el);
      if (fromLabel) return fromLabel;
      const name = clean(el.getAttribute('name'));
      if (name) return name;
    }
    const inner = clean((el as HTMLElement).innerText || el.textContent);
    if (inner) return inner;
    const title = clean(el.getAttribute('title'));
    if (title) return title;
    const placeholder = clean(el.getAttribute('placeholder'));
    if (placeholder) return placeholder;
    const name = clean(el.getAttribute('name'));
    if (name) return name;
    const testId = clean(el.getAttribute('data-testid'));
    if (testId) return testId.replace(/[-_]+/g, ' ');
    return '';
  }

  function roleOf(el: Element): string {
    const explicit = (el.getAttribute('role') || '').trim();
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (el.hasAttribute('onclick')) return 'button';
    return 'generic';
  }

  function isVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom < VIEWPORT_PAD || rect.right < VIEWPORT_PAD) return false;
    if (rect.top > window.innerHeight - VIEWPORT_PAD || rect.left > window.innerWidth - VIEWPORT_PAD) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const opacity = Number(style.opacity);
    if (Number.isFinite(opacity) && opacity <= 0.05) return false;
    if (style.pointerEvents === 'none' && el.getAttribute('data-testid') === null) {
      // A pointer-events:none element can still be a valid observation target,
      // but Playwright cannot click it; keep it out of the inventory.
      return false;
    }
    return true;
  }

  function isDisabled(el: Element): boolean {
    if ((el as HTMLInputElement).disabled === true) return true;
    const ariaDisabled = el.getAttribute('aria-disabled');
    return ariaDisabled === 'true';
  }

  function valueHint(el: Element, tag: string, type: string, name: string): string {
    if (tag !== 'input' && tag !== 'textarea') return '';
    if (type === 'password' || /password|secret|token|passcode/i.test(name)) return '';
    const value = (el as HTMLInputElement).value;
    if (!value) return '';
    return ` value="${clean(value, 40)}"`;
  }

  const digestLines: string[] = [`URL: ${location.pathname}${location.search}`, `TITLE: ${document.title}`];
  const elements: ScanResult['elements'] = [];
  const seen = new Set<Element>();
  let nodes: Element[] = [];
  try {
    nodes = Array.from(document.querySelectorAll(CANDIDATE_SELECTOR));
  } catch {
    nodes = [];
  }

  let ref = 0;
  for (const node of nodes) {
    if (ref >= LIMIT) break;
    if (seen.has(node)) continue;
    seen.add(node);
    const tag = node.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body' || tag === 'head') continue;
    if (node.closest('#__reelforge_cursor_host')) continue;
    if (node.closest('[aria-hidden="true"]') && !node.hasAttribute('data-testid')) continue;
    const type = tag === 'input' ? (node.getAttribute('type') || 'text').toLowerCase() : '';
    if (type === 'hidden') continue;
    if (!isVisible(node)) continue;

    const name = accessibleName(node);
    const role = roleOf(node);
    // A bare container that only carries a test id is not an action target.
    if (role === 'generic' && tag !== 'input' && tag !== 'select' && tag !== 'textarea' && !node.hasAttribute('onclick')) {
      if (!node.hasAttribute('data-testid') || name === '') continue;
    }

    const rect = node.getBoundingClientRect();
    const box = {
      x: Math.round(rect.left * 10) / 10,
      y: Math.round(rect.top * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10
    };
    const selector = stableSelector(node);
    const destructive = DESTRUCTIVE.test(name) || DESTRUCTIVE.test(clean(node.getAttribute('aria-label')));
    const disabled = isDisabled(node);

    const testId = node.getAttribute('data-testid');
    const id = node.getAttribute('id');
    const nameAttr = node.getAttribute('name');
    const hint = testId
      ? `[data-testid=${testId}]`
      : id
        ? `#${id}`
        : nameAttr
          ? `[name=${nameAttr}]`
          : selector.length > 64
            ? `${selector.slice(0, 63)}…`
            : selector;

    elements.push({
      ref,
      role,
      name,
      tag,
      selector,
      box,
      destructive,
      disabled,
      hint,
      value: valueHint(node, tag, type, name) || undefined
    });

    const flags: string[] = [];
    if (disabled) flags.push('[disabled]');
    if (destructive) flags.push('[destructive]');
    const value = valueHint(node, tag, type, name);
    digestLines.push(
      `${ref} ${role} ${JSON.stringify(name)} ${hint}${flags.length ? ` ${flags.join(' ')}` : ''}${value}`
    );
    ref += 1;
  }

  return {
    url: location.href,
    title: document.title,
    elements,
    digestLines
  };
}
