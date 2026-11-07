import { absoluteFromData } from '../../core/src/config.ts';
import { decryptJson } from '../../core/src/crypto.ts';
import type { DemoRequest, DemoRow, StepKind, StepRecord } from '../../core/src/types.ts';
import { many } from './dbq.ts';
import { safeJson } from './util.ts';

/**
 * Reading a stored demo back into the shapes the pipeline needs.
 *
 * Kept in its own module so the queue -> pipeline -> demo chain never has to
 * import the public demo service (which imports the queue).
 */

export type StoredDemoOptions = {
  request?: DemoRequest;
  /** AES-256-GCM ciphertext of a per-run test account; never plaintext. */
  credentialsEnc?: string | null;
};

export function loadDemoRequest(demo: DemoRow): {
  request: DemoRequest;
  credentials?: { username: string; password: string };
} {
  const stored = safeJson<StoredDemoOptions>(demo.options_json);
  const request =
    stored?.request ??
    safeJson<DemoRequest>(demo.options_json) ?? {
      instruction: demo.instruction,
      target: { type: demo.target_type, url: demo.target_url }
    };
  let credentials: { username: string; password: string } | undefined;
  if (stored?.credentialsEnc) {
    try {
      credentials = decryptJson<{ username: string; password: string }>(stored.credentialsEnc);
    } catch {
      credentials = undefined;
    }
  }
  return { request, credentials };
}

type StepDbRow = {
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

export function stepDbRows(demoId: string): StepDbRow[] {
  return many<StepDbRow>('SELECT * FROM demo_steps WHERE demo_id = ? ORDER BY idx ASC', demoId);
}

/** demo_steps rows -> StepRecord[], preserving recorded timing and boxes. */
export function stepsFromRows(demoId: string): StepRecord[] {
  return stepDbRows(demoId).map((row) => ({
    index: Number(row.idx),
    kind: row.kind,
    narration: row.narration ?? '',
    startedAtMs: Number(row.started_at_ms),
    endedAtMs: Number(row.ended_at_ms),
    selector: row.selector ?? undefined,
    role: row.role ?? undefined,
    accessibleName: row.name ?? undefined,
    box: safeJson<{ x: number; y: number; width: number; height: number }>(row.box_json) ?? undefined,
    url: row.url ?? undefined,
    screenshotPath: absoluteFromData(row.screenshot_path) ?? undefined
  }));
}