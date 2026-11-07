import { PLAN, PUBLIC_BASE_URL } from '../../../core/src/config.ts';
import { remainingSeconds } from '../../../core/src/credits.ts';
import { encryptJson } from '../../../core/src/crypto.ts';
import { ApiError } from '../../../core/src/http.ts';
import { newId, nowIso } from '../../../core/src/ids.ts';
import type {
  DemoFailure,
  DemoOptions,
  DemoQuestion,
  DemoRequest,
  DemoRow,
  DemoStatus,
  StepKind
} from '../../../core/src/types.ts';
import type { AuthContext } from '../auth.ts';
import { many, one, run } from '../dbq.ts';
import { notifyWorker } from '../queue.ts';
import type { DemoCreateBody } from '../schemas.ts';
import { mediaUrl } from '../signing.ts';
import { classifyTarget, isBlockedHost, loopbackBlocked } from '../targets.ts';
import { notFound, safeJson, toJson } from '../util.ts';
import { getEnvironmentRow } from './environments.ts';

export const POLL_AFTER_SECONDS = 3;
const FINISHED: ReadonlySet<DemoStatus> = new Set<DemoStatus>(['complete', 'failed', 'cancelled']);

export type StepView = {
  idx: number;
  kind: StepKind;
  narration: string;
  startedAtMs: number;
  endedAtMs: number;
  selector: string | null;
  role: string | null;
  name: string | null;
  box: { x: number; y: number; width: number; height: number } | null;
  url: string | null;
  screenshotUrl: string | null;
};

export type DemoView = Omit<DemoRow, 'options_json' | 'outcome_json' | 'failure_json' | 'question_json'> & {
  environmentId: string | null;
  targetUrl: string;
  options: DemoOptions;
  videoUrl: string | null;
  posterUrl: string | null;
  srtUrl: string | null;
  transcriptUrl: string;
  outcome: Record<string, unknown> | null;
  failure: DemoFailure | null;
  question: DemoQuestion | null;
  steps: StepView[];
  pollAfterSeconds: number | null;
};

type StoredOptions = {
  request?: DemoRequest;
  credentialsEnc?: string | null;
};

function stepViews(demoId: string): StepView[] {
  const rows = many<{
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
  }>('SELECT * FROM demo_steps WHERE demo_id = ? ORDER BY idx ASC', demoId);
  return rows.map((row) => ({
    idx: Number(row.idx),
    kind: row.kind,
    narration: row.narration ?? '',
    startedAtMs: Number(row.started_at_ms),
    endedAtMs: Number(row.ended_at_ms),
    selector: row.selector,
    role: row.role,
    name: row.name,
    box: safeJson<{ x: number; y: number; width: number; height: number }>(row.box_json),
    url: row.url,
    screenshotUrl: mediaUrl(row.screenshot_path)
  }));
}

export function serializeDemo(row: DemoRow, opts: { steps?: boolean } = {}): DemoView {
  const stored = safeJson<StoredOptions>(row.options_json);
  const request = stored?.request ?? safeJson<DemoRequest>(row.options_json) ?? undefined;
  const finished = FINISHED.has(row.status);
  return {
    ...row,
    environmentId: row.environment_id,
    targetUrl: row.target_url,
    // camelCase aliases are the documented contract; the snake_case columns are
    // passed through by the spread above for anything that wants them raw.
    durationMs: row.duration_ms,
    creditsUsed: row.credits_used,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    options: (request?.options ?? {}) as DemoOptions,
    videoUrl: mediaUrl(row.video_path),
    posterUrl: mediaUrl(row.poster_path),
    srtUrl: mediaUrl(row.srt_path),
    transcriptUrl: `${PUBLIC_BASE_URL}/api/demos/${row.id}/transcript`,
    outcome: safeJson<Record<string, unknown>>(row.outcome_json),
    failure: safeJson<DemoFailure>(row.failure_json),
    question: safeJson<DemoQuestion>(row.question_json),
    steps: opts.steps === false ? [] : stepViews(row.id),
    pollAfterSeconds: finished ? null : POLL_AFTER_SECONDS
  } as DemoView;
}

export function getDemoRow(auth: AuthContext, id: string): DemoRow {
  const row = one<DemoRow>('SELECT * FROM demos WHERE id = ? AND workspace_id = ?', id, auth.workspaceId);
  if (!row) throw notFound('demo', id);
  return row;
}

/** GET /api/demos/:id */
export function getDemo(auth: AuthContext, id: string): DemoView {
  return serializeDemo(getDemoRow(auth, id));
}

export function listDemos(auth: AuthContext, limit = 20): DemoView[] {
  const rows = many<DemoRow>(
    'SELECT * FROM demos WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    auth.workspaceId,
    Math.min(Math.max(limit, 1), 100)
  );
  return rows.map((row) => serializeDemo(row));
}

export function getTranscript(auth: AuthContext, id: string): {
  demoId: string;
  lines: Array<{ stepIndex: number; text: string; startMs: number; durationMs: number }>;
} {
  getDemoRow(auth, id);
  const rows = many<{
    idx: number;
    narration: string;
    started_at_ms: number;
    ended_at_ms: number;
  }>('SELECT idx, narration, started_at_ms, ended_at_ms FROM demo_steps WHERE demo_id = ? ORDER BY idx ASC', id);
  return {
    demoId: id,
    lines: rows
      .filter((row) => (row.narration ?? '').trim().length > 0)
      .map((row) => ({
        stepIndex: Number(row.idx),
        text: row.narration,
        startMs: Number(row.started_at_ms),
        durationMs: Math.max(0, Number(row.ended_at_ms) - Number(row.started_at_ms))
      }))
  };
}

/**
 * Find-or-create an environment for a bare-URL demo, so the Product Graph
 * always has a product to hang a flow on (lead's integration requirement).
 */
function implicitEnvironment(auth: AuthContext, origin: string, host: string): string {
  const baseUrl = `${origin}/`;
  const existing = one<{ id: string }>(
    'SELECT id FROM environments WHERE workspace_id = ? AND (base_url = ? OR base_url = ?) LIMIT 1',
    auth.workspaceId,
    baseUrl,
    origin
  );
  if (existing) return existing.id;
  const id = newId('env');
  const ts = nowIso();
  run(
    `INSERT INTO environments (id, workspace_id, name, base_url, sign_in_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'none', ?, ?)`,
    id,
    auth.workspaceId,
    host,
    baseUrl,
    ts,
    ts
  );
  return id;
}

function assertTargetReachable(rawUrl: string, targetType: 'url' | 'tunnel'): { host: string; url: URL } {
  const classified = classifyTarget(rawUrl);
  if (classified.class === 'invalid') {
    throw new ApiError('VALIDATION_ERROR', `\`${rawUrl}\` is not an absolute http(s) URL.`, {
      action: 'fix_request',
      hint: 'Send target.url like https://app.example.com or http://127.0.0.1:4402/'
    });
  }
  const { host, url } = classified;
  if (isBlockedHost(host)) {
    throw new ApiError('DOMAIN_BLOCKED', `Recording is blocked for ${host}.`, {
      action: 'contact_admin',
      hint: 'REELFORGE_BLOCKED_HOSTS on this instance refuses that host.'
    });
  }
  if (classified.class === 'loopback' && loopbackBlocked()) {
    throw new ApiError(
      'TARGET_UNREACHABLE',
      `${host} only resolves on this machine and loopback recording is disabled on this instance.`,
      {
        action: 'use_tunnel',
        hint: 'Expose the app with a public HTTPS tunnel (e.g. `cloudflared tunnel --url http://127.0.0.1:4402`) and record the tunnel URL.'
      }
    );
  }
  if (classified.class === 'private') {
    throw new ApiError(
      'TARGET_UNREACHABLE',
      `${host} is a private address that a remote recorder cannot reach.`,
      {
        action: 'use_tunnel',
        hint: 'Expose the app with a public HTTPS tunnel and record the tunnel URL.'
      }
    );
  }
  if (targetType === 'tunnel' && url!.protocol !== 'https:') {
    throw new ApiError('TARGET_UNREACHABLE', 'A tunnel target must be a public HTTPS URL.', {
      action: 'use_tunnel',
      hint: 'Tunnels are served over https:// only.'
    });
  }
  return { host, url: url! };
}

