import { sha256 } from './ids.ts';
import type { FlowStepRow, StepRecord } from './types.ts';

/**
 * A flow's identity is what it *does*, not when it was recorded: the ordered
 * kind + target label of each step. Two recordings walking the same route
 * produce the same signature, which is how "the same route is stored once,
 * however many recordings walk it" works (Director's Product Graph promise).
 */
export function flowSignature(steps: Array<StepRecord | FlowStepRow>): string {
  const normalized = steps
    .map((s) => {
      const label = 'name' in s ? (s.name ?? '') : '';
      const sel = 'selector' in s ? (s.selector ?? '') : '';
      const role = 'role' in s ? (s.role ?? '') : '';
      const kind = s.kind;
      const ident = (label || sel || role).toLowerCase().replace(/\s+/g, ' ').trim();
      return `${kind}:${ident}`;
    })
    .filter((line) => !line.startsWith('done:'))
    .join('>');
  return sha256(normalized).slice(0, 16);
}

const ARTICLES = new Set([
  'a', 'an', 'the', 'then', 'and', 'to', 'of', 'in', 'on', 'with', 'for', 'from',
  'please', 'me', 'my', 'our', 'it', 'some'
]);

/**
 * Turns an instruction into something you'd want to read in a sidebar:
 *   "Sign in, create a project called Q4 Launch, invite sam@example.com…"
 *     -> "Sign in then create project"
 *   "Create a project, then invite a teammate."  -> "Create project then invite teammate"
 * Two clauses max, four words each; articles and "called X" literals removed.
 */
export function flowNameFromInstruction(instruction: string): string {
  const cleaned = instruction.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  const clauses = cleaned
    .split(/,\s*(?:then\s+)?|\s+then\s+|;\s*|\.\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);

  const parts: string[] = [];
  for (const clause of clauses.slice(0, 2)) {
    const stripped = clause.replace(/\b(?:called|named|titled)\s+[^,]+/i, '');
    const tokens = stripped.split(' ').filter(Boolean);
    // Keep the first and last token even if they read as articles, so phrasal
    // verbs survive ("Sign in", "Set up") without keeping every "the".
    const words = tokens.filter((w, i) => {
      if (i === 0 || i === tokens.length - 1) return true;
      return !ARTICLES.has(w.toLowerCase().replace(/[^a-z0-9]/g, ''));
    });
    if (words.length === 0) continue;
    parts.push(words.slice(0, 4).join(' '));
  }

  const raw = parts.length > 0 ? parts.join(' then ') : cleaned.split(' ').slice(0, 6).join(' ');
  const name = raw.charAt(0).toUpperCase() + raw.slice(1);
  return name.length > 60 ? `${name.slice(0, 57).trimEnd()}…` : name;
}

/** Human label for a step, used in articles and guide tooltips. */
export function stepLabel(step: Pick<StepRecord, 'kind' | 'accessibleName' | 'selector' | 'narration'>): string {
  const target = step.accessibleName?.trim() || step.selector?.split('>').pop()?.trim().replace(/^#/, '') || '';
  switch (step.kind) {
    case 'click':
      return target ? `Click ${target}` : 'Click';
    case 'type':
      return target ? `Enter text in ${target}` : 'Enter text';
    case 'goto':
      return 'Open the page';
    case 'scroll':
      return 'Scroll down';
    case 'key':
      return 'Press a key';
    case 'wait':
      return 'Wait for the page';
    default:
      return step.narration || 'Step';
  }
}
