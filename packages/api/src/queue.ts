import { PLAN } from '../../core/src/config.ts';
import { nowIso } from '../../core/src/ids.ts';
import { one, run } from './dbq.ts';
import { runDemo } from './worker/pipeline.ts';

/**
 * In-process job queue.
 *
 * Deliberately not Redis/BullMQ: the database is the queue. `demos.status`
 * is the source of truth, the claim is an atomic UPDATE, and this loop is just
 * the pump. Restarting the process loses nothing that is still `queued`.
 *
 * Concurrency comes from PLAN.concurrency (REELFORGE_CONCURRENCY, default 3).
 */

type QueueState = {
  timer: ReturnType<typeof setInterval> | null;
  running: Map<string, AbortController>;
  ticking: boolean;
  intervalMs: number;
};

const state: QueueState = {
  timer: null,
  running: new Map(),
  ticking: false,
  intervalMs: 1000
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs stranded by a crash are closed out at boot once they are clearly dead. */
const STALE_RUN_MS = 30 * 60 * 1000;

function recoverInterruptedRuns(): number {
  const cutoff = new Date(Date.now() - STALE_RUN_MS).toISOString();
  const failure = JSON.stringify({
    code: 'INTERNAL_ERROR',
    message: 'The Reelforge worker restarted while this demo was running.',
    remediation: { action: 'retry', hint: 'Re-send POST /api/demos to record it again.' }
  });
  const changed = run(
    "UPDATE demos SET status = 'failed', failure_json = ?, progress = 1, finished_at = ? WHERE status = 'running' AND (started_at IS NULL OR started_at < ?)",
    failure,
    nowIso(),
    cutoff
  );
  if (changed > 0) console.warn(`[queue] closed ${changed} stranded run(s) left by a previous process`);
  return changed;
}

export function startWorker(options: { intervalMs?: number } = {}): void {
  if (state.timer) return;
  state.intervalMs = options.intervalMs ?? 1000;
  recoverInterruptedRuns();
  state.timer = setInterval(() => {
    void tick();
  }, state.intervalMs);
  void tick();
}

export async function stopWorker(): Promise<void> {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  for (const controller of state.running.values()) controller.abort();
  const deadline = Date.now() + 3000;
  while (state.running.size > 0 && Date.now() < deadline) await sleep(50);
}

/** Nudge the pump after a demo is enqueued (no need to wait for the interval). */
export function notifyWorker(): void {
  if (!state.timer) return;
  void tick();
}

export function abortDemo(demoId: string): boolean {
  const controller = state.running.get(demoId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function activeRuns(): Array<{ demoId: string }> {
  return [...state.running.keys()].map((demoId) => ({ demoId }));
}

export function isWorkerRunning(): boolean {
  return state.timer !== null;
}

export function workerCapacity(): number {
  return Math.max(1, PLAN.concurrency);
}

async function tick(): Promise<void> {
  if (state.ticking || !state.timer) return;
  state.ticking = true;
  let guard = 0;
  try {
    while (state.running.size < workerCapacity() && guard < 50) {
      guard += 1;
      const next = one<{ id: string }>(
        "SELECT id FROM demos WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1"
      );
      if (!next) return;

      // Atomic claim: only one process can win queued -> running.
      const claimed = run(
        "UPDATE demos SET status = 'running', started_at = ?, progress = 0.01 WHERE id = ? AND status = 'queued'",
        nowIso(),
        next.id
      );
      if (claimed === 0) continue;

      const controller = new AbortController();
      state.running.set(next.id, controller);
      void runDemo(next.id, controller.signal)
        .catch((error: unknown) => {
          console.error(
            `[queue] demo ${next.id} threw outside the pipeline: ${error instanceof Error ? error.message : String(error)}`
          );
        })
        .finally(() => {
          state.running.delete(next.id);
          void tick();
        });
    }
  } finally {
    state.ticking = false;
  }
}