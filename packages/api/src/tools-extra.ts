import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { remainingSeconds } from '../../core/src/credits.ts';
import type { DemoOptions } from '../../core/src/types.ts';
import type { AuthContext } from './auth.ts';
import { many, one } from './dbq.ts';
import { activeRuns, isWorkerRunning, workerCapacity } from './queue.ts';
import { FEATURES, SERVICE, VERSION } from './routes/health.ts';
import { shareLinkFor } from './routes/share.ts';
import type { DemoCreateBody } from './schemas.ts';
import { unpublishArticle } from './services/articles.ts';
import { createDemo, getDemo, getTranscript, listDemos } from './services/demos.ts';
import { createLoginCode } from './services/environments.ts';
import { getGuide, listGuides, publishGuide, unpublishGuide } from './services/guides.ts';
import { getDefaultPreset } from './services/presets.ts';
import { providerStatus } from './services/providers.ts';
import { getWorkspace } from './services/workspace.ts';
import { mediaUrl } from './signing.ts';

/**
 * MCP tools beyond Director's published list: guides, login codes, health and
 * usage telemetry, demo outputs and batch recording.
 *
 * Every tool calls the *same* service function the REST route calls, except the
 * two telemetry tools (`get_usage`, `list_outputs`) which read tables that only
 * exist as API-surface concerns (credit ledger month window, demo_exports job
 * rows). Registered through the same helper as everything else so descriptions,
 * error envelopes and snake_case args stay uniform.
 */

export type RegisterTool = (
  server: McpServer,
  name: string,
  description: string,
  shape: Record<string, z.ZodTypeAny>,
  execute: (args: Record<string, any>) => Promise<unknown> | unknown
) => void;

/**
 * MCP args (snake_case) -> the REST `DemoCreateBody` shape (camelCase).
 *
 * Shared with `create_demo` in mcp.ts so the single and batch paths can never
 * drift apart.
 */
export function demoCreateBody(args: Record<string, any>): DemoCreateBody {
  const options: Record<string, unknown> = {};
  if (args.language !== undefined) options.language = args.language;
  if (args.fps !== undefined) options.fps = args.fps;
  if (args.max_steps !== undefined) options.maxSteps = args.max_steps;
  if (args.watermark !== undefined) options.watermark = args.watermark;
  if (args.zoom !== undefined) options.zoom = args.zoom;
  if (args.voice !== undefined) options.voice = args.voice;
  return {
    instruction: args.instruction,
    target: args.target_url ? { type: args.target_type ?? 'url', url: args.target_url } : undefined,
    environmentId: args.environment_id,
    path: args.path,
    authorized: args.authorized,
    confirmDestructive: args.confirm_destructive,
    options: Object.keys(options).length > 0 ? (options as DemoOptions) : undefined
  } as DemoCreateBody;
}

/** Same `{code,message,remediation}` shape as the tool error result, for batch items. */
function failureOf(error: unknown): { code: string; message: string; remediation?: unknown } {
  const candidate = error as { code?: unknown; message?: unknown; remediation?: unknown };
  if (error && typeof error === 'object' && typeof candidate.code === 'string') {
    return {
      code: candidate.code,
      message: typeof candidate.message === 'string' ? candidate.message : String(candidate.message ?? ''),
      remediation: candidate.remediation
    };
  }
  return { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(n, min), max);
}

/** "m:ss.d" for transcript headings. */
function clock(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

type ExportRow = {
  id: string;
  demo_id: string;
  kind: string;
  status: string;
  path: string | null;
  size_bytes: number | null;
  error: string | null;
  created_at: string;
};

/**
 * Export jobs are created lazily by routes/exports.ts. If that module has not
 * been loaded (API not booted through server.ts) the table is absent; a tool
 * call must not fail because of that, so treat it as "no exports yet".
 */
function exportsFor(demoId: string): Array<{
  id: string;
  kind: string;
  status: string;
  url: string | null;
  bytes: number | null;
  error: string | null;
}> {
  try {
    return many<ExportRow>(
      'SELECT * FROM demo_exports WHERE demo_id = ? ORDER BY created_at DESC, rowid DESC',
      demoId
    ).map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      url: mediaUrl(row.path),
      bytes: row.size_bytes === null ? null : Number(row.size_bytes),
      error: row.error
    }));
  } catch {
    return [];
  }
}

export function attachExtraTools(server: McpServer, auth: AuthContext, register: RegisterTool): void {
  // ---------------------------------------------------------------- guides --
  register(
    server,
    'list_guides',
    'List in-app guides (draft or live) for this workspace, newest first, with embed keys and step counts. Use when you need a guide id/embed key before get_guide, publish_guide or unpublish_guide. Args: environment_id optional (filter to one saved product). Returns: array of guides.',
    { environment_id: z.string().optional().describe('Only guides for this saved product (environment) id.') },
    async (args) => listGuides(auth, args.environment_id)
  );

  register(
    server,
    'get_guide',
    'Fetch one in-app guide with its ordered steps, status, embed key and report count. Use when you need the exact steps a live guide walks through. Required: guide_id. Returns: the guide plus { steps, stepCount, environmentName, reportCount }.',
    { guide_id: z.string().describe('Guide id from list_guides, e.g. gd_…') },
    async (args) => getGuide(auth, args.guide_id)
  );

  register(
    server,
    'publish_guide',
    'Make a draft in-app guide live so its embed key starts rendering on customer pages. Use when a guide reviewed in draft is ready for production. Required: guide_id. Returns: the guide with status "live" and its embed key; unpublish_guide reverses it.',
    { guide_id: z.string().describe('Guide id from list_guides.') },
    async (args) => publishGuide(auth, args.guide_id)
  );

  register(
    server,
    'unpublish_guide',
    'Move a live in-app guide back to draft so it stops rendering on customer pages. Use when a guide is wrong, stale or being rewritten. Required: guide_id. Returns: the guide with status "draft".',
    { guide_id: z.string().describe('Guide id from list_guides.') },
    async (args) => unpublishGuide(auth, args.guide_id)
  );

  // ----------------------------------------------------------- login codes --
  register(
    server,
    'create_login_code',
    'Mint a single-use DIR-XXXX-XXXX-XXXX login code (30 minutes) that `reelforge session` redeems to capture a signed-in browser session for an environment. Use when a product needs SSO/2FA and cannot take a password. Required: environment_id. Returns: { code, expiresAt }; the operator runs `reelforge session <code>`.',
    { environment_id: z.string().describe('Saved product (environment) id to capture a session for.') },
    async (args) => createLoginCode(auth, args.environment_id)
  );

  register(server, 'get_default_preset', 'Return the workspace default recording preset (fps, scaleHeight, zoom, language, voice, maxSteps, watermark, headless). Use when you need the defaults a recording will use without passing options. Args: none. Returns: the default preset or null.', {}, async () =>
    getDefaultPreset(auth)
  );

  // --------------------------------------------------------- health / usage --
  register(
    server,
    'health',
    'Report API version/features, worker state and the active LLM + TTS providers for this instance. Use first in a session to confirm the API is reachable, the recorder is running and narration will work offline or needs a provider key. Args: none. Returns: { service, version, features, worker, queue, providers: { llm, tts } }.',
    {},
    async () => {
      const providers = providerStatus(auth);
      const counts = one<{ queued: number | null; running: number | null }>(
        `SELECT SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
                SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
           FROM demos WHERE workspace_id = ?`,
        auth.workspaceId
      );
      return {
        service: SERVICE,
        version: VERSION,
        features: [...FEATURES],
        worker: {
          running: isWorkerRunning(),
          concurrency: workerCapacity(),
          active: activeRuns()
        },
        queue: {
          queued: Number(counts?.queued ?? 0),
          running: Number(counts?.running ?? 0)
        },
        providers: {
          llm: {
            providerId: providers.llm.active.providerId,
            model: providers.llm.active.model,
            source: providers.llm.active.source,
            configured: providers.llm.providers.filter((provider) => provider.configured).map((provider) => provider.id)
          },
          tts: {
            providerId: providers.tts.active.providerId,
            voice: providers.tts.active.voice,
            source: providers.tts.active.source,
            offline: providers.tts.providers.filter((provider) => provider.offline).map((provider) => provider.id)
          }
        }
      };
    }
  );

  register(
    server,
    'get_usage',
    'Return billed credits for the current UTC calendar month, plus plan limits and remaining free seconds. Use before starting a large or batch recording to check headroom. Args: none (scoped to the API key workspace). Returns: { period, creditsUsed, secondsUsed, secondsRemaining, demosThisMonth, limits, lifetime }.',
    {},
    async () => {
      const start = new Date();
      start.setUTCDate(1);
      start.setUTCHours(0, 0, 0, 0);
      const startIso = start.toISOString();
      const endIso = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)).toISOString();
      const secondsUsed = Number(
        one<{ total: number | null }>(
          'SELECT SUM(delta_seconds) AS total FROM credit_ledger WHERE workspace_id = ? AND created_at >= ?',
          auth.workspaceId,
          startIso
        )?.total ?? 0
      );
      const demosThisMonth = Number(
        one<{ n: number }>('SELECT COUNT(*) AS n FROM demos WHERE workspace_id = ? AND created_at >= ?', auth.workspaceId, startIso)
          ?.n ?? 0
      );
      const workspace = getWorkspace(auth);
      const round3 = (n: number) => Math.round(n * 1000) / 1000;
      return {
        period: { start: startIso, end: endIso, timezone: 'UTC' },
        creditsUsed: round3(secondsUsed / 60),
        secondsUsed: round3(secondsUsed),
        freeMinutesPerMonth: workspace.limits.freeMinutesPerMonth,
        secondsRemaining: remainingSeconds(secondsUsed, workspace.limits.freeMinutesPerMonth),
        enforceCredits: workspace.limits.enforceCredits,
        demosThisMonth,
        limits: workspace.limits,
        lifetime: workspace.usage
      };
    }
  );

  // -------------------------------------------------------- demo artifacts --
  register(
    server,
    'get_demo_video',
    'Return the finished video for a demo: signed MP4/poster/SRT URLs, duration, billed credits and a share-ready flag. Use after get_demo_status reports "complete" (or wait_for_demo returns) when you need the media links, not the step detail. Required: demo_id. Returns: { ready, videoUrl, posterUrl, srtUrl, durationMs, creditsUsed, expiresInSeconds }. Signed URLs expire after 1 hour — re-call for fresh links.',
    { demo_id: z.string().describe('Demo id from create_demo/list_demos, e.g. dem_…') },
    async (args) => {
      const demo = getDemo(auth, args.demo_id);
      const ready = demo.status === 'complete' && Boolean(demo.videoUrl);
      return {
        demoId: demo.id,
        instruction: demo.instruction,
        status: demo.status,
        ready,
        videoUrl: demo.videoUrl,
        posterUrl: demo.posterUrl,
        srtUrl: demo.srtUrl,
        durationMs: demo.duration_ms,
        durationSeconds: demo.duration_ms === null ? null : Math.round(demo.duration_ms / 100) / 10,
        creditsUsed: demo.credits_used,
        expiresInSeconds: demo.videoUrl ? 3600 : null,
        pollAfterSeconds: demo.pollAfterSeconds,
        note: ready
          ? 'Signed media URLs expire after one hour; call get_demo_video again for fresh links.'
          : `Demo is ${demo.status}; an MP4 exists only once status is "complete". Poll get_demo_status and retry.`
      };
    }
  );

  register(
    server,
    'get_transcript_markdown',
    'Return a demo\'s narration as ready-to-paste Markdown (headings, timestamps, one bullet per spoken line), plus the video link. Use when you need captions for a blog/help-doc draft or to check what was actually narrated. Required: demo_id. Returns: { demoId, lineCount, markdown, videoUrl }. An empty transcript means the run produced no narration.',
    { demo_id: z.string().describe('Demo id from create_demo/list_demos.') },
    async (args) => {
      const demo = getDemo(auth, args.demo_id);
      const transcript = getTranscript(auth, args.demo_id);
      const header = [
        `# ${demo.instruction}`,
        '',
        `- **Demo:** ${demo.id}`,
        `- **Status:** ${demo.status}`,
        demo.duration_ms === null ? '' : `- **Duration:** ${clock(demo.duration_ms)}`,
        demo.videoUrl ? `- **Video:** ${demo.videoUrl}` : '',
        ''
      ].filter((line) => line !== '');
      const bullets = transcript.lines.map((line) => `- \`${clock(line.startMs)}\` ${line.text}`);
      const markdown =
        transcript.lines.length > 0
          ? `${header.join('\n')}\n${bullets.join('\n')}\n`
          : `${header.join('\n')}\n_No narration lines were recorded for this demo._\n`;
      return {
        demoId: demo.id,
        instruction: demo.instruction,
        lineCount: transcript.lines.length,
        markdown,
        videoUrl: demo.videoUrl
      };
    }
  );

  register(
    server,
    'list_outputs',
    'List every finished artifact this workspace owns: MP4/poster/caption links per complete demo plus any GIF/VTT exports. Use when asked "what have we produced?" or to find a demo video that already exists before re-recording. Args: limit optional (1–100, default 20), demo_id optional (one demo only, including unfinished). Returns: { outputs: [ { demoId, instruction, videoUrl, posterUrl, srtUrl, transcriptUrl, exports } ], total }.',
    {
      limit: z.number().int().min(1).max(100).optional().describe('Max demos to include, newest first. Default 20.'),
      demo_id: z
        .string()
        .optional()
        .describe('Restrict output to one demo id (useful to inspect a specific run, finished or not).')
    },
    async (args) => {
      const demos = args.demo_id
        ? [getDemo(auth, args.demo_id)]
        : listDemos(auth, clampInt(args.limit, 20, 1, 100)).filter((demo) => demo.status === 'complete');
      const outputs = demos.map((demo) => ({
        demoId: demo.id,
        instruction: demo.instruction,
        environmentId: demo.environmentId,
        status: demo.status,
        completedAt: demo.finished_at ?? null,
        videoUrl: demo.videoUrl,
        posterUrl: demo.posterUrl,
        srtUrl: demo.srtUrl,
        transcriptUrl: demo.transcriptUrl,
        durationMs: demo.duration_ms,
        creditsUsed: demo.credits_used,
        exports: exportsFor(demo.id)
      }));
      return { total: outputs.length, outputs };
    }
  );

  // -------------------------------------------------------------- sharing --
  register(
    server,
    'share_demo_link',
    'Create a public 30-day share link for a demo that plays the video with no API key. Use when the user wants to send the demo to someone outside the workspace (Slack, email, docs). Required: demo_id. Returns: { demoId, url, expiresAt }; the page re-signs media URLs on each load, so the link keeps working until it expires.',
    { demo_id: z.string().describe('Demo id from create_demo/list_demos.') },
    async (args) => {
      const demo = getDemo(auth, args.demo_id);
      const link = shareLinkFor(demo.id);
      return {
        demoId: demo.id,
        instruction: demo.instruction,
        status: demo.status,
        url: link.url,
        expiresAt: link.expiresAt,
        ttlDays: 30,
        note: 'Public page — no API key required. Media links inside it are re-signed per load.'
      };
    }
  );

  // --------------------------------------------------------------- batches --
  register(
    server,
    'batch_create_demos',
    'Queue up to 10 narrated demos in one call, each with its own instruction and target. Use for multi-page or multi-feature recording runs where one call per demo would be tedious. Required: requests (non-empty array; each item needs instruction plus target_url or environment_id, same fields as create_demo). Returns: { requested, created, failed, results[] } where each result has { ok, id?, status?, error? }. Item errors are the normal { code, message, remediation } and do not abort the rest of the batch.',
    {
      requests: z
        .array(
          z.object({
            instruction: z.string().min(3).max(2000).describe('What this demo should show.'),
            target_url: z.string().optional().describe('Where to record, e.g. https://app.example.com'),
            target_type: z.enum(['url', 'tunnel']).optional(),
            environment_id: z.string().optional().describe('Saved product to record inside.'),
            path: z.string().optional(),
            authorized: z.boolean().optional().describe('Confirm once per new domain.'),
            confirm_destructive: z.boolean().optional(),
            language: z.string().optional(),
            fps: z.number().int().min(1).max(60).optional(),
            max_steps: z.number().int().min(1).max(60).optional(),
            watermark: z.boolean().optional(),
            zoom: z.number().min(1).max(2.5).optional(),
            voice: z.string().optional()
          })
        )
        .min(1)
        .max(10)
        .describe('1–10 demo requests. Each is the same shape as create_demo args.')
    },
    async (args) => {
      const requests = (args.requests ?? []) as Array<Record<string, any>>;
      const results: Array<Record<string, unknown>> = [];
      for (const request of requests) {
        try {
          const created = createDemo(auth, demoCreateBody(request));
          results.push({ ok: true, instruction: request.instruction, ...created });
        } catch (error) {
          results.push({ ok: false, instruction: request.instruction, error: failureOf(error) });
        }
      }
      return {
        requested: requests.length,
        created: results.filter((result) => result.ok === true).length,
        failed: results.filter((result) => result.ok !== true).length,
        results
      };
    }
  );

  // --------------------------------------------------------------- article --
  register(
    server,
    'unpublish_article',
    'Move a published help-centre/internal-training article back to draft and clear its public URL. Use when a published article is outdated or wrong. Required: article_id. Returns: the article with status "draft"; publish_article re-publishes it.',
    { article_id: z.string().describe('Article id from list_articles.') },
    async (args) => unpublishArticle(auth, args.article_id)
  );
}