function attestHost(auth: AuthContext, host: string): void {
  const existing = one<{ id: string; attested_at: string | null }>(
    'SELECT id, attested_at FROM domains WHERE workspace_id = ? AND host = ?',
    auth.workspaceId,
    host
  );
  const ts = nowIso();
  if (existing) {
    run('UPDATE domains SET attested_at = ? WHERE id = ?', ts, existing.id);
    return;
  }
  run(
    'INSERT INTO domains (id, workspace_id, host, attested_at, verification_token, verified_at) VALUES (?, ?, ?, ?, ?, NULL)',
    newId('dom'),
    auth.workspaceId,
    host,
    ts,
    newId('vf').slice(3)
  );
}

/** Credit guard + concurrency gate. Both are Director-documented envelopes. */
function enforcePlan(auth: AuthContext, targetType: 'url' | 'tunnel'): void {
  if (PLAN.enforceCredits) {
    const used = one<{ total: number | null }>(
      'SELECT SUM(delta_seconds) AS total FROM credit_ledger WHERE workspace_id = ?',
      auth.workspaceId
    );
    const left = remainingSeconds(Number(used?.total ?? 0));
    if (left <= 0) {
      throw new ApiError('INSUFFICIENT_CREDITS', 'This workspace is out of credits.', {
        action: 'upgrade_plan',
        hint: `${PLAN.freeMinutesPerMonth} free minutes are included per month; upgrade to keep recording.`
      });
    }
  }

  const active = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM demos WHERE workspace_id = ? AND status IN ('queued','running')",
    auth.workspaceId
  );
  if (Number(active?.n ?? 0) >= PLAN.concurrency) {
    throw new ApiError('CONCURRENCY_LIMIT_REACHED', `This workspace already has ${PLAN.concurrency} demo(s) queued or running.`, {
      action: 'wait',
      hint: `Wait for a run to finish (poll GET /api/demos/:id) — the plan allows ${PLAN.concurrency} concurrent runs.`
    });
  }

  if (targetType === 'tunnel') {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const tunnels = one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM demos WHERE workspace_id = ? AND target_type = 'tunnel' AND created_at >= ?",
      auth.workspaceId,
      today.toISOString()
    );
    if (Number(tunnels?.n ?? 0) >= PLAN.tunnelDemosPerDay) {
      throw new ApiError('CONCURRENCY_LIMIT_REACHED', `The daily tunnel-demo allowance (${PLAN.tunnelDemosPerDay}) is used up.`, {
        action: 'wait_for_reset',
        hint: 'Tunnel demos reset at 00:00 UTC.'
      });
    }
  }
}

/** POST /api/demos */
export function createDemo(auth: AuthContext, body: DemoCreateBody): {
  id: string;
  status: DemoStatus;
  pollAfterSeconds: number;
  environmentId: string;
} {
  let environmentId: string | null = null;
  let targetType: 'url' | 'tunnel' = body.target?.type ?? 'url';
  let targetUrl: string;

  if (body.environmentId) {
    const env = getEnvironmentRow(auth, body.environmentId);
    environmentId = env.id;
    if (body.target?.url) {
      targetType = body.target.type;
      targetUrl = body.target.url;
    } else {
      targetUrl = joinUrl(env.base_url, body.path ?? '/');
    }
  } else {
    targetUrl = body.target!.url;
    targetType = body.target!.type;
  }

  const resolved = assertTargetReachable(targetUrl, targetType);
  const host = resolved.host;
  const absoluteUrl = resolved.url.toString();

  // First use of a host must be attested, except loopback (local recorder).
  const isLoopback = classifyTarget(absoluteUrl).class === 'loopback';
  if (!isLoopback) {
    const domain = one<{ attested_at: string | null }>(
      'SELECT attested_at FROM domains WHERE workspace_id = ? AND host = ?',
      auth.workspaceId,
      host
    );
    const attested = Boolean(domain?.attested_at);
    if (!attested) {
      if (body.authorized === true) {
        attestHost(auth, host);
      } else {
        throw new ApiError(
          'DOMAIN_AUTHORIZATION_REQUIRED',
          `You must confirm once that you may record ${host}.`,
          {
            action: 'attest_domain',
            hint: `Re-send the request with "authorized": true, or POST /api/domains/attest { "host": "${host}", "authorized": true }.`
          }
        );
      }
    }
  }

  enforcePlan(auth, targetType);

  if (!environmentId) {
    environmentId = implicitEnvironment(auth, resolved.url!.origin, host);
  }

  const request: DemoRequest = {
    instruction: body.instruction,
    target: { type: targetType, url: absoluteUrl },
    environmentId,
    path: body.path,
    authorized: body.authorized,
    confirmDestructive: body.confirmDestructive,
    options: body.options as DemoOptions | undefined
  };

  const stored: StoredOptions = { request };
  if (body.credentials) {
    // Never persist a test account in plaintext: options_json carries ciphertext.
    stored.credentialsEnc = encryptJson(body.credentials);
  }

  const id = newId('dem');
  run(
    `INSERT INTO demos (
       id, workspace_id, environment_id, instruction, target_type, target_url,
       status, progress, options_json, created_at, credits_used
     ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, 0)`,
    id,
    auth.workspaceId,
    environmentId,
    body.instruction,
    targetType,
    absoluteUrl,
    toJson(stored),
    nowIso()
  );

  notifyWorker();
  return { id, status: 'queued', pollAfterSeconds: POLL_AFTER_SECONDS, environmentId };
}

