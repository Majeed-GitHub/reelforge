/**
 * Demo exports: a looping GIF preview and WebVTT captions.
 *
 * Both are derived artifacts, so they are produced out-of-band: POST returns
 * `{ id, kind, status: "queued" }` immediately, a fire-and-forget job writes the
 * file under `data/exports/<demoId>/`, and GET lists every export with a signed
 * `/api/files/<token>` URL the dashboard can use directly.
 *
 * The job table is created here with `CREATE TABLE IF NOT EXISTS` (no core/db.ts
 * change): exports are an API-surface concern, not core domain.
 *
 * Wire format (frozen with the dashboard):
 *   POST /api/demos/:id/exports  { kind: "gif"|"vtt" } -> { id, kind, status }
 *   GET  /api/demos/:id/exports  -> { exports: [ { id, kind, status, url, bytes } ] }
 *
 * An unknown `kind` is a 501 with the normal error envelope, never a 500 — the
 * dashboard disables unsupported buttons based on that.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PATHS, absoluteFromData, ensureDirs, relativeToData } from '../../../core/src/config.ts';
import { getDb } from '../../../core/src/db.ts';
import { ApiError, ok } from '../../../core/src/http.ts';
import { newId, nowIso } from '../../../core/src/ids.ts';
import type { DemoRow, NarrationLine, StepRecord } from '../../../core/src/types.ts';
import { authOf } from '../auth.ts';
import { many, one, run } from '../dbq.ts';
import { getDemoRow } from '../services/demos.ts';
import { mediaUrl } from '../signing.ts';
import { parseBody } from '../util.ts';

/** Render modules are loaded lazily so the API boots without packages/render. */
const GIF_ENTRY = new URL('../../../render/src/gif.ts', import.meta.url).href;
const VTT_ENTRY = new URL('../../../render/src/vtt.ts', import.meta.url).href;

const EXPORTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS demo_exports (
  id TEXT PRIMARY KEY,
  demo_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  path TEXT,
  size_bytes INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_demo_exports_demo ON demo_exports(demo_id, created_at DESC);
`;

getDb().exec(EXPORTS_SCHEMA);

const EXPORT_KINDS = { gif: 'animated GIF preview', vtt: 'WebVTT captions' } as const;
type ExportKind = keyof typeof EXPORT_KINDS;
type ExportStatus = 'queued' | 'running' | 'complete' | 'failed';

type ExportRow = {
  id: string;
  demo_id: string;
  workspace_id: string;
  kind: string;
  status: ExportStatus;
  path: string | null;
  size_bytes: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

type GifModule = {
  createGifPreview: (
    videoPath: string,
    options: { outPath: string; steps?: StepRecord[]; durationMs?: number; maxWidth?: number }
  ) => Promise<{ path: string; sizeBytes: number }>;
};

type VttModule = {
  buildVtt: (lines: NarrationLine[], options?: { totalDurationMs?: number }) => string;
  srtToVtt: (srt: string) => string;
};

const requestExportSchema = z.object({ kind: z.string().trim().min(1).max(20) });

function isSupportedKind(kind: string): kind is ExportKind {
  return kind === 'gif' || kind === 'vtt';
}

/** Absolute media URL -> same-origin path the dashboard can append to its API base. */
function signedPath(storedPath: string | null): string | null {
  const url = mediaUrl(storedPath);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** demo_steps -> StepRecord[] (box + timings) for the GIF moment picker. */
function stepsForDemo(demoId: string): StepRecord[] {
  return many<{
    idx: number;
    kind: StepRecord['kind'];
    narration: string;
    started_at_ms: number;
    ended_at_ms: number;
    selector: string | null;
    role: string | null;
    name: string | null;
    box_json: string | null;
    url: string | null;
  }>('SELECT * FROM demo_steps WHERE demo_id = ? ORDER BY idx ASC', demoId).map((row) => {
    let box: StepRecord['box'] = undefined;
    if (row.box_json) {
      try {
        const parsed = JSON.parse(row.box_json) as StepRecord['box'];
        if (parsed && typeof parsed === 'object') box = parsed;
      } catch {
        // ignore malformed box
      }
    }
    return {
      index: Number(row.idx),
      kind: row.kind,
      narration: row.narration ?? '',
      startedAtMs: Number(row.started_at_ms) || 0,
      endedAtMs: Number(row.ended_at_ms) || 0,
      selector: row.selector ?? undefined,
      role: row.role ?? undefined,
      accessibleName: row.name ?? undefined,
      box,
      url: row.url ?? undefined
    } satisfies StepRecord;
  });
}

function narrationLines(demoId: string): NarrationLine[] {
  return many<{ idx: number; narration: string; started_at_ms: number; ended_at_ms: number }>(
    'SELECT idx, narration, started_at_ms, ended_at_ms FROM demo_steps WHERE demo_id = ? ORDER BY idx ASC',
    demoId
  )
    .filter((row) => (row.narration ?? '').trim().length > 0)
    .map((row) => ({
      stepIndex: Number(row.idx),
      text: row.narration,
      startMs: Math.max(0, Number(row.started_at_ms) || 0),
      durationMs: Math.max(400, (Number(row.ended_at_ms) || 0) - (Number(row.started_at_ms) || 0))
    }));
}

function finishExport(id: string, storedPath: string | null, sizeBytes: number | null): void {
  run(
    "UPDATE demo_exports SET status = 'complete', path = ?, size_bytes = ?, error = NULL, finished_at = ? WHERE id = ?",
    storedPath,
    sizeBytes,
    nowIso(),
    id
  );
}

function failExport(id: string, message: string): void {
  run(
    "UPDATE demo_exports SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
    message.slice(0, 2000),
    nowIso(),
    id
  );
  console.error(`[exports] ${id} failed: ${message}`);
}

/**
 * Build one export. Runs detached from the request: the row is the source of
 * truth, so a client that polls GET sees queued -> running -> complete/failed.
 */
async function runExport(exportId: string): Promise<void> {
  const row = one<ExportRow>('SELECT * FROM demo_exports WHERE id = ?', exportId);
  if (!row) return;
  run("UPDATE demo_exports SET status = 'running' WHERE id = ? AND status = 'queued'", exportId);

  try {
    const demo = one<DemoRow>('SELECT * FROM demos WHERE id = ?', row.demo_id);
    if (!demo) throw new Error('demo row disappeared before the export ran');
    const videoAbs = absoluteFromData(demo.video_path);
    if (!videoAbs || !fs.existsSync(videoAbs)) {
      throw new Error('the demo video is not on disk — export needs a finished MP4');
    }

    ensureDirs();
    const outDir = path.join(PATHS.exports, demo.id);
    fs.mkdirSync(outDir, { recursive: true });

    if (row.kind === 'gif') {
      const mod = (await import(GIF_ENTRY)) as GifModule;
      if (typeof mod.createGifPreview !== 'function') throw new Error('packages/render does not export createGifPreview');
      const result = await mod.createGifPreview(videoAbs, {
        outPath: path.join(outDir, `preview-${exportId}.gif`),
        steps: stepsForDemo(demo.id),
        durationMs: 3500,
        maxWidth: 720
      });
      const stat = fs.statSync(result.path);
      finishExport(exportId, relativeToData(result.path), stat.size);
      return;
    }

    if (row.kind === 'vtt') {
      const mod = (await import(VTT_ENTRY)) as VttModule;
      const outPath = path.join(outDir, `captions-${exportId}.vtt`);
      // Mirror the SRT the renderer burned when it exists; otherwise rebuild
      // the same cues from the persisted step timings.
      const srtAbs = absoluteFromData(demo.srt_path);
      let vtt: string;
      if (srtAbs && fs.existsSync(srtAbs)) {
        vtt = mod.srtToVtt(fs.readFileSync(srtAbs, 'utf8'));
      } else {
        const lines = narrationLines(demo.id);
        if (lines.length === 0) throw new Error('this demo has no narration lines to caption');
        vtt = mod.buildVtt(lines, {
          totalDurationMs: demo.duration_ms && demo.duration_ms > 0 ? Number(demo.duration_ms) : undefined
        });
      }
      fs.writeFileSync(outPath, vtt, 'utf8');
      finishExport(exportId, relativeToData(outPath), fs.statSync(outPath).size);
      return;
    }

    throw new Error(`unknown export kind "${row.kind}"`);
  } catch (error) {
    failExport(exportId, error instanceof Error ? error.message : String(error));
  }
}

function exportView(row: ExportRow): { id: string; kind: string; status: ExportStatus; url: string | null; bytes: number | null } {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    url: signedPath(row.path),
    bytes: row.size_bytes === null ? null : Number(row.size_bytes)
  };
}

export default async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/demos/:id/exports', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    const body = parseBody(requestExportSchema, request.body ?? {});
    const kind = String(body.kind).trim().toLowerCase();

    if (!isSupportedKind(kind)) {
      // Unsupported kind: a normal error envelope with 501 so the dashboard can
      // disable that button instead of surfacing an internal failure.
      throw new ApiError(
        'VALIDATION_ERROR',
        `Export kind "${kind}" is not supported by this build.`,
        { action: 'use_supported_export', hint: `Supported kinds: ${Object.keys(EXPORT_KINDS).join(', ')}.` },
        501
      );
    }

    const demo = getDemoRow(auth, id);
    if (demo.status !== 'complete') {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Demo ${id} is ${demo.status}; only a complete demo can be exported.`,
        { action: 'get_demo_status', hint: 'Poll GET /api/demos/:id until status is "complete", then export.' },
        409
      );
    }
    if (!demo.video_path) {
      throw new ApiError('VALIDATION_ERROR', `Demo ${id} finished without a video file.`, {
        action: 'record_again',
        hint: 'Re-send POST /api/demos — there is nothing to export.'
      });
    }

    const exportId = newId('exp');
    const ts = nowIso();
    run(
      `INSERT INTO demo_exports (id, demo_id, workspace_id, kind, status, path, size_bytes, error, created_at, finished_at)
       VALUES (?, ?, ?, ?, 'queued', NULL, NULL, NULL, ?, NULL)`,
      exportId,
      demo.id,
      auth.workspaceId,
      kind,
      ts
    );
    void runExport(exportId);

    return ok({ id: exportId, kind, status: 'queued' }, `Export queued (${EXPORT_KINDS[kind]}).`);
  });

  app.get('/api/demos/:id/exports', async (request) => {
    const auth = authOf(request);
    const { id } = request.params as { id: string };
    const demo = getDemoRow(auth, id);
    const rows = many<ExportRow>(
      'SELECT * FROM demo_exports WHERE demo_id = ? AND workspace_id = ? ORDER BY created_at DESC, rowid DESC',
      demo.id,
      auth.workspaceId
    );
    return ok({ exports: rows.map(exportView) }, 'OK');
  });
}
