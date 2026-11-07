import { PLAN, PATHS } from '../../../core/src/config.ts';
import { getDb } from '../../../core/src/db.ts';
import { activeRuns, startWorker, stopWorker, workerCapacity } from '../queue.ts';

/**
 * Standalone worker entry point.
 *
 *   node --env-file-if-exists=.env packages/api/src/worker/main.ts
 *
 * Use this when you want the API and the recorder in separate processes.
 * With the default `node packages/api/src/server.ts`, the API starts this same
 * queue in-process — run one or the other, not both (they share data/reelforge.db,
 * so the atomic claim keeps them safe, but two workers is just extra load).
 */

const db = getDb();
const queued = db.prepare("SELECT COUNT(*) AS n FROM demos WHERE status = 'queued'").get() as { n: number };

console.log(`[worker] Reelforge queue starting — concurrency ${workerCapacity()} (REELFORGE_CONCURRENCY)`);
console.log(`[worker] data dir: ${PATHS.data}`);
console.log(`[worker] queued demos at boot: ${Number(queued?.n ?? 0)}`);

startWorker({ intervalMs: 500 });

const heartbeat = setInterval(() => {
  const active = activeRuns();
  if (active.length > 0) {
    console.log(`[worker] ${active.length}/${PLAN.concurrency} running: ${active.map((run) => run.demoId).join(', ')}`);
  }
}, 30_000);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} received — draining ${activeRuns().length} running demo(s)`);
  clearInterval(heartbeat);
  await stopWorker();
  db.close();
  console.log('[worker] stopped');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));