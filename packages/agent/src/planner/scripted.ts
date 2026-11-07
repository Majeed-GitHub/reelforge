/**
 * The offline planner. This is the DEFAULT brain: it makes the whole pipeline
 * (browser → video → article → guide) work with zero credentials.
 *
 * It is not a chatbot — it is a small deterministic instruction grammar:
 *
 *   parse the sentence into an ordered intent list
 *     sign in · create project · invite teammate · upgrade plan · open page
 *   then, each turn, look at the observed element inventory and emit exactly
 *   one action that advances the first unfinished intent.
 *
 * Because it re-decides from the live page every turn (rather than replaying a
 * hard-coded script), it works across full page navigations and adapts when a
 * page differs slightly — and it degrades by skipping an intent it cannot
 * satisfy, never by looping.
 */

import type { ElementRef, Observation, PlannedAction, Planner } from '../../../core/src/types.ts';

export type ScriptedPlannerConfig = {
  instruction: string;
  /** Test account for this run; only used when a login form is present. */
  credentials?: { username: string; password: string };
};

type IntentKind = 'signin' | 'create_project' | 'invite' | 'upgrade' | 'navigate';

type Intent = {
  kind: IntentKind;
  label: string;
  done: boolean;
  stage: number;
  /** Bounded patience: navigations are not always committed on the next observe. */
  waits: number;
  params: {
    projectName?: string;
    email?: string;
    plan?: string;
    navLabel?: string;
  };
};

type PageFacts = {
  path: string;
  signedIn: boolean;
  passwordField?: ElementRef;
  emailField?: ElementRef;
  loginSubmit?: ElementRef;
  signInLink?: ElementRef;
  newProject?: ElementRef;
  projectName?: ElementRef;
  createSubmit?: ElementRef;
  inviteEmail?: ElementRef;
  inviteSubmit?: ElementRef;
  upgradeButton?: ElementRef;
  nav: (pattern: RegExp) => ElementRef | undefined;
};

// ---------------------------------------------------------------------------
// Instruction parsing
// ---------------------------------------------------------------------------

function extractProjectName(instruction: string): string | undefined {
  const patterns = [
    /(?:called|named|titled)\s+["“'`]([^"”'`]+)["”'`]/i,
    /(?:called|named|titled)\s+([^,.;\n]+?)(?=\s+(?:then|and|in|to|for)\b|[,.;]|$)/i,
    /\bproject\s+["“'`]([^"”'`]+)["”'`]/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(instruction);
    const value = match?.[1]?.trim();
    if (value && value.length <= 80) return value;
  }
  return undefined;
}

function extractEmail(instruction: string): string | undefined {
  return /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i.exec(instruction)?.[1];
}

function extractPlan(instruction: string): string | undefined {
  const explicit = /upgrade[^.?!]*?\b(?:to|onto)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9 ]{0,20}?)\s+plan/i.exec(instruction);
  if (explicit?.[1]) return explicit[1].trim();
  return /\b(team|pro|business|enterprise|growth|scale|starter)\b\s+plan/i.exec(instruction)?.[1];
}

function extractNavLabel(instruction: string): string | undefined {
  const match =
    /(?:show|open|go to|navigate to|visit|record)[^.?!]*?\b(projects?|team|billing|dashboard|settings|home|members?|account|plans?)\b\s*(?:page|tab|screen|view)?/i.exec(
      instruction
    );
  const label = match?.[1]?.trim();
  if (!label) return undefined;
  return label
    .toLowerCase()
    .replace(/^project$/, 'projects')
    .replace(/^member$/, 'members')
    .replace(/^plan$/, 'billing');
}

/** Turn the one-sentence instruction into ordered intents. */
export function parseIntents(instruction: string): Intent[] {
  const text = instruction.trim();
  const lower = text.toLowerCase();
  const marks: Array<{ at: number; kind: IntentKind }> = [];

  const mark = (pattern: RegExp, kind: IntentKind): void => {
    const match = pattern.exec(lower);
    if (match) marks.push({ at: match.index, kind });
  };

  mark(/\b(?:sign|log)[\s-]?(?:in|on)\b|\blogin\b/, 'signin');
  mark(/\b(?:new|create|add|make)\b[^.?!]*\bproject\b|\bproject\b[^.?!]*\b(?:create|new)\b/, 'create_project');
  mark(/\binvite\b|\badd\b[^.?!]*\b(?:teammate|member|people|user|coworker)s?\b/, 'invite');
  mark(/\bupgrade\b|\bdowngrade\b|\bswitch\b[^.?!]*\bplan\b|\bchange\b[^.?!]*\bplan\b/, 'upgrade');

  // Stable order: position in the sentence, one intent per kind.
  marks.sort((a, b) => a.at - b.at);
  const seen = new Set<IntentKind>();
  const intents: Intent[] = [];
  for (const item of marks) {
    if (seen.has(item.kind)) continue;
    seen.add(item.kind);
    intents.push(makeIntent(item.kind, text));
  }

  // "Show me the billing page" — only when no task intent already navigates there.
  const hasTask = intents.some((i) => i.kind === 'create_project' || i.kind === 'invite' || i.kind === 'upgrade');
  if (!hasTask && /\b(?:show|open|go to|navigate to|visit|walk through)\b/i.test(lower)) {
    const navLabel = extractNavLabel(text);
    if (navLabel) {
      intents.unshift({
        kind: 'navigate',
        label: `open the ${navLabel} page`,
        done: false,
        stage: 0,
        waits: 0,
        params: { navLabel }
      });
    }
  }

  return intents;
}

function makeIntent(kind: IntentKind, instruction: string): Intent {
  switch (kind) {
    case 'signin':
      return { kind, label: 'sign in', done: false, stage: 0, waits: 0, params: {} };
    case 'create_project':
      return {
        kind,
        label: 'create a project',
        done: false,
        stage: 0,
        waits: 0,
        params: { projectName: extractProjectName(instruction) }
      };
    case 'invite':
      return { kind, label: 'invite a teammate', done: false, stage: 0, waits: 0, params: { email: extractEmail(instruction) } };
    case 'upgrade':
      return { kind, label: 'upgrade the plan', done: false, stage: 0, waits: 0, params: { plan: extractPlan(instruction) } };
    case 'navigate':
    default:
      return { kind: 'navigate', label: 'open a page', done: false, stage: 0, waits: 0, params: {} };
  }
}

// ---------------------------------------------------------------------------
// Page reading
// ---------------------------------------------------------------------------

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url;
  }
}

function isInput(el: ElementRef): boolean {
  return el.tag === 'input' || el.tag === 'textarea' || el.role === 'textbox' || el.role === 'searchbox';
}

function isClickable(el: ElementRef): boolean {
  return el.role === 'button' || el.role === 'link' || el.role === 'tab' || el.role === 'menuitem' || el.tag === 'button';
}

function readFacts(obs: Observation): PageFacts {
  const els = obs.elements;
  const path = pathOf(obs.url);
  const find = (predicate: (el: ElementRef) => boolean): ElementRef | undefined => els.find(predicate);

  const passwordField = find(
    (el) => isInput(el) && (/password/i.test(el.name) || /password|passwd/i.test(el.selector))
  );
  const emailField = find(
    (el) =>
      isInput(el) &&
      el !== passwordField &&
      (/e-?mail|user\s*name|username/i.test(el.name) || /e-?mail|username/i.test(el.selector))
  );
  const loginSubmit = find(
    (el) =>
      (el.role === 'button' || el.tag === 'button') &&
      /^(sign|log)[\s-]?(in|on)$|^(continue|submit|next|enter)$/i.test(el.name.trim()) &&
      !/sign ?out|log ?out/i.test(el.name)
  );
  const signInLink = find(
    (el) => isClickable(el) && /(sign|log)[\s-]?(in|on)|log in|login/i.test(el.name) && !/sign ?out|log ?out/i.test(el.name)
  );
  const newProject = find((el) => isClickable(el) && /new project|add project|start a project|create a project/i.test(el.name));
  const projectName = find(
    (el) =>
      isInput(el) &&
      (/project name|name of the project/i.test(el.name) ||
        /project[-_ ]?name/i.test(el.selector) ||
        (/new|create/i.test(path) && /project/i.test(path) && isInput(el)))
  );
  const createSubmit = find(
    (el) => isClickable(el) && /^create( project)?$|save project|create project|add project/i.test(el.name.trim())
  );
  const inviteEmail = find(
    (el) =>
      isInput(el) &&
      (/invite|teammate|coworker/i.test(el.name + ' ' + el.selector) ||
        (/e-?mail/i.test(el.name) && /invite|team|member/i.test(el.selector + ' ' + path)))
  );
  const inviteSubmit = find(
    (el) => isClickable(el) && /send invite|send invitation|invite|add member|add teammate|send/i.test(el.name.trim())
  );
  const upgradeButton = find(
    (el) => isClickable(el) && /upgrade|change plan|choose plan|select plan|view plans/i.test(el.name)
  );

  const hasLogout = els.some((el) => /sign ?out|log ?out|logout/i.test(el.name) || /logout/i.test(el.selector));
  const inApp = /^\/(app|dashboard|projects?|team|billing|settings|home|workspace|members?|account)/i.test(path);

  return {
    path,
    signedIn: hasLogout || (!passwordField && inApp),
    passwordField,
    emailField,
    loginSubmit,
    signInLink,
    newProject,
    projectName,
    createSubmit,
    inviteEmail,
    inviteSubmit,
    upgradeButton,
    nav: (pattern: RegExp) => els.find((el) => el.role === 'link' && pattern.test(el.name.trim()))
  };
}

// ---------------------------------------------------------------------------
// Narration helpers
// ---------------------------------------------------------------------------

function titleCase(text: string): string {
  return text.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function clickNarration(el: ElementRef): string {
  const name = el.name.trim();
  if (!name) return 'Click the control.';
  if (el.role === 'link' && /^(projects?|team|billing|dashboard|settings|home|account|members?|people|plans?)$/i.test(name)) {
    return `Open the ${titleCase(name)} page.`;
  }
  return `Click ${name}.`;
}

function typeNarration(el: ElementRef): string {
  const raw = el.name.trim().replace(/\s*(field|input|box)$/i, '');
  const label = (raw || 'field').toLowerCase();
  return `Type the ${label}.`;
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export class ScriptedPlanner implements Planner {
  readonly name = 'scripted';

  private readonly instruction: string;
  private readonly credentials?: { username: string; password: string };
  private readonly intents: Intent[];
  private readonly typed = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly unmet: string[] = [];
  private finalWaitDone = false;

  constructor(config: ScriptedPlannerConfig) {
    this.instruction = config.instruction;
    this.credentials = config.credentials;
    this.intents = parseIntents(config.instruction);
  }

  /** What the grammar understood — surfaced in run logs for debugging. */
  get recognisableIntents(): string[] {
    return this.intents.map((intent) => intent.label);
  }

  async next(obs: Observation): Promise<PlannedAction> {
    const facts = readFacts(obs);

    if (facts.signedIn) {
      for (const intent of this.intents) {
        if (intent.kind === 'signin') intent.done = true;
      }
    }

    const action = this.decide(obs, facts);
    return this.guard(action);
  }

  private decide(obs: Observation, facts: PageFacts): PlannedAction {
    // 1. Get past the door. Explicit sign-in intent first, implicit otherwise:
    //    if the instruction only talks about the app, signing in is still needed
    //    to reach it, so it happens on camera rather than being silently skipped.
    if (!facts.signedIn) {
      const signIn = this.intents.find((intent) => intent.kind === 'signin' && !intent.done);
      if (facts.passwordField || facts.loginSubmit) {
        if (this.credentials) {
          const key = `login:${facts.path}`;
          if (facts.emailField && !this.typed.has(`${key}:email`)) {
            this.typed.add(`${key}:email`);
            return this.type(facts.emailField, this.credentials.username, 'Type the email address.');
          }
          if (facts.passwordField && !this.typed.has(`${key}:password`)) {
            this.typed.add(`${key}:password`);
            return this.type(facts.passwordField, this.credentials.password, 'Type the password.');
          }
        }
        if (facts.loginSubmit) {
          return this.click(facts.loginSubmit, 'Sign in to the workspace.', 'submit the sign-in form');
        }
        if (facts.passwordField) {
          return {
            kind: 'key',
            ref: facts.passwordField.ref,
            selector: facts.passwordField.selector,
            value: 'Enter',
            narration: 'Sign in to the workspace.',
            reason: 'submit the sign-in form with Enter'
          };
        }
      }
      if (facts.signInLink) {
        return this.click(facts.signInLink, 'Open the sign-in form.', 'reach the sign-in page');
      }
      if (signIn) {
        return {
          kind: 'done',
          narration: '',
          reason: 'no sign-in form or link is visible, so the sign-in step cannot be taken'
        };
      }
      return {
        kind: 'done',
        narration: '',
        blocked: {
          why: 'This page requires signing in, but no sign-in form, link or stored session is available.',
          needsConfirmation: false
        },
        reason: 'blocked at the sign-in wall'
      };
    }

    // 2. Walk the intents in the order the instruction mentioned them.
    const pendingIndex = this.intents.findIndex((intent) => !intent.done);
    if (pendingIndex === -1) {
      if (!this.finalWaitDone) {
        this.finalWaitDone = true;
        return {
          kind: 'wait',
          value: '900',
          narration: this.summary(),
          reason: 'hold on the finished screen so the result reads on video'
        };
      }
      return { kind: 'done', narration: '', reason: `completed: ${this.completedLabels().join(', ') || 'nothing to do'}` };
    }

    const intent = this.intents[pendingIndex];
    switch (intent.kind) {
      case 'create_project':
        return this.planCreateProject(intent, facts);
      case 'invite':
        return this.planInvite(intent, facts);
      case 'upgrade':
        return this.planUpgrade(intent, facts);
      case 'navigate':
        return this.planNavigate(intent, facts);
      case 'signin':
      default:
        // We are signed in by definition here; a leftover sign-in intent is done.
        intent.done = true;
        return { kind: 'wait', value: '200', narration: '', reason: 'sign-in already satisfied' };
    }
  }

  /**
   * Patience: a click can commit its navigation after the next observe. Give a
   * just-issued navigation up to three short waits before declaring the intent
   * unsatisfiable, so a slow page is a pause rather than a skipped step.
   */
  private retryWait(intent: Intent, reason: string): PlannedAction | null {
    if (intent.waits >= 3) return null;
    intent.waits += 1;
    return { kind: 'wait', value: '300', narration: '', reason };
  }

  private planCreateProject(intent: Intent, facts: PageFacts): PlannedAction {
    if (!facts.projectName || !facts.createSubmit) {
      // Not on the form yet: open it, then come back for the fields.
      if (facts.newProject) {
        intent.stage = Math.max(intent.stage, 1);
        return this.click(facts.newProject, 'Start a new project.', 'open the new-project form');
      }
      const waiting = intent.stage >= 1 ? this.retryWait(intent, 'waiting for the new-project form to appear') : null;
      if (waiting) return waiting;
      intent.done = true;
      this.unmet.push(intent.label);
      return { kind: 'wait', value: '200', narration: '', reason: 'no way to create a project on this page' };
    }

    const name = intent.params.projectName ?? 'New project';
    if (intent.stage < 2) {
      intent.stage = 2;
      return this.type(facts.projectName, name, 'Type the project name.');
    }
    intent.done = true;
    return this.click(facts.createSubmit, `Click ${facts.createSubmit.name.trim()}.`, `create the project "${name}"`);
  }

  private planInvite(intent: Intent, facts: PageFacts): PlannedAction {
    if (!facts.inviteEmail) {
      if (intent.stage === 0) {
        const teamLink = facts.nav(/^team$|^members?$|^people$/i);
        if (teamLink) {
          intent.stage = 1;
          return this.click(teamLink, 'Open the Team page.', 'reach the invite form');
        }
      }
      const waiting = intent.stage >= 1 ? this.retryWait(intent, 'waiting for the invite form to appear') : null;
      if (waiting) return waiting;
      intent.done = true;
      this.unmet.push(intent.label);
      return { kind: 'wait', value: '200', narration: '', reason: 'no invite form on this page' };
    }

    const email = intent.params.email;
    if (intent.stage < 2) {
      intent.stage = 2;
      if (!email) {
        // Nothing to type: submit whatever is already in the field.
        if (facts.inviteSubmit) {
          intent.stage = 3;
          intent.done = true;
          return this.click(facts.inviteSubmit, 'Send the invitation.', 'submit the invite form');
        }
        intent.done = true;
        this.unmet.push(intent.label);
        return { kind: 'wait', value: '200', narration: '', reason: 'no invite email in the instruction' };
      }
      return this.type(facts.inviteEmail, email, "Type the teammate's email address.");
    }

    if (facts.inviteSubmit) {
      intent.stage = 3;
      intent.done = true;
      return this.click(facts.inviteSubmit, 'Send the invitation.', `invite ${email ?? 'the teammate'}`);
    }
    intent.done = true;
    this.unmet.push(intent.label);
    return { kind: 'wait', value: '200', narration: '', reason: 'invite form has no submit button' };
  }

  private planUpgrade(intent: Intent, facts: PageFacts): PlannedAction {
    if (facts.upgradeButton) {
      intent.done = true;
      const plan = intent.params.plan;
      const narration = plan ? `Upgrade to the ${titleCase(plan)} plan.` : 'Upgrade the workspace plan.';
      return this.click(facts.upgradeButton, narration, `choose the ${plan ?? 'upgrade'} plan`);
    }
    if (intent.stage === 0) {
      const billingLink = facts.nav(/^billing$|^plans?$|^subscription$|^pricing$/i);
      if (billingLink) {
        intent.stage = 1;
        return this.click(billingLink, 'Open the Billing page.', 'reach the plan picker');
      }
    } else {
      const waiting = this.retryWait(intent, 'waiting for the plan picker to appear');
      if (waiting) return waiting;
    }
    intent.done = true;
    this.unmet.push(intent.label);
    return { kind: 'wait', value: '200', narration: '', reason: 'no upgrade control on this page' };
  }

  private planNavigate(intent: Intent, facts: PageFacts): PlannedAction {
    const label = intent.params.navLabel;
    if (!label) {
      intent.done = true;
      return { kind: 'wait', value: '200', narration: '', reason: 'no destination in the instruction' };
    }
    const pattern = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?$`, 'i');
    const link = facts.nav(pattern) ?? facts.nav(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    if (!link) {
      intent.done = true;
      this.unmet.push(intent.label);
      return { kind: 'wait', value: '200', narration: '', reason: `no "${label}" link in the navigation` };
    }
    intent.done = true;
    return this.click(link, clickNarration(link), `open the ${label} page`);
  }

  private click(el: ElementRef, narration: string, reason: string): PlannedAction {
    return {
      kind: 'click',
      ref: el.ref,
      selector: el.selector,
      narration,
      reason
    };
  }

  private type(el: ElementRef, value: string, narration: string): PlannedAction {
    return {
      kind: 'type',
      ref: el.ref,
      selector: el.selector,
      value,
      narration,
      reason: `fill ${el.name || el.selector}`
    };
  }

  /**
   * Loop insurance. The planner re-decides from the page each turn, so issuing
   * the same action three times means it is not making progress; drop the
   * intent instead of burning the step budget.
   */
  private guard(action: PlannedAction): PlannedAction {
    if (action.kind === 'wait' || action.kind === 'done' || action.blocked) return action;
    const signature = `${action.kind}:${action.ref ?? ''}:${action.selector ?? ''}:${action.value ?? ''}`;
    const count = (this.attempts.get(signature) ?? 0) + 1;
    this.attempts.set(signature, count);
    if (count <= 2) return action;

    const pending = this.intents.find((intent) => !intent.done);
    if (pending) {
      pending.done = true;
      this.unmet.push(pending.label);
    }
    return {
      kind: 'wait',
      value: '200',
      narration: '',
      reason: `no progress after repeating ${action.kind} on ${action.selector ?? action.ref}`
    };
  }

  private completedLabels(): string[] {
    return this.intents.filter((intent) => intent.done && !this.unmet.includes(intent.label)).map((intent) => intent.label);
  }

  private summary(): string {
    const done = this.completedLabels();
    if (done.length === 0) return 'The page is ready.';
    if (done.length === 1) return `${titleCase(done[0])} is done.`;
    return `The flow is complete: ${done.slice(0, -1).join(', ')} and ${done[done.length - 1]}.`;
  }
}

export { typeNarration, clickNarration };
