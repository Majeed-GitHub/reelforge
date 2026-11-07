/**
 * Planner factory: pick the brain for a run.
 *
 *  - No LLM key (the default, and the whole point of "offline-first") →
 *    ScriptedPlanner. Deterministic, credential-free, completes the demo flows.
 *  - Key present → LlmPlanner, wrapped in a fallback shell: if the endpoint is
 *    down, rate-limited, or returns something that cannot be validated, the run
 *    drops to the scripted planner for the rest of the steps instead of failing.
 */

import type { Observation, PlannedAction, Planner } from '../../../core/src/types.ts';
import { LLM } from '../../../core/src/config.ts';
import { findLlmProvider, resolveLlm } from '../../../providers/src/index.ts';
import { ScriptedPlanner } from './scripted.ts';
import { LlmPlanner, PlannerError } from './llm.ts';
import type { LlmSettings } from '../narration.ts';

export type PlannerConfig = {
  instruction: string;
  credentials?: { username: string; password: string };
  /** Override the endpoint settings (defaults to the BYOK provider layer). */
  llm?: LlmSettings;
  /** Send screenshots to vision-capable models. Defaults to true. */
  useVision?: boolean;
  /** Receives one-line notices about planner choice and degradation. */
  onLog?: (line: string) => void;
};

/** True when an OpenAI-compatible endpoint is configured and not disabled. */
export function llmConfigured(settings: LlmSettings = LLM): boolean {
  const providerId = (settings.provider ?? 'auto').trim().toLowerCase();
  if (providerId === 'none') return false;
  const provider = findLlmProvider(providerId);
  // Local/keyless providers (Ollama, LM Studio, a keyless gateway) only need a URL.
  if (provider && !provider.requiresKey) {
    return Boolean((settings.baseUrl ?? '').trim() || provider.baseUrl);
  }
  return Boolean((settings.apiKey ?? '').trim());
}

/**
 * Resolve the planner endpoint through the BYOK layer: env first, then the
 * workspace's encrypted key, then nothing (offline scripted planner).
 * A dashboard-saved key therefore works without restarting the process.
 */
function llmSettingsFromProviders(): LlmSettings {
  const resolved = resolveLlm();
  if (resolved.source === 'none') {
    return { provider: 'none', baseUrl: '', apiKey: '', model: '', timeoutMs: LLM.timeoutMs };
  }
  return {
    provider: resolved.providerId,
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    model: resolved.model,
    timeoutMs: LLM.timeoutMs
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof PlannerError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Keeps a run alive when the model starts misbehaving mid-run. */
class ResiliencePlanner implements Planner {
  readonly wantsScreenshot: boolean;
  private readonly primary: LlmPlanner;
  private readonly fallback: ScriptedPlanner;
  private readonly onLog?: (line: string) => void;
  private degraded = false;

  constructor(primary: LlmPlanner, fallback: ScriptedPlanner, onLog?: (line: string) => void) {
    this.primary = primary;
    this.fallback = fallback;
    this.onLog = onLog;
    this.wantsScreenshot = primary.wantsScreenshot;
  }

  get name(): string {
    return this.degraded ? `scripted (${this.primary.name} fell back)` : this.primary.name;
  }

  async next(observation: Observation): Promise<PlannedAction> {
    if (!this.degraded) {
      try {
        return await this.primary.next(observation);
      } catch (error) {
        this.degraded = true;
        this.onLog?.(`[planner] ${this.primary.name} failed (${errorMessage(error)}); continuing with the scripted planner`);
      }
    }
    return this.fallback.next(observation);
  }
}

export function createPlanner(config: PlannerConfig): Planner {
  const settings: LlmSettings = config.llm ? { ...LLM, ...config.llm } : llmSettingsFromProviders();
  const scripted = new ScriptedPlanner({
    instruction: config.instruction,
    credentials: config.credentials
  });

  if (!llmConfigured(settings)) {
    config.onLog?.('[planner] no LLM key configured — using the offline scripted planner');
    return scripted;
  }

  try {
    const primary = new LlmPlanner({
      instruction: config.instruction,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      providerId: settings.provider,
      timeoutMs: settings.timeoutMs ?? LLM.timeoutMs,
      credentials: config.credentials,
      useVision: config.useVision !== false
    });
    config.onLog?.(
      `[planner] using ${primary.name} (${settings.model || 'auto-discovered model'}) with scripted fallback`
    );
    return new ResiliencePlanner(primary, scripted, config.onLog);
  } catch (error) {
    config.onLog?.(`[planner] could not start the LLM planner (${errorMessage(error)}) — using the offline scripted planner`);
    return scripted;
  }
}

export { ScriptedPlanner, LlmPlanner, PlannerError };
export { parseIntents } from './scripted.ts';