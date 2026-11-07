import { flowNameFromInstruction, stepLabel } from './flow.ts';
import type { ArticleChannel, StepRecord } from './types.ts';

export type ArticleDraft = {
  title: string;
  excerpt: string;
  body_md: string;
};

/**
 * Writes a step-by-step article from a recorded flow — the second of the four
 * outputs Director publishes from one capture. Template-based so it works with
 * zero model credentials; the API layers an LLM polish on top when configured.
 */
export function buildArticleFromFlow(input: {
  instruction: string;
  steps: StepRecord[];
  channel: ArticleChannel;
  productName?: string;
  /** Relative URLs (served by the API under /files/...). */
  screenshotUrls?: Map<number, string>;
  language?: string;
}): ArticleDraft {
  const steps = input.steps.filter((s) => s.kind !== 'done');
  const title = flowNameFromInstruction(input.instruction);
  const product = input.productName ? ` in ${input.productName}` : '';
  const isInternal = input.channel === 'internal_training';

  const intro = isInternal
    ? `Internal runbook for "${title}"${product}. Built from a recorded walkthrough, so it matches what the product actually does today.`
    : `Here's how to ${lowerFirst(title)}${product}. Follow the steps below; screenshots show exactly where to click.`;

  const lines: string[] = [`# ${title}`, '', intro, ''];

  if (steps.length === 0) {
    lines.push('_No steps were captured for this flow._');
  } else {
    steps.forEach((step, i) => {
      const label = stepLabel(step);
      const shot = input.screenshotUrls?.get(step.index);
      lines.push(`## ${i + 1}. ${label}`);
      lines.push('');
      if (step.kind === 'type' && step.value) {
        lines.push(`Type \`${step.value}\`.`);
      } else if (step.kind === 'goto' && step.url) {
        lines.push(`Go to ${step.url}.`);
      } else if (step.narration) {
        lines.push(`${step.narration.replace(/\.?$/, '.')}`);
      } else {
        lines.push(`${label}.`);
      }
      if (shot) {
        lines.push('');
        lines.push(`![${label}](${shot})`);
      }
      lines.push('');
    });
  }

  lines.push('---');
  lines.push('');
  lines.push(
    isInternal
      ? '_Generated from a recorded walkthrough. If this page drifts from the product, re-record the flow and regenerate._'
      : `_Still stuck? Reply to this article${product ? '' : ''} and we'll help._`
  );

  const excerpt = `${steps.length} step${steps.length === 1 ? '' : 's'}: ${steps
    .slice(0, 3)
    .map((s) => stepLabel(s).toLowerCase())
    .join(', ')}${steps.length > 3 ? ', …' : ''}.`;

  return { title, excerpt, body_md: lines.join('\n') };
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The embeddable in-app guide: one step per recorded action, with a selector. */
export function buildGuideSteps(steps: StepRecord[]): Array<{
  idx: number;
  selector: string | null;
  role: string | null;
  name: string | null;
  title: string;
  body: string;
  url: string | null;
}> {
  return steps
    .filter((s) => s.kind !== 'done' && (s.selector || s.role))
    .map((s) => ({
      idx: s.index,
      selector: s.selector ?? null,
      role: s.role ?? null,
      name: s.accessibleName ?? null,
      title: stepLabel(s),
      body: s.narration || stepLabel(s),
      url: s.url ? safePath(s.url) : null
    }));
}

function safePath(url: string): string | null {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return null;
  }
}
