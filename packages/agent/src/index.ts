/**
 * @reelforge/agent — public surface.
 *
 * The API/worker only needs three things:
 *
 *   runCapture(input)   → CaptureResult (steps + video)
 *   reverifyFlow(input) → fresh/stale check of a recorded flow, no recording
 *   createPlanner(cfg)  → the brain for a run (LLM when configured, offline otherwise)
 */

export {
  runCapture,
  resolveTargetUrl,
  DEFAULT_MAX_STEPS,
  MAX_STEPS_HARD_CAP
} from './runner.ts';
export type { RunCaptureInput, StorageState } from './runner.ts';

export { reverifyFlow, reverifyFlowSync } from './reverify.ts';
export type { ReverifyInput, ReverifyResult, StaleStep } from './reverify.ts';

export { createPlanner, llmConfigured, ScriptedPlanner, LlmPlanner, PlannerError } from './planner/index.ts';
export type { PlannerConfig } from './planner/index.ts';
export { parseIntents } from './planner/scripted.ts';

export { observe, digestFrom } from './observer.ts';
export type { ObserveOptions } from './observer.ts';

export { CURSOR_INIT_SCRIPT, INIT_SCRIPT } from './injected.ts';

export { createNarrator, templateOnlyNarrator, templateNarration, cleanNarration, isUsableNarration } from './narration.ts';
export type { Narrator, NarratorConfig, LlmSettings } from './narration.ts';