export function joinUrl(baseUrl: string, pathPart: string): string {
  try {
    const base = new URL(baseUrl);
    return new URL(pathPart, base.origin + (base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`)).toString();
  } catch {
    return baseUrl;
  }
}

/** POST /api/demos/:id/question/answer */
export function answerQuestion(auth: AuthContext, id: string, optionId: string): {
  ok: true;
  demoId: string;
  optionId: string;
  answeredAt: string;
} {
  const demo = getDemoRow(auth, id);
  const question = safeJson<DemoQuestion>(demo.question_json);
  if (!question) {
    throw new ApiError('VALIDATION_ERROR', 'This demo is not waiting on a question.', {
      action: 'get_demo_status',
      hint: 'Question prompts appear during a run; poll GET /api/demos/:id.'
    });
  }
  const option = question.options?.find((candidate) => candidate.id === optionId);
  if (!option) {
    throw new ApiError('VALIDATION_ERROR', `\`${optionId}\` is not one of this question's options.`, {
      action: 'fix_request',
      hint: `Valid options: ${question.options.map((candidate) => candidate.id).join(', ')}`
    });
  }
  const ts = nowIso();
  run('UPDATE demos SET answer_json = ? WHERE id = ?', toJson({ optionId, answeredAt: ts }), id);
  run(
    `INSERT INTO questions_answers (demo_id, option_id, answered_at) VALUES (?, ?, ?)
     ON CONFLICT(demo_id) DO UPDATE SET option_id = excluded.option_id, answered_at = excluded.answered_at`,
    id,
    optionId,
    ts
  );
  return { ok: true, demoId: id, optionId, answeredAt: ts };
}

/** POST /api/demos/:id/cancel */
export async function cancelDemo(auth: AuthContext, id: string): Promise<{
  id: string;
  status: DemoStatus;
  cancelled: boolean;
}> {
  const demo = getDemoRow(auth, id);
  if (demo.status === 'cancelled') return { id, status: 'cancelled', cancelled: true };
  if (FINISHED.has(demo.status)) {
    throw new ApiError('VALIDATION_ERROR', `Demo ${id} already finished as \`${demo.status}\`.`, {
      action: 'get_demo_status',
      hint: 'Only queued or running demos can be cancelled.'
    });
  }
  const ts = nowIso();
  const changed = run(
    "UPDATE demos SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued','running')",
    ts,
    id
  );
  const { abortDemo } = await import('../queue.ts');
  abortDemo(id);
  const after = getDemoRow(auth, id);
  return { id, status: after.status, cancelled: changed > 0 || after.status === 'cancelled' };
}

/** MCP `wait_for_demo` — bounded blocking poll. */
export async function waitForDemo(
  auth: AuthContext,
  id: string,
  timeoutMs = 180_000
): Promise<DemoView> {
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 180_000);
  for (;;) {
    const row = getDemoRow(auth, id);
    if (FINISHED.has(row.status)) return serializeDemo(row);
    if (Date.now() >= deadline) return serializeDemo(row);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

/** Used by the worker: rebuild the original DemoRequest (credentials decrypted). */
export { loadDemoRequest, stepsFromRows } from '../demoio.ts';

export function setQuestion(demoId: string, question: DemoQuestion): void {
  run('UPDATE demos SET question_json = ? WHERE id = ?', toJson(question), demoId);
}

export function readAnswer(demoId: string): string | null {
  const row = one<{ option_id: string }>('SELECT option_id FROM questions_answers WHERE demo_id = ?', demoId);
  return row?.option_id ?? null;
}