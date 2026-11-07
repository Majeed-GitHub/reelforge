import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDirs } from '../../../core/src/config.ts';
import { ApiError } from '../../../core/src/http.ts';
import { nowIso } from '../../../core/src/ids.ts';
import type { GuideRow } from '../../../core/src/types.ts';
import type { AuthContext } from '../auth.ts';
import { many, one, run } from '../dbq.ts';
import type { GuideReportBody } from '../schemas.ts';
import { notFound, safeJson } from '../util.ts';

export type GuideStep = {
  idx: number;
  selector: string | null;
  role: string | null;
  name: string | null;
  title: string;
  body: string;
  url: string | null;
};

export type GuideView = Omit<GuideRow, 'steps_json'> & {
  steps: GuideStep[];
  stepCount: number;
  environmentName: string | null;
  reportCount: number;
};

const REPORTS_FILE = () => path.join(PATHS.data, 'guide-reports.jsonl');

function toView(row: GuideRow): GuideView {
  const steps = safeJson<GuideStep[]>(row.steps_json) ?? [];
  const env = one<{ name: string }>('SELECT name FROM environments WHERE id = ?', row.environment_id);
  return {
    ...row,
    steps,
    stepCount: steps.length,
    environmentName: env?.name ?? null,
    reportCount: reportCountFor(row.id)
  };
}

function reportCountFor(guideId: string): number {
  try {
    const file = REPORTS_FILE();
    if (!fs.existsSync(file)) return 0;
    let total = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { guideId?: string };
        if (parsed.guideId === guideId) total += 1;
      } catch {
        /* skip malformed line */
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export function listGuides(auth: AuthContext, environmentId?: string): GuideView[] {
  const rows = environmentId
    ? many<GuideRow>(
        'SELECT * FROM guides WHERE workspace_id = ? AND environment_id = ? ORDER BY created_at DESC, rowid DESC',
        auth.workspaceId,
        environmentId
      )
    : many<GuideRow>('SELECT * FROM guides WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC', auth.workspaceId);
  return rows.map(toView);
}

function guideRow(auth: AuthContext, id: string): GuideRow {
  const row = one<GuideRow>('SELECT * FROM guides WHERE id = ? AND workspace_id = ?', id, auth.workspaceId);
  if (!row) throw notFound('guide', id);
  return row;
}

export function getGuide(auth: AuthContext, id: string): GuideView {
  return toView(guideRow(auth, id));
}

export function patchGuide(
  auth: AuthContext,
  id: string,
  body: { name?: string; steps_json?: unknown; status?: 'draft' | 'live' }
): GuideView {
  const current = guideRow(auth, id);
  run(
    'UPDATE guides SET name = ?, steps_json = ?, status = ?, updated_at = ? WHERE id = ?',
    body.name ?? current.name,
    body.steps_json !== undefined ? JSON.stringify(body.steps_json) : current.steps_json,
    body.status ?? current.status,
    nowIso(),
    id
  );
  return getGuide(auth, id);
}

export function publishGuide(auth: AuthContext, id: string): GuideView {
  guideRow(auth, id);
  run("UPDATE guides SET status = 'live', updated_at = ? WHERE id = ?", nowIso(), id);
  return getGuide(auth, id);
}

export function unpublishGuide(auth: AuthContext, id: string): GuideView {
  guideRow(auth, id);
  run("UPDATE guides SET status = 'draft', updated_at = ? WHERE id = ?", nowIso(), id);
  return getGuide(auth, id);
}

/**
 * PUBLIC — this is exactly what the embed widget fetches from a customer's page.
 * The embed key is the credential; it is unguessable and read-only.
 */
export function getGuideByEmbedKey(embedKey: string): {
  id: string;
  name: string;
  environmentId: string;
  status: 'draft' | 'live';
  embedKey: string;
  updatedAt: string;
  steps: GuideStep[];
} {
  const row = one<GuideRow>('SELECT * FROM guides WHERE embed_key = ?', embedKey);
  if (!row) {
    throw new ApiError('NOT_FOUND', 'No guide exists for that embed key.', {
      action: 'check_embed_key',
      hint: 'Copy the embed key from the guide in the Reelforge dashboard.'
    });
  }
  return {
    id: row.id,
    name: row.name,
    environmentId: row.environment_id,
    status: row.status as 'draft' | 'live',
    embedKey: row.embed_key,
    updatedAt: row.updated_at,
    steps: safeJson<GuideStep[]>(row.steps_json) ?? []
  };
}

/**
 * PUBLIC — the widget reports steps a user skipped. There is no table for
 * guide telemetry in the schema, so reports append to a JSONL file under data/
 * (append-only, durable, no schema change, inspectable with any text editor).
 */
export function reportGuideSkip(
  guideId: string,
  body: GuideReportBody
): { ok: true; guideId: string; recordedAt: string; skippedStepCount: number; totalReports: number } {
  const row = one<GuideRow>('SELECT id FROM guides WHERE id = ?', guideId);
  if (!row) {
    throw new ApiError('NOT_FOUND', 'No guide exists for that id.', {
      action: 'check_embed_key',
      hint: 'Report against the guide id the embed endpoint returned.'
    });
  }
  const skippedStepCount = body.skippedStepCount ?? body.skipped_steps ?? 1;
  const recordedAt = nowIso();
  ensureDirs();
  const file = REPORTS_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      at: recordedAt,
      guideId,
      skippedStepCount,
      stepIndex: body.stepIndex ?? body.step_index ?? null,
      reason: body.reason ?? null
    })}\n`,
    'utf8'
  );
  return { ok: true, guideId, recordedAt, skippedStepCount, totalReports: reportCountFor(guideId) };
}