/**
 * Outbound webhooks: "tell my other tools when a demo finishes".
 *
 * Config lives in `workspace_settings` under `webhook.url` / `webhook.secret`
 * (the table is a key/value bag precisely so this needed no migration). The
 * secret is AES-256-GCM encrypted at rest with the same local keyfile that
 * protects stored sign-ins, and is never returned by the API — only `hasSecret`.
 *
 * Delivery rules:
 *   • one POST per event, 5 s hard timeout, one retry with 500 ms backoff;
 *   • `X-Reelforge-Signature: sha256=<hex HMAC-SHA256 of the raw body>` when a
 *     secret is set, so receivers can verify before parsing;
 *   • failures are logged and swallowed — a broken webhook must never fail or
 *     delay the demo that produced it;
 *   • a Slack incoming-webhook URL (`hooks.slack.com`) gets `{ text, blocks }`
 *     instead of the JSON event, so pasting a Slack URL just works.
 *
 * The Fastify plugin lives here too (`webhookRoutes`) so the API surface for a
 * feature ships in the same file as the service that implements it.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PUBLIC_BASE_URL } from '../../../core/src/config.ts';
import { decryptJson, encryptJson } from '../../../core/src/crypto.ts';
import { ApiError, ok } from '../../../core/src/http.ts';
import { nowIso, truncate } from '../../../core/src/ids.ts';
import type { ArticleRow, DemoFailure, DemoRow, GuideRow } from '../../../core/src/types.ts';
import { authOf } from '../auth.ts';
import { one, run } from '../dbq.ts';
import { mediaUrl } from '../signing.ts';
import { parseBody, safeJson } from '../util.ts';

const SETTING_URL = 'webhook.url';
const SETTING_SECRET = 'webhook.secret';
const SETTING_LAST_DELIVERY = 'webhook.lastDelivery';

/** Hard per-attempt timeout (ms) for a webhook POST. */
export const DELIVERY_TIMEOUT_MS = 5000;
/** Backoff before the single retry (ms). */
export const RETRY_BACKOFF_MS = 500;
const MAX_ATTEMPTS = 2;

export type WebhookEvent = 'demo.complete' | 'demo.failed';

export type WebhookConfig = {
  url: string | null;
  secret: string | null;
  updatedAt: string | null;
};

export type LastDelivery = { at: string; ok: boolean; status: number | null };

/** What the API returns: never the secret itself. */
export type WebhookView = {
  url: string | null;
  hasSecret: boolean;
  lastDelivery: LastDelivery | null;
};

export type WebhookDelivery = {
  delivered: boolean;
  status: number | null;
  latencyMs: number;
  attempts: number;
  slack: boolean;
  event: WebhookEvent;
  error?: string;
};

type DemoLike = Pick<
  DemoRow,
  | 'id'
  | 'workspace_id'
  | 'environment_id'
  | 'instruction'
  | 'status'
  | 'duration_ms'
  | 'credits_used'
  | 'video_path'
  | 'poster_path'
  | 'outcome_json'
  | 'failure_json'
>;

export type WebhookPayload = {
  event: WebhookEvent;
  /** ISO-8601, when the event fired. */
  timestamp: string;
  demo: {
    id: string;
    status: string;
    durationMs: number | null;
    creditsUsed: number;
    videoUrl: string | null;
    posterUrl: string | null;
    outcome: Record<string, unknown> | null;
    /** Present on `demo.failed` only. */
    failure?: DemoFailure | null;
  };
  flow?: { id: string; name: string; status: string; signature: string; stepCount: number };
  article?: { id: string; title: string; slug: string; channel: string; status: string; url: string };
  guide?: { id: string; name: string; status: string; embedKey: string; embedUrl: string; stepCount: number };
};

// ---------------------------------------------------------------------------
// Config (workspace_settings)
// ---------------------------------------------------------------------------

function readSetting<T>(workspaceId: string, key: string): { value: T | null; updatedAt: string | null } {
  const row = one<{ value_json: string; updated_at: string }>(
    'SELECT value_json, updated_at FROM workspace_settings WHERE workspace_id = ? AND key = ?',
    workspaceId,
    key
  );
  if (!row) return { value: null, updatedAt: null };
  return { value: safeJson<T>(row.value_json), updatedAt: row.updated_at };
}

function writeSetting(workspaceId: string, key: string, value: unknown): void {
  run(
    `INSERT INTO workspace_settings (workspace_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    workspaceId,
    key,
    JSON.stringify(value),
    nowIso()
  );
}

function deleteSetting(workspaceId: string, key: string): void {
  run('DELETE FROM workspace_settings WHERE workspace_id = ? AND key = ?', workspaceId, key);
}

export function isSlackWebhook(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'hooks.slack.com' || host.endsWith('.slack.com');
  } catch {
    return false;
  }
}

function assertWebhookUrl(raw: string): string {
  const url = String(raw ?? '').trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError('VALIDATION_ERROR', `\`${raw}\` is not an absolute URL.`, {
      action: 'fix_request',
      hint: 'Send an http(s) URL, e.g. https://hooks.slack.com/services/T000/B000/XXXX or http://127.0.0.1:9099/hook'
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError('VALIDATION_ERROR', 'Webhook URLs must be http(s).', {
      action: 'fix_request',
      hint: 'Only http:// and https:// receivers are supported.'
    });
  }
  return url;
}

export function getWebhookConfig(workspaceId: string): WebhookConfig {
  const urlSetting = readSetting<string>(workspaceId, SETTING_URL);
  const secretSetting = readSetting<string>(workspaceId, SETTING_SECRET);
  const url =
    typeof urlSetting.value === 'string' && urlSetting.value.trim() ? urlSetting.value.trim() : null;
  let secret: string | null = null;
  if (typeof secretSetting.value === 'string' && secretSetting.value) {
    try {
      secret = decryptJson<string>(secretSetting.value);
    } catch {
      // A keyfile rotation makes old ciphertext unreadable; treat it as unset.
      secret = null;
    }
  }
  return { url, secret, updatedAt: urlSetting.updatedAt ?? secretSetting.updatedAt };
}

export function readLastDelivery(workspaceId: string): LastDelivery | null {
  const setting = readSetting<LastDelivery>(workspaceId, SETTING_LAST_DELIVERY);
  const value = setting.value;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.at !== 'string') return null;
  return {
    at: value.at,
    ok: value.ok === true,
    status: typeof value.status === 'number' ? value.status : null
  };
}

function writeLastDelivery(workspaceId: string, delivery: WebhookDelivery): void {
  try {
    writeSetting(workspaceId, SETTING_LAST_DELIVERY, {
      at: nowIso(),
      ok: delivery.delivered,
      status: delivery.status
    } satisfies LastDelivery);
  } catch (error) {
    console.error(`[webhook] could not record the last delivery: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function getWebhookView(workspaceId: string): WebhookView {
  const config = getWebhookConfig(workspaceId);
  return {
    url: config.url,
    hasSecret: Boolean(config.secret),
    lastDelivery: readLastDelivery(workspaceId)
  };
}

export function saveWebhookConfig(
  workspaceId: string,
  input: { url: string; secret?: string | null }
): WebhookView {
  const url = assertWebhookUrl(input.url);
  writeSetting(workspaceId, SETTING_URL, url);

  if (input.secret === undefined) {
    // Omitted: keep whatever is stored (allows changing the URL only).
  } else if (input.secret === null || String(input.secret).trim() === '') {
    deleteSetting(workspaceId, SETTING_SECRET);
  } else {
    writeSetting(workspaceId, SETTING_SECRET, encryptJson(String(input.secret).trim()));
  }
  return getWebhookView(workspaceId);
}

export function clearWebhookConfig(workspaceId: string): WebhookView {
  deleteSetting(workspaceId, SETTING_URL);
  deleteSetting(workspaceId, SETTING_SECRET);
  deleteSetting(workspaceId, SETTING_LAST_DELIVERY);
  return getWebhookView(workspaceId);
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/** Absolute link to an article: its published URL, else the dashboard deep link. */
function articleUrl(row: ArticleRow): string {
  const published = (row.published_url ?? '').trim();
  if (/^https?:\/\//i.test(published)) return published;
  return `${PUBLIC_BASE_URL}/app/#/articles/${encodeURIComponent(row.id)}`;
}

function guideStepCount(row: GuideRow): number {
  const steps = safeJson<unknown[]>(row.steps_json);
  return Array.isArray(steps) ? steps.length : 0;
}

/** The event body. `flow`/`article`/`guide` are omitted when the workspace has none. */
export function buildWebhookPayload(demo: DemoLike, event: WebhookEvent): WebhookPayload {
  const payload: WebhookPayload = {
    event,
    timestamp: nowIso(),
    demo: {
      id: demo.id,
      status: demo.status,
      durationMs: demo.duration_ms === null || demo.duration_ms === undefined ? null : Number(demo.duration_ms),
      creditsUsed: Number(demo.credits_used ?? 0),
      videoUrl: mediaUrl(demo.video_path),
      posterUrl: mediaUrl(demo.poster_path),
      outcome: safeJson<Record<string, unknown>>(demo.outcome_json)
    }
  };

  if (event === 'demo.failed') {
    payload.demo.failure = safeJson<DemoFailure>(demo.failure_json);
  }

  if (!demo.environment_id) return payload;

  const flow = one<{ id: string; name: string; status: string; signature: string }>(
    `SELECT id, name, status, signature FROM flows
      WHERE environment_id = ?
      ORDER BY last_verified_at DESC, first_seen_at DESC, rowid DESC
      LIMIT 1`,
    demo.environment_id
  );
  if (flow) {
    payload.flow = {
      id: flow.id,
      name: flow.name,
      status: flow.status,
      signature: flow.signature,
      stepCount: Number(
        one<{ n: number }>('SELECT COUNT(*) AS n FROM flow_steps WHERE flow_id = ?', flow.id)?.n ?? 0
      )
    };
  }

  const article =
    (payload.flow
      ? one<ArticleRow>(
          'SELECT * FROM articles WHERE workspace_id = ? AND flow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
          demo.workspace_id,
          payload.flow.id
        )
      : undefined) ??
    one<ArticleRow>(
      'SELECT * FROM articles WHERE workspace_id = ? AND environment_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      demo.workspace_id,
      demo.environment_id
    );
  if (article) {
    payload.article = {
      id: article.id,
      title: article.title,
      slug: article.slug,
      channel: article.channel,
      status: article.status,
      url: articleUrl(article)
    };
  }

  const guide =
    (payload.flow
      ? one<GuideRow>(
          'SELECT * FROM guides WHERE workspace_id = ? AND flow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
          demo.workspace_id,
          payload.flow.id
        )
      : undefined) ??
    one<GuideRow>(
      'SELECT * FROM guides WHERE workspace_id = ? AND environment_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      demo.workspace_id,
      demo.environment_id
    );
  if (guide) {
    payload.guide = {
      id: guide.id,
      name: guide.name,
      status: guide.status,
      embedKey: guide.embed_key,
      embedUrl: `${PUBLIC_BASE_URL}/api/guides/embed/${encodeURIComponent(guide.embed_key)}`,
      stepCount: guideStepCount(guide)
    };
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Slack rendering
// ---------------------------------------------------------------------------

function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return '—';
  const totalSeconds = durationMs / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${totalSeconds.toFixed(1)}s`;
}

/** Slack incoming webhook body: { text, blocks }. */
export function slackWebhookBody(payload: WebhookPayload, demo: DemoLike): Record<string, unknown> {
  const complete = payload.event === 'demo.complete';
  const goalMet = payload.demo.outcome?.goalMet === true;
  const headline = complete ? (goalMet ? '✅ Reelforge demo is ready' : '🎬 Reelforge demo recorded') : '⚠️ Reelforge demo failed';
  const instruction = truncate(String(demo.instruction || 'Reelforge demo'), 280);

  const summaryLines = [`*${escapeSlack(instruction)}*`];
  if (!complete) {
    const failure = payload.demo.failure;
    summaryLines.push(
      failure
        ? `> ${escapeSlack(truncate(`${failure.code}: ${failure.message}`, 500))}`
        : '> The run did not finish; see the dashboard for details.'
    );
  }

  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: headline } },
    { type: 'section', text: { type: 'mrkdwn', text: summaryLines.join('\n') } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Status*\n${payload.demo.status}` },
        { type: 'mrkdwn', text: `*Duration*\n${formatDuration(payload.demo.durationMs)}` },
        { type: 'mrkdwn', text: `*Credits*\n${payload.demo.creditsUsed}` },
        { type: 'mrkdwn', text: `*Goal met*\n${complete ? (goalMet ? 'yes' : 'no') : '—'}` }
      ]
    }
  ];

  const elements: Record<string, unknown>[] = [];
  if (payload.demo.videoUrl) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: complete ? 'Watch the demo' : 'Open the demo' },
      url: payload.demo.videoUrl
    });
  }
  if (payload.article?.url) {
    elements.push({ type: 'button', text: { type: 'plain_text', text: 'Read the article' }, url: payload.article.url });
  }
  if (elements.length > 0) blocks.push({ type: 'actions', elements });

  return { text: `${headline}: ${instruction}`, blocks };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

type AttemptOutcome = { ok: boolean; status: number | null; latencyMs: number; error?: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `sha256=<hex hmac>` over the exact bytes that go on the wire. */
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

async function postOnce(url: string, body: string, headers: Record<string, string>): Promise<AttemptOutcome> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'user-agent': 'Reelforge-Webhook/0.2',
        ...headers
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
    });
    const latencyMs = Date.now() - started;
    // Drain the body so the socket can be reused / closed; receivers may send HTML.
    try {
      await response.arrayBuffer();
    } catch {
      /* ignore */
    }
    if (response.ok) return { ok: true, status: response.status, latencyMs };
    return { ok: false, status: response.status, latencyMs, error: `HTTP ${response.status}` };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const name = error instanceof Error ? error.name : '';
    const message =
      name === 'TimeoutError' || name === 'AbortError'
        ? `timed out after ${DELIVERY_TIMEOUT_MS} ms`
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, status: null, latencyMs, error: message };
  }
}

async function deliver(
  workspaceId: string,
  url: string,
  body: string,
  headers: Record<string, string>,
  event: WebhookEvent,
  slack: boolean
): Promise<WebhookDelivery> {
  const started = Date.now();
  let attempts = 0;
  let last: AttemptOutcome = { ok: false, status: null, latencyMs: 0, error: 'not attempted' };

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    last = await postOnce(url, body, headers);
    if (last.ok) break;
    if (attempts < MAX_ATTEMPTS) await sleep(RETRY_BACKOFF_MS);
  }

  const delivery: WebhookDelivery = {
    delivered: last.ok,
    status: last.status,
    latencyMs: Date.now() - started,
    attempts,
    slack,
    event
  };
  if (!last.ok) {
    delivery.error = last.error;
    console.error(
      `[webhook] ${event} delivery failed after ${attempts} attempt(s) (${last.error ?? 'unknown error'})`
    );
  } else {
    console.log(`[webhook] ${event} delivered in ${delivery.latencyMs} ms (HTTP ${last.status}, ${attempts} attempt(s))`);
  }
  writeLastDelivery(workspaceId, delivery);
  return delivery;
}

function bodyFor(config: WebhookConfig, payload: WebhookPayload, demo: DemoLike): { body: string; slack: boolean } {
  if (isSlackWebhook(config.url)) {
    return { body: JSON.stringify(slackWebhookBody(payload, demo)), slack: true };
  }
  return { body: JSON.stringify(payload), slack: false };
}

/**
 * Fire the `demo.complete` / `demo.failed` event for a demo row.
 *
 * Never throws: callers are the worker pipeline, where a webhook problem must
 * be invisible. Returns the delivery result (or null when nothing is
 * configured) so `/api/webhooks/test` and scripts can assert on it.
 */
export async function notifyDemoEvent(demoId: string, event: WebhookEvent): Promise<WebhookDelivery | null> {
  try {
    const demo = one<DemoRow>('SELECT * FROM demos WHERE id = ?', demoId);
    if (!demo) return null;
    const config = getWebhookConfig(demo.workspace_id);
    if (!config.url) return null;

    const payload = buildWebhookPayload(demo, event);
    const { body, slack } = bodyFor(config, payload, demo);
    const headers: Record<string, string> = { 'x-reelforge-event': event };
    if (config.secret) headers['x-reelforge-signature'] = signWebhookBody(config.secret, body);

    return await deliver(demo.workspace_id, config.url, body, headers, event, slack);
  } catch (error) {
    console.error(
      `[webhook] ${event} for ${demoId} could not be delivered: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function sampleDemo(workspaceId: string): DemoLike {
  return {
    id: 'dem_sample',
    workspace_id: workspaceId,
    environment_id: null,
    instruction: 'Reelforge webhook test — create a project, invite a teammate, upgrade the plan.',
    status: 'complete',
    duration_ms: 32_549,
    credits_used: 0.542,
    video_path: null,
    poster_path: null,
    outcome_json: JSON.stringify({ goalMet: true, stepsCompleted: 11, whatWasShown: ['Sample step'] }),
    failure_json: null
  };
}

/**
 * `POST /api/webhooks/test`: deliver a real payload through the real path
 * (including signature + retry) against the most recent completed demo, or a
 * sample body when the workspace has no finished demo yet.
 */
export async function deliverTestEvent(workspaceId: string): Promise<WebhookDelivery> {
  const config = getWebhookConfig(workspaceId);
  if (!config.url) {
    throw new ApiError('VALIDATION_ERROR', 'No webhook URL is configured for this workspace.', {
      action: 'set_webhook',
      hint: 'POST /api/webhooks/config { "url": "https://…" } first — a Slack incoming-webhook URL works as-is.'
    });
  }

  const demo =
    one<DemoRow>(
      "SELECT * FROM demos WHERE workspace_id = ? AND status = 'complete' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      workspaceId
    ) ??
    one<DemoRow>(
      'SELECT * FROM demos WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      workspaceId
    ) ??
    sampleDemo(workspaceId);

  const event: WebhookEvent = demo.status === 'failed' ? 'demo.failed' : 'demo.complete';
  const payload = buildWebhookPayload(demo, event);
  const { body, slack } = bodyFor(config, payload, demo);
  const headers: Record<string, string> = { 'x-reelforge-event': event };
  if (config.secret) headers['x-reelforge-signature'] = signWebhookBody(config.secret, body);
  return deliver(workspaceId, config.url as string, body, headers, event, slack);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const webhookConfigSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  secret: z.string().max(500).nullable().optional()
});

/**
 * Webhook routes (wire format frozen with the dashboard, see docs/OUTPUTS.md):
 *
 *   GET    /api/webhooks        -> { url, hasSecret, lastDelivery }
 *   POST   /api/webhooks        -> { url, hasSecret, lastDelivery }   body { url, secret? }
 *   DELETE /api/webhooks        -> { url, hasSecret, lastDelivery }
 *   POST   /api/webhooks/test   -> { delivered, status, latencyMs }
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/webhooks', async (request) => {
    const auth = authOf(request);
    return ok(getWebhookView(auth.workspaceId), 'OK');
  });

  app.post('/api/webhooks', async (request) => {
    const auth = authOf(request);
    const body = parseBody(webhookConfigSchema, request.body ?? {});
    return ok(saveWebhookConfig(auth.workspaceId, body), 'Webhook saved.');
  });

  app.delete('/api/webhooks', async (request) => {
    const auth = authOf(request);
    return ok(clearWebhookConfig(auth.workspaceId), 'Webhook removed.');
  });

  app.post('/api/webhooks/test', async (request) => {
    const auth = authOf(request);
    const delivery = await deliverTestEvent(auth.workspaceId);
    return ok(
      { delivered: delivery.delivered, status: delivery.status, latencyMs: delivery.latencyMs },
      delivery.delivered ? 'Test webhook delivered.' : 'Test webhook failed — check the URL and that the receiver returns 2xx.'
    );
  });
}

export default webhookRoutes;
