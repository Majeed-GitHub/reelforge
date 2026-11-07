import fs from 'node:fs';
import path from 'node:path';
import { PATHS, absoluteFromData, ensureDirs, relativeToData } from '../../../core/src/config.ts';
import { billableSeconds, creditsForDuration } from '../../../core/src/credits.ts';
import { ApiError } from '../../../core/src/http.ts';
import { nowIso } from '../../../core/src/ids.ts';
import { stepLabel } from '../../../core/src/flow.ts';
import type {
  CaptureResult,
  DemoFailure,
  DemoOutcome,
  DemoRequest,
  DemoRow,
  EnvironmentRow,
  RenderInput,
  RenderOptions,
  RenderResult,
  StepRecord
} from '../../../core/src/types.ts';
import { one, run, many } from '../dbq.ts';
import { loadDemoRequest } from '../demoio.ts';
import { upsertProductGraph } from '../graph.ts';
import { loadSignIn } from '../services/environments.ts';
import { notifyDemoEvent } from '../services/webhooks.ts';
import { safeJson } from '../util.ts';

/**
 * The job pipeline: one queued demo -> browser capture -> render -> graph.
 *
 * packages/agent and packages/render are built in parallel, so both are
 * imported lazily by file URL (never at module load). The server and every
 * non-execution route boot and work without them; a demo that cannot run fails
 * with a precise, actionable failure envelope instead of crashing the process.
 */

const AGENT_ENTRY = new URL('../../../agent/src/index.ts', import.meta.url).href;
const RENDER_ENTRY = new URL('../../../render/src/index.ts', import.meta.url).href;

/**
 * packages/agent's real contract is `runCapture({ id, request, environment,
 * onLog })` — no AbortSignal, so cancellation is cooperative via the demo row's
 * status and checked between phases. This wrapper is the only place that knows
 * that shape (it is the thin adapter the brief asked for).
 */
type AgentModule = {
  runCapture: (input: {
    id?: string;
    request: DemoRequest;
    environment?: { id?: string; baseUrl: string; storageState?: unknown };
    onLog?: (line: string) => void;
  }) => Promise<CaptureResult>;
};

type RenderModule = {
  renderDemo: (input: RenderInput) => Promise<RenderResult>;
};

function setProgress(demoId: string, progress: number): void {
  run("UPDATE demos SET progress = ? WHERE id = ? AND status = 'running'", Math.max(0, Math.min(1, progress)), demoId);
}

function stillRunning(demoId: string): boolean {
  const row = one<{ status: string }>('SELECT status FROM demos WHERE id = ?', demoId);
  return row?.status === 'running';
}

function failDemo(demoId: string, failure: DemoFailure): void {
  const changed = run(
    "UPDATE demos SET status = 'failed', failure_json = ?, progress = 1, finished_at = ? WHERE id = ? AND status = 'running'",
    JSON.stringify(failure),
    nowIso(),
    demoId
  );
  // Notify out-of-process consumers; fire-and-forget so a dead webhook can
  // never fail (or delay) the demo itself. Covers every failure path below.
  if (changed > 0) void notifyDemoEvent(demoId, 'demo.failed');
}

function cancelled(demoId: string): void {
  run(
    "UPDATE demos SET status = 'cancelled', progress = 1, finished_at = ? WHERE id = ? AND status = 'running'",
    nowIso(),
    demoId
  );
}

function persistSteps(demoId: string, steps: StepRecord[]): void {
  run('DELETE FROM demo_steps WHERE demo_id = ?', demoId);
  for (const step of steps) {
    run(
      `INSERT INTO demo_steps (demo_id, idx, kind, narration, started_at_ms, ended_at_ms, selector, role, name, box_json, url, screenshot_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      demoId,
      step.index,
      step.kind,
      step.narration ?? '',
      Math.round(Number(step.startedAtMs) || 0),
      Math.round(Number(step.endedAtMs) || 0),
      step.selector ?? null,
      step.role ?? null,
      step.accessibleName ?? null,
      step.box ? JSON.stringify(step.box) : null,
      step.url ?? null,
      relativeToData(step.screenshotPath) ?? null
    );
  }
}

function authoredOutcome(capture: CaptureResult): DemoOutcome {
  const performed = capture.steps.filter((step) => step.kind !== 'done');
  return {
    goalMet: Boolean(capture.goalMet),
    stepsCompleted: performed.length,
    whatWasShown: performed.map((step) => step.narration || stepLabel(step)).slice(0, 12),
    stoppedBefore: capture.stoppedBefore
  };
}

function resolveRenderOptions(demo: DemoRow, capture: CaptureResult): RenderOptions {
  const { request } = loadDemoRequest(demo);
  const preset = request.options?.presetId
    ? one<{ config_json: string }>('SELECT config_json FROM presets WHERE id = ?', request.options.presetId)
    : undefined;
  const presetConfig = safeJson<Record<string, unknown>>(preset?.config_json) ?? {};
  const options = (request.options ?? {}) as Record<string, unknown>;
  const pickNumber = (current: unknown, fallback: unknown, min: number, max: number, dflt: number): number => {
    const value = typeof current === 'number' ? current : typeof fallback === 'number' ? fallback : dflt;
    return Math.min(Math.max(value, min), max);
  };
  const zoomRaw = typeof options.zoom === 'number' ? options.zoom : presetConfig.zoom;
  return {
    fps: pickNumber(options.fps, presetConfig.fps, 1, 60, 30),
    scaleHeight: pickNumber(options.scaleHeight, presetConfig.scaleHeight, 120, 2160, capture.viewport?.height ?? 720),
    watermark: typeof options.watermark === 'boolean' ? options.watermark : presetConfig.watermark !== false,
    language: (typeof options.language === 'string' ? options.language : (presetConfig.language as string)) || 'en',
    voice: typeof options.voice === 'string' ? options.voice : (presetConfig.voice as string | undefined),
    watermarkText: 'Reelforge',
    zoom: Math.min(Math.max(typeof zoomRaw === 'number' ? zoomRaw : 1.6, 1), 2.5)
  };
}

function failureFromError(error: unknown): DemoFailure {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message, remediation: error.remediation };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'INTERNAL_ERROR',
    message: `The demo run failed: ${message}`,
    remediation: { action: 'retry', hint: 'Re-send POST /api/demos. If it repeats, check the worker log.' }
  };
}

function describeModule(name: 'agent' | 'render'): DemoFailure {
  return {
    code: 'INTERNAL_ERROR',
    message: `The ${name} package (packages/${name}) is not available in this build, so the demo could not finish.`,
    remediation: {
      action: `install_${name}`,
      hint: `Build packages/${name} and re-queue the demo — the API, REST surface and MCP tools work without it.`
    }
  };
}

async function loadAgent(): Promise<AgentModule> {
  let mod: unknown;
  try {
    mod = await import(AGENT_ENTRY);
  } catch {
    throw new ApiError('INTERNAL_ERROR', describeModule('agent').message, describeModule('agent').remediation);
  }
  const candidate = mod as AgentModule;
  if (typeof candidate.runCapture !== 'function') {
    throw new ApiError('INTERNAL_ERROR', describeModule('agent').message, describeModule('agent').remediation);
  }
  return candidate;
}

async function loadRenderer(): Promise<RenderModule> {
  let mod: unknown;
  try {
    mod = await import(RENDER_ENTRY);
  } catch {
    throw new ApiError('INTERNAL_ERROR', describeModule('render').message, describeModule('render').remediation);
  }
  const candidate = mod as RenderModule;
  if (typeof candidate.renderDemo !== 'function') {
    throw new ApiError('INTERNAL_ERROR', describeModule('render').message, describeModule('render').remediation);
  }
  return candidate;
}

/** Entry point used by the queue. Never throws: failures land on the demo row. */
export async function runDemo(demoId: string, signal: AbortSignal): Promise<void> {
  const demo = one<DemoRow>('SELECT * FROM demos WHERE id = ?', demoId);
  if (!demo || demo.status !== 'running') return;

  ensureDirs();
  const outDir = path.join(PATHS.videos, demoId);
  fs.mkdirSync(outDir, { recursive: true });
  const { request, credentials } = loadDemoRequest(demo);

  // Saved product: base URL + decrypted session (never leaves this process).
  const environment = demo.environment_id
    ? one<EnvironmentRow>('SELECT * FROM environments WHERE id = ?', demo.environment_id)
    : undefined;
  const signIn = demo.environment_id
    ? loadSignIn({ workspaceId: demo.workspace_id }, demo.environment_id)
    : {};
  const fullRequest: DemoRequest = {
    ...request,
    credentials: request.credentials ?? signIn.credentials ?? credentials
  };

  try {
    setProgress(demoId, 0.03);
    const agent = await loadAgent();
    if (signal.aborted || !stillRunning(demoId)) return cancelled(demoId);

    const capture = await agent.runCapture({
      id: demoId,
      request: fullRequest,
      environment: environment
        ? { id: environment.id, baseUrl: environment.base_url, storageState: signIn.storageState as never }
        : undefined,
      onLog: (line: string) => console.log(`[worker ${demoId}] ${line}`)
    });
    persistSteps(demoId, capture.steps ?? []);
    setProgress(demoId, 0.55);

    if (signal.aborted || !stillRunning(demoId)) return cancelled(demoId);

    if (capture.error) {
      // Director's "may I do this destructive thing?" prompt is a first-class
      // question on the demo: answerable via POST /:id/question/answer.
      if (capture.error.code === 'DESTRUCTIVE_ACTIONS_CONFIRMATION_REQUIRED') {
        run(
          'UPDATE demos SET question_json = ? WHERE id = ?',
          JSON.stringify({
            id: 'destructive-confirmation',
            prompt: capture.error.message,
            options: [
              { id: 'allow', label: 'Allow destructive steps and re-record' },
              { id: 'skip', label: 'Record without that step' }
            ]
          }),
          demoId
        );
      }
      failDemo(demoId, capture.error);
      return;
    }
    if (!capture.videoPath) {
      failDemo(demoId, {
        code: 'INTERNAL_ERROR',
        message: 'The browser finished without recording any video.',
        remediation: {
          action: 'retry',
          hint: 'The page may have closed early or the capture was blocked. Re-send POST /api/demos.'
        }
      });
      return;
    }

    const renderer = await loadRenderer();
    if (signal.aborted || !stillRunning(demoId)) return cancelled(demoId);

    setProgress(demoId, 0.75);
    const renderOptions = resolveRenderOptions(demo, capture);
    // Finished MP4 lives at data/videos/<demoId>.mp4 (smoke and the dashboard
    // both point at that path); renderer scratch space stays in outDir.
    const outputPath = path.join(PATHS.videos, `${demoId}.mp4`);
    const rendered = await renderer.renderDemo({
      capture,
      steps: capture.steps ?? [],
      outDir,
      outputPath,
      options: renderOptions
    });
    if (signal.aborted || !stillRunning(demoId)) return cancelled(demoId);
    setProgress(demoId, 0.95);

    const durationMs = Number(rendered.durationMs) || Math.max(0, capture.endedAtEpochMs - capture.startedAtEpochMs);
    const credits = creditsForDuration(durationMs);
    const outcome = authoredOutcome(capture);
    const ts = nowIso();
    const updated = run(
      `UPDATE demos SET
         status = 'complete',
         progress = 1,
         video_path = ?,
         poster_path = ?,
         srt_path = ?,
         duration_ms = ?,
         outcome_json = ?,
         failure_json = NULL,
         credits_used = ?,
         finished_at = ?
       WHERE id = ? AND status = 'running'`,
      relativeToData(rendered.videoPath ?? outputPath),
      relativeToData(rendered.posterPath ?? null),
      relativeToData(rendered.srtPath ?? null),
      Math.round(durationMs),
      JSON.stringify(outcome),
      credits,
      ts,
      demoId
    );

    if (updated > 0) {
      run(
        'INSERT INTO credit_ledger (id, workspace_id, delta_seconds, reason, demo_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        `led_${demoId}`,
        demo.workspace_id,
        billableSeconds(durationMs),
        'demo.completed',
        demoId,
        ts
      );

      // The capture immediately becomes Product Graph + article + guide.
      if (demo.environment_id) {
        try {
          const shots = new Map<number, string>();
          for (const stepRow of many<{ idx: number; screenshot_path: string }>(
            'SELECT idx, screenshot_path FROM demo_steps WHERE demo_id = ? AND screenshot_path IS NOT NULL',
            demoId
          )) {
            const absPath = absoluteFromData(stepRow.screenshot_path);
            if (absPath && fs.existsSync(absPath)) shots.set(Number(stepRow.idx), absPath);
          }
          upsertProductGraph({
            workspaceId: demo.workspace_id,
            environmentId: demo.environment_id,
            instruction: demo.instruction,
            steps: capture.steps ?? [],
            screenshots: shots
          });
        } catch (error) {
          // The video is the deliverable; graph failure must not fail the demo.
          console.error(
            `[worker] product graph update failed for ${demoId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Last: the webhook payload can now carry the flow/article/guide that the
      // completion just produced. Same fire-and-forget rule as the failure path.
      void notifyDemoEvent(demoId, 'demo.complete');
    }
  } catch (error) {
    if (signal.aborted) {
      cancelled(demoId);
      return;
    }
    if (!stillRunning(demoId)) return;
    failDemo(demoId, failureFromError(error));
    console.error(`[worker] demo ${demoId} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}