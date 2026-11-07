/**
 * Shared domain contract for Reelforge.
 *
 * Every package (agent, render, api, web, guide) builds against this file.
 * It mirrors the public surface of Screenforge Director as documented at
 * director.screenforge.co/developers and as recovered from
 * @screenforge/director-cli@0.1.8 (see docs/ARCHITECTURE.md).
 *
 * Constraint: this repo runs TypeScript directly on Node >= 22.6 via type
 * stripping, so only *erasable* syntax is allowed here: no `enum`, no
 * `namespace`, no parameter properties. Use `const` maps + union types.
 */

// ---------------------------------------------------------------------------
// Enums (as const maps — erasable)
// ---------------------------------------------------------------------------

export const DEMO_STATUSES = ['queued', 'running', 'complete', 'failed', 'cancelled'] as const;
export type DemoStatus = (typeof DEMO_STATUSES)[number];

export const STEP_KINDS = ['click', 'type', 'scroll', 'goto', 'key', 'wait', 'done'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const FLOW_STATUSES = ['fresh', 'stale', 'draft'] as const;
export type FlowStatus = (typeof FLOW_STATUSES)[number];

export const ARTICLE_CHANNELS = ['help_center', 'internal_training'] as const;
export type ArticleChannel = (typeof ARTICLE_CHANNELS)[number];

export const ARTICLE_STATUSES = ['draft', 'published'] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export const SIGN_IN_MODES = ['none', 'password', 'session'] as const;
export type SignInMode = (typeof SIGN_IN_MODES)[number];

/** Stable error codes. Mirrors Director's documented failure envelope. */
export const ERROR_CODES = {
  VALIDATION_ERROR: 400,
  INVALID_INSTRUCTION: 400,
  TARGET_UNREACHABLE: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  DOMAIN_BLOCKED: 403,
  NOT_FOUND: 404,
  DOMAIN_AUTHORIZATION_REQUIRED: 409,
  DESTRUCTIVE_ACTIONS_CONFIRMATION_REQUIRED: 409,
  ENVIRONMENT_SESSION_EXPIRED: 409,
  INSUFFICIENT_CREDITS: 402,
  CONCURRENCY_LIMIT_REACHED: 429,
  INTERNAL_ERROR: 500
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

// ---------------------------------------------------------------------------
// Job inputs / outputs
// ---------------------------------------------------------------------------

export type Target = {
  type: 'url' | 'tunnel';
  url: string;
};

export type DemoOptions = {
  /** BCP-47-ish locale for narration + captions, e.g. "en", "es", "hi". */
  language?: string;
  /** 1–60, default 30. Playwright records at this rate. */
  fps?: number;
  /** Output height in px, 120–2160. Width follows the 16:9 viewport. */
  scaleHeight?: number;
  /** Step budget so a run ends instead of wandering. 1–60, default 40. */
  maxSteps?: number;
  /** Burn a Reelforge wordmark into the render. Default true. */
  watermark?: boolean;
  /** Saved recording preset id. */
  presetId?: string;
  /** Auto-zoom strength, 1.0 = off, 1.6 = default. */
  zoom?: number;
  /** Narration provider override: auto | sapi | openai | edge | none. */
  voice?: string;
  /** Headless browser. Default true. */
  headless?: boolean;
};

export type DemoRequest = {
  /** Required. Plain language, 3–2000 chars. */
  instruction: string;
  /** Where to record. Required unless environmentId is given. */
  target?: Target;
  /** Saved product: stored sign-in + joins that product's Product Graph. */
  environmentId?: string;
  /** Page to start on, resolved against the environment's base URL. */
  path?: string;
  /** Test account for this run only. Literal values. */
  credentials?: { username: string; password: string };
  /** Confirms you own the product or may demo it. Required once per new domain. */
  authorized?: boolean;
  /** Allows destructive steps (delete/revoke) to be taken. */
  confirmDestructive?: boolean;
  options?: DemoOptions;
};

export type DemoOutcome = {
  goalMet: boolean;
  stepsCompleted: number;
  whatWasShown: string[];
  /** Set when the run halted ahead of a step it was not cleared to take. */
  stoppedBefore?: string;
};

export type DemoFailure = {
  code: ErrorCode | string;
  message: string;
  remediation?: { action: string; hint?: string };
};

export type DemoQuestion = {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
};

// ---------------------------------------------------------------------------
// Capture (what the browser agent hands to the renderer)
// ---------------------------------------------------------------------------

export type Box = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };

/** One performed (or attempted) action, with timing relative to video start. */
export type StepRecord = {
  index: number;
  kind: StepKind;
  /** Spoken line for this step. Empty = silent step. */
  narration: string;
  /** Milliseconds from recording start. */
  startedAtMs: number;
  endedAtMs: number;
  selector?: string;
  role?: string;
  accessibleName?: string;
  /** Bounding box of the target element, in CSS px, for auto-zoom. */
  box?: Box;
  /** Where the pointer landed, in CSS px. */
  point?: Point;
  url?: string;
  /** Typed value (secrets already redacted by the agent). */
  value?: string;
  /** Absolute path to the PNG captured at step end. */
  screenshotPath?: string;
  /** Planner's reason, useful for debugging bad runs. */
  reason?: string;
  error?: string;
};

export type CaptureResult = {
  steps: StepRecord[];
  viewport: { width: number; height: number };
  /** Path to Playwright's raw .webm, if video was recorded. */
  videoPath?: string;
  /** Wall-clock recording start (epoch ms) used to align video time. */
  startedAtEpochMs: number;
  /** Wall-clock end of the browser session. */
  endedAtEpochMs: number;
  goalMet: boolean;
  finalUrl: string;
  stoppedBefore?: string;
  error?: DemoFailure;
  /** Raw agent log lines, surfaced in the dashboard for debugging. */
  log: string[];
};

// ---------------------------------------------------------------------------
// Render (what the renderer produces)
// ---------------------------------------------------------------------------

export type NarrationLine = {
  stepIndex: number;
  text: string;
  /** Start offset into the finished video, ms. */
  startMs: number;
  /** Measured audio duration, ms. */
  durationMs: number;
  /** Absolute path to synthesized audio (wav/mp3), if any. */
  audioPath?: string;
};

export type RenderOptions = {
  fps: number;
  scaleHeight: number;
  watermark: boolean;
  language: string;
  voice?: string;
  /** Brand text for the watermark. */
  watermarkText?: string;
  /** Auto-zoom strength, 1.0 = off, 1.6 = default. */
  zoom?: number;
};

export type RenderInput = {
  capture: CaptureResult;
  steps: StepRecord[];
  outDir: string;
  /** Absolute path to write the finished MP4. */
  outputPath: string;
  options: RenderOptions;
};

export type RenderResult = {
  videoPath: string;
  posterPath?: string;
  durationMs: number;
  width: number;
  height: number;
  lines: NarrationLine[];
  srtPath?: string;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Planner contract (the "agent brain")
// ---------------------------------------------------------------------------

export type ElementRef = {
  /** Stable index handed to the planner, e.g. 7 -> click 7. */
  ref: number;
  role: string;
  name: string;
  tag: string;
  /** CSS selector the runner can act on. */
  selector: string;
  box: Box;
  /** Inputs, links, buttons: whether it looks safe to touch. */
  destructive?: boolean;
  disabled?: boolean;
};

export type Observation = {
  step: number;
  url: string;
  title: string;
  /** Viewport-sized PNG as base64 (planner decides whether to look at it). */
  screenshotBase64?: string;
  /** Compact, numbered accessibility/DOM digest. */
  domDigest: string;
  elements: ElementRef[];
  history: PlannedAction[];
  goal: string;
};

export type PlannedAction = {
  kind: StepKind;
  ref?: number;
  selector?: string;
  text?: string;
  value?: string;
  url?: string;
  /** Narration for this step, in the demo language. */
  narration?: string;
  reason?: string;
  /** Set when the planner is refused permission to act. */
  blocked?: { why: string; needsConfirmation?: boolean };
};

export interface Planner {
  readonly name: string;
  /** Decide the single next action. Returning kind:'done' ends the run. */
  next(obs: Observation): Promise<PlannedAction>;
}

// ---------------------------------------------------------------------------
// Persisted rows (SQLite)
// ---------------------------------------------------------------------------

export type WorkspaceRow = {
  id: string;
  name: string;
  created_at: string;
};

export type ApiKeyRow = {
  id: string;
  workspace_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export type EnvironmentRow = {
  id: string;
  workspace_id: string;
  name: string;
  base_url: string;
  sign_in_mode: SignInMode;
  created_at: string;
  updated_at: string;
};

export type DomainRow = {
  id: string;
  workspace_id: string;
  host: string;
  attested_at: string | null;
  verification_token: string;
  verified_at: string | null;
};

export type DemoRow = {
  id: string;
  workspace_id: string;
  environment_id: string | null;
  instruction: string;
  target_type: 'url' | 'tunnel';
  target_url: string;
  status: DemoStatus;
  progress: number;
  video_path: string | null;
  poster_path: string | null;
  srt_path: string | null;
  duration_ms: number | null;
  outcome_json: string | null;
  failure_json: string | null;
  question_json: string | null;
  options_json: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  credits_used: number;
};

export type StepRow = {
  demo_id: string;
  idx: number;
  kind: StepKind;
  narration: string;
  started_at_ms: number;
  ended_at_ms: number;
  selector: string | null;
  role: string | null;
  name: string | null;
  box_json: string | null;
  url: string | null;
  screenshot_path: string | null;
};

export type FlowRow = {
  id: string;
  workspace_id: string;
  environment_id: string;
  name: string;
  signature: string;
  status: FlowStatus;
  stale_reason: string | null;
  first_seen_at: string;
  last_verified_at: string | null;
};

export type FlowStepRow = {
  flow_id: string;
  idx: number;
  kind: StepKind;
  selector: string | null;
  role: string | null;
  name: string | null;
  url: string | null;
  label: string | null;
};

export type ScreenRow = {
  id: string;
  environment_id: string;
  url_path: string;
  title: string;
  brief: string;
  screenshot_path: string | null;
  last_seen_at: string;
};

export type ArticleRow = {
  id: string;
  workspace_id: string;
  environment_id: string | null;
  flow_id: string | null;
  title: string;
  slug: string;
  excerpt: string;
  body_md: string;
  channel: ArticleChannel;
  status: ArticleStatus;
  published_url: string | null;
  created_at: string;
  updated_at: string;
};

export type GuideRow = {
  id: string;
  workspace_id: string;
  environment_id: string;
  flow_id: string | null;
  name: string;
  steps_json: string;
  status: 'draft' | 'live';
  embed_key: string;
  created_at: string;
  updated_at: string;
};

export type PresetRow = {
  id: string;
  workspace_id: string;
  name: string;
  config_json: string;
  is_default: number;
};

export type CreditLedgerRow = {
  id: string;
  workspace_id: string;
  delta_seconds: number;
  reason: string;
  demo_id: string | null;
  created_at: string;
};

export type LoginCodeRow = {
  code: string;
  environment_id: string;
  expires_at: string;
  used_at: string | null;
};
