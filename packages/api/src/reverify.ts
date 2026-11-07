import { nowIso } from '../../core/src/ids.ts';
import type { EnvironmentRow, FlowStepRow, StepRecord } from '../../core/src/types.ts';
import type { AuthContext } from './auth.ts';
import { many, one, run } from './dbq.ts';
import { loadSignIn } from './services/environments.ts';
import { markArticlesStaleForFlow } from './services/articles.ts';
import { requireFlow } from './services/graph.ts';

/**
 * Flow re-verification.
 *
 * Director re-checks a flow in the Product Graph without recording a new video:
 * it replays the recorded selectors against the live product. That browser work
 * belongs to packages/agent (`reverifyFlow`), imported lazily here so the route
 * still answers when the agent package is absent — degraded to "stale" with an
 * explicit reason instead of a 500.
 */

const AGENT_ENTRY = new URL('../../agent/src/index.ts', import.meta.url).href;

export type ReverifyStaleStep = { idx: number; selector: string | null; reason: string };

export type ReverifyResult = {
  flowId: string;
  environmentId: string;
  status: 'fresh' | 'stale';
  staleReason: string | null;
  checkedAt: string;
  agentAvailable: boolean;
  checkedSteps: number;
  staleSteps: ReverifyStaleStep[];
  dependentArticles: string[];
  detail: string;
};

/** The real agent signature (packages/agent/src/reverify.ts). */
type AgentReverify = (input: {
  baseUrl: string;
  steps: StepRecord[];
  storageState?: unknown;
  headless?: boolean;
  timeoutMs?: number;
}) => Promise<{
  status?: 'fresh' | 'stale';
  staleSteps?: Array<{ idx: number; selector?: string; reason?: string }>;
  checkedAt?: string;
  checkedSteps?: number;
  error?: string;
}>;

function flowStepsAsRecords(flowId: string): StepRecord[] {
  return many<FlowStepRow>('SELECT * FROM flow_steps WHERE flow_id = ? ORDER BY idx ASC', flowId).map((step) => ({
    index: Number(step.idx),
    kind: step.kind,
    narration: step.label ?? '',
    startedAtMs: 0,
    endedAtMs: 0,
    selector: step.selector ?? undefined,
    role: step.role ?? undefined,
    accessibleName: step.name ?? undefined,
    url: step.url ?? undefined
  }));
}

export async function reverifyFlow(
  auth: AuthContext,
  environmentId: string,
  flowId: string
): Promise<ReverifyResult> {
  const flow = requireFlow(auth, environmentId, flowId);
  const environment = one<EnvironmentRow>('SELECT * FROM environments WHERE id = ?', environmentId);
  const checkedAt = nowIso();
  const steps = flowStepsAsRecords(flowId);

  let agentAvailable = false;
  let ok = false;
  let reason: string | undefined;
  let staleSteps: ReverifyStaleStep[] = [];
  let checkedSteps = 0;

  try {
    const agent = (await import(AGENT_ENTRY)) as { reverifyFlow?: AgentReverify };
    if (typeof agent.reverifyFlow === 'function') {
      agentAvailable = true;
      const signIn = loadSignIn(auth, environmentId);
      const raw = await agent.reverifyFlow({
        baseUrl: environment?.base_url ?? '',
        steps,
        storageState: signIn.storageState,
        headless: true
      });
      checkedSteps = Number(raw.checkedSteps ?? 0);
      staleSteps = (raw.staleSteps ?? []).map((step) => ({
        idx: Number(step.idx ?? 0),
        selector: step.selector ?? null,
        reason: step.reason ?? 'selector no longer resolves'
      }));
      if (raw.error) {
        ok = false;
        reason = raw.error;
      } else if (raw.status === 'stale') {
        ok = false;
        reason =
          staleSteps.length > 0
            ? `${staleSteps.length} of ${checkedSteps || staleSteps.length} step(s) no longer resolve against the live product.`
            : 'The flow drifted from the live product.';
      } else {
        ok = true;
      }
    } else {
      reason = 'packages/agent does not export reverifyFlow in this build.';
    }
  } catch (error) {
    agentAvailable = agentAvailable && false;
    reason = `Flow re-verification could not run: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (!agentAvailable && !reason) {
    reason = 'Flow re-verification needs the browser agent (packages/agent), which is unavailable in this build.';
  }

  const status: 'fresh' | 'stale' = ok ? 'fresh' : 'stale';
  const staleReason = ok ? null : reason ?? 'The flow drifted from the live product.';

  run(
    'UPDATE flows SET status = ?, stale_reason = ?, last_verified_at = ? WHERE id = ?',
    status,
    staleReason,
    checkedAt,
    flowId
  );

  // Dependent articles stay in sync with the flow's freshness (visible banner
  // in body_md + derived `stale` flag on GET /api/articles).
  const dependentArticles = status === 'stale' ? markArticlesStaleForFlow(flowId, staleReason ?? 'The flow changed.') : [];

  return {
    flowId,
    environmentId,
    status,
    staleReason,
    checkedAt,
    agentAvailable,
    checkedSteps,
    staleSteps,
    dependentArticles,
    detail: ok
      ? `Flow still resolves (${checkedSteps} selector(s) checked).`
      : `Marked stale: ${staleReason}`
  };
}

/** Kept for the route's convenience: the flow's current freshness. */
export function flowFreshness(flowId: string): { status: string; staleReason: string | null } | null {
  const row = one<{ status: string; stale_reason: string | null }>(
    'SELECT status, stale_reason FROM flows WHERE id = ?',
    flowId
  );
  return row ? { status: row.status, staleReason: row.stale_reason } : null;
}