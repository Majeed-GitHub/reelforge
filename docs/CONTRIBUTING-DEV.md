# Contributor tour — how Reelforge works and where to touch it

This is the map for people changing code. Read
[docs/ARCHITECTURE.md](ARCHITECTURE.md) first for *why* it is built this way and
[docs/VERIFICATION.md](VERIFICATION.md) for what is actually proven today.
`README.md` is the quickstart; [CONTRIBUTING.md](../CONTRIBUTING.md) is the
process (PR rules, commit style).

The short version: **one `node` process, six stages, one SQLite file, no build
step for the TypeScript.** If you can read Playwright and ffmpeg invocations,
you can change almost anything here.

---

## 1. Running it while you hack

```bash
npm install
npx playwright install chromium
npm run seed                         # workspace + rg_ key -> data/dev-api-key.txt
npm run dev                          # demo product :4402 · API+worker :4400 · dashboard :4401
```

`npm run dev` runs `scripts/dev.mjs`, which starts three children:

| Child | Command | Purpose |
|---|---|---|
| `demo-site` | `node apps/demo-site/server.ts` | A real little SaaS to record (in-memory state). |
| `api` | `node packages/api/src/server.ts` | REST + MCP + static `/app` `/g` + in-process demo worker. |
| `web` | `vite --config packages/web/vite.config.ts` | Dashboard with HMR, proxying `/api` → `:4400`. |

Use the Vite server on `:4401` while working on the dashboard (HMR). The API's
built dashboard (`/app/`) only changes when you run
`npx vite build --config packages/web/vite.config.ts`.

Node executes the `.ts` files directly (type stripping). That means:

- **import with the `.ts` extension** — `import { getDb } from '../../core/src/db.ts'`;
- **no `enum`, `namespace`, parameter properties or decorators** — Node erases
  types, it does not transform syntax. `npm run typecheck` catches both the type
  errors and (indirectly) the syntax the runtime will reject;
- the only real build steps are `vite build` (dashboard) and
  `packages/guide/build.mjs` (esbuild widget bundle).

---

## 2. Package map

```
packages/core        the contract everything shares — start here
  types.ts           domain types: DemoRequest, CaptureResult, StepRecord,
                     Observation, PlannedAction, Planner, Product Graph rows,
                     RenderInput/RenderResult, workspace config
  db.ts              node:sqlite schema (CREATE TABLE IF NOT EXISTS) + getDb()
  config.ts          env parsing (all REELFORGE_*), PATHS, VIEWPORT, ensureDirs()
  http.ts            ApiError + ok()/err() — the Director envelope and error codes
  credits.ts         per-minute credit ledger math
  flow.ts            flow identity: sha256 signature over step kinds/labels
  crypto.ts          AES-256-GCM for stored secrets, keyfile at data/.secret
  ids.ts             dem_x / env_x ids, sha256, slugify
  providers.ts       provider catalog (GMI, OpenAI, Ollama, …) for BYOK
packages/providers   provider resolution: env → workspace key → none
packages/agent       the browser
  runner.ts          runCapture(): launch, drive, capture steps, save artifacts
  observer.ts        page → Observation (numbered element refs + DOM digest)
  planner/scripted.ts  offline deterministic planner (no key)
  planner/llm.ts       OpenAI-compatible planner (JSON action, repair, timeouts)
  planner/index.ts     createPlanner(): picks one, with LLM→scripted fallback
  injected.ts        cursor + click-ripple + focus ring injected into the page
  narration.ts       per-step narration lines (LLM or deterministic)
  reverify.ts        re-open a flow and check its steps still resolve
packages/render      the video
  index.ts           renderDemo(): TTS → timeline → one ffmpeg pass → MP4
  caption/zoom/ffmpeg/tts/gif/vtt.ts
packages/api         the product surface
  server.ts          Fastify wiring, error envelope, static mounts, /api/status
  auth.ts            X-API-Key → workspace; routes opt out with config.public
  queue.ts           in-process worker: pick queued demo, run, update progress
  worker/pipeline.ts the phase machine — capture → render → graph → article → guide
  routes/*.ts        REST endpoints (demos, environments, graph, articles, guides,
                     exports, share, settings, providers, files, presets, domains, mcp)
  services/*.ts      the actual logic, reused by REST and MCP
  graph.ts           Product Graph upsert + staleness
  mcp.ts             MCP server, Director tool set; tools-extra.ts the additions
  signing.ts         signed 1 h media tokens + 30-day share links
  targets.ts         loopback/private/public classification, blocklists
packages/web         React dashboard (screens/, components/, api.ts)
packages/guide       embeddable guide widget: src/guide.ts → dist/guide.js (<6 KB gzip)
packages/cli         reelforge session | mcp | init | doctor
apps/demo-site       the product the smoke test records
scripts/             dev.mjs, seed.ts, smoke.ts, preview.ts
```

---

## 3. What happens when you press "Record"

1. **`POST /api/demos`** → `packages/api/src/routes/demos.ts`
   validates with zod (`schemas.ts`), checks credits (`credits.ts`), domain
   attestation (`targets.ts`), inserts a `demos` row with `status='queued'`, and
   returns `{ id, status, pollAfterSeconds }` immediately (Director's polling
   model). `notifyWorker()` wakes the queue.
2. **`queue.ts`** picks the row up (in-process; `REELFORGE_CONCURRENCY` slots),
   marks it running, and calls **`worker/pipeline.ts` `runDemo()`**.
3. **Capture** — `agent.runCapture()` launches Playwright Chromium at 1280×720
   with `recordVideo`, injects the cursor overlay, then loops
   `observe() → planner.next() → act()`, recording for each step: kind, timing
   (ms), target box, click point, selector, accessible name, a screenshot and a
   narration line. It writes `data/raw/<id>/demo.webm`, `capture.json`, step
   screenshots and (if signed in) `session.json`.
4. **Render** — `render.renderDemo()` synthesises each narration line with the
   best available TTS, builds eased zoom keyframes from the step boxes/timings,
   burns captions, and runs **one** ffmpeg pass to `data/videos/<id>.mp4` plus a
   poster and `captions.srt`.
5. **Index** — `api/graph.ts` folds the steps into the Product Graph: a flow per
   route, deduplicated by signature (`flow.ts`), screens and the controls each
   step used. A re-check (`POST .../reverify`) marks the flow stale when a step
   no longer resolves.
6. **Publish** — `services/articles.ts` drafts the help-centre/internal-training
   article from the flow, `services/guides.ts` drafts the in-app guide;
   `services/webhooks.ts` fires the workspace webhook. All views of one flow.

Progress and phase are written to the `demos` row, so the dashboard just polls
`GET /api/demos/:id`. Cancellation is cooperative: `abortDemo()` flips a signal
the pipeline checks between phases.

---

## 4. Recipes

### 4.1 Add a planner

The contract is in `packages/core/src/types.ts`:

```ts
export interface Planner {
  readonly name: string;
  next(obs: Observation): Promise<PlannedAction>;   // kind:'done' ends the run
}
```

1. Create `packages/agent/src/planner/my-planner.ts` implementing it. Return one
   action at a time: `{ kind: 'click', ref }`, `{ kind: 'type', ref, value }`,
   `{ kind: 'wait', ... }`, `{ kind: 'done', narration }`. `ref` indexes
   `obs.elements` (the observer numbers the page for you). Choose selectors from
   `ElementRef` rather than inventing CSS where possible.
2. Wire it in `packages/agent/src/planner/index.ts` `createPlanner()` — that is
   the single place that decides which brain a run gets, including the
   `ResiliencePlanner` fallback to `ScriptedPlanner` when the model misbehaves.
3. Add a row/flag to the config if it needs settings (`core/src/config.ts`), and
   list it in `docs/DEPLOY.md`'s env matrix if it is user-facing.
4. Prove it offline: `packages/agent/scripts/verify-guards.ts` shows how to test
   a planner without a network (it stubs `fetch`). The smoke test must keep
   passing with `REELFORGE_LLM_PROVIDER=none`.

Rules of the house: **one action per call**, always provide a narration line
(it becomes the voiceover and the caption), and never fabricate success —
return `done` only when the goal is actually met, or the outcome verdict lies.

### 4.2 Add a render filter

`renderDemo()` in `packages/render/src/index.ts` assembles the ffmpeg invocation:
inputs (captured webm, per-line TTS audio), then `videoParts` (subtitles via
`subtitles=…`, watermark via `drawtext=…`), then a `filter_complex` that applies
the zoom/crop program and muxes audio. Two clean insertion points:

- **A per-frame effect overlay** (vignette, background blur, progress bar): add
  it to `videoParts` *before* the zoom section, so it is applied at source
  resolution and stays embedded in the crop. Look at the `variants` mechanism
  (`{ subtitles, watermark }`) — there is already a retry-without-subtitles path
  because libass/fonts can fail; follow that pattern so a missing font degrades
  instead of failing the render.
- **A camera/keyframe effect**: `packages/render/src/zoom.ts` — `buildZoomTimeline()`
  turns `StepRecord[]` into `(t, cx, cy, zoom)` keyframes and
  `zoomExpressionProgram()` emits the ffmpeg expression program. Change the
  easing/strength there; `zoomExpressionProgram` is tested by
  `packages/render/test/render-selftest.ts`.
- **Captions**: `captions.ts` builds the SRT (and `vtt.ts` the WebVTT export).
  Note Windows path escaping in the `subtitles=` filter (`C\:` → `C\\:`), which is
  why the code goes through `runFfmpeg` with explicit argv rather than a shell.

Then run `node packages/render/test/render-selftest.ts` — 12 assertions on a
synthetic capture, including "the output is h264 + AAC and the duration is within
tolerance". It takes seconds and needs no browser.

### 4.3 Add an MCP tool

MCP is the same HTTP API with a different shape; tools reuse the REST services.

1. Open `packages/api/src/mcp.ts` (Director-compatible tool set) or
   `packages/api/src/tools-extra.ts` (our additions: guides, login codes,
   presets). The helper is
   `register(server, name, description, zodShape, execute)`.
2. `execute` gets plain arguments and an `AuthContext`; call the service
   function (`listGuides`, `getGuide`, …) — do not re-implement SQL. Errors
   thrown as `ApiError` are returned as `isError` results with the documented
   envelope, so keep throwing those.
3. If the tool is new surface area, add it to `docs/API.md`'s MCP list and to the
   CHANGELOG. Tool names are part of the contract (agents pin them); additive is
   fine, renames are breaking.
4. Try it:
   ```bash
   curl -s -X POST http://127.0.0.1:4400/api/mcp \
     -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
     -H 'MCP-Protocol-Version: 2025-06-18' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

### 4.4 Add a REST endpoint

`routes/*.ts` are Fastify plugins: a `default async function (app)` that
registers handlers. Auth is on by default (`auth.ts`); a public route opts out
with `{ config: { public: true } }` (only `/api/health`, `/api/share/:token`,
`/api/guides/embed/:key` and `/api/files/:token` do). Return `ok(data, 'message')`
and throw `new ApiError('CODE', message, { action, hint })` — the server-level
error handler renders it in Director's envelope, so never `reply.code(...)`
with a bespoke shape. Register the plugin in `server.ts` and update
`docs/API.md`.

### 4.5 Add a TTS provider

`packages/render/src/tts.ts` has a provider table (`sapi`, `edge`, `openai`,
elevenlabs, `none`) and an `auto` chain (OpenAI → edge-tts → SAPI → silent).
Add a `synthesize` function returning clip paths plus warnings, register it, and
make sure `provider: 'none'` still produces a silent video with captions — CI
depends on it.

---

## 5. How the smoke test works

`npm run smoke` → `node scripts/smoke.ts`. It is the one test that proves the
*product*, and it is intentionally black-box: it talks to the public REST
surface, not internals.

1. **Prerequisites:** `npm run seed` must have run (it reads the key from
   `data/dev-api-key.txt`). It boots its own demo product and its own API, so
   nothing else may be bound to `:4400` / `:4402`.
2. **Boot:** spawns `node apps/demo-site/server.ts` and
   `node --env-file-if-exists=.env packages/api/src/server.ts`, then polls
   `http://127.0.0.1:4402/healthz` and `http://127.0.0.1:4400/api/health` for up
   to 40 s.
3. **Drive:** creates an environment, `POST /api/demos` with the instruction
   *"Sign in, create a project called Q4 Launch, invite sam@example.com to the
   team, then upgrade to the Team plan."*, and polls the demo until it is
   `complete` (8-minute deadline; a real run takes 1–3 minutes).
4. **Assert 23 things**, printing `PASS`/`FAIL` per check: demo complete, video
   URL → downloads → real MP4 magic bytes → sane duration, outcome verdict,
   transcript lines, Product Graph gained a flow, re-check returns a status
   (it comes back **stale** — the flow itself upgrades the demo product, which
   is the staleness detector working), article drafted with a body, guide drafted
   and publicly embeddable.
5. **Teardown:** `stopAll()` kills the whole child tree (Windows: `taskkill /T /F`,
   see below); `process.exit(1)` if any check failed.

Environment knobs: `REELFORGE_API_PORT` / `REELFORGE_DEMO_PORT` (and
`REELFORGE_SMOKE_API` for an already-running API). On Linux CI it runs with
`REELFORGE_TTS_PROVIDER=none` and `REELFORGE_LLM_PROVIDER=none` so no key or
network is involved.

Running smoke repeatedly **accumulates state** in `data/` (flows, articles,
guides, videos — it does not reset the workspace). Use a fresh
`REELFORGE_DATA_DIR` (or delete `data/` and re-seed) when you need a clean slate.

Other, faster layers (all runnable without a display):

```bash
node packages/render/test/render-selftest.ts        # ffmpeg only, seconds
node packages/providers/test/providers-selftest.ts  # BYOK resolution, no network
node packages/agent/scripts/verify-guards.ts        # destructive gate, redaction, stubs fetch
node packages/agent/scripts/verify-overlay.ts       # pixel proof of cursor/ripple (real browser)
node packages/agent/scripts/e2e.ts                  # real capture, no API
node packages/web/test/dashboard-smoke.mjs          # every screen against a live API
node packages/guide/test/widget-smoke.mjs           # shadow DOM, spotlight, keyboard nav
```

The web/guide tests need a running API (`npm run dev`); see the header comment in
each script for the exact ports and env.

---

## 6. Platform quirks (mostly Windows)

**`taskkill` tree kill.** `scripts/dev.mjs` and `scripts/smoke.ts` spawn
`node`/`vite` children, which spawn grandchildren. `child.kill()` on Windows
kills only the direct child, so the grandchildren keep the port bound and the
*next* run fails with `EADDRINUSE`. Both scripts therefore do:

```js
spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
```

on `win32`, and `child.kill('SIGTERM')` elsewhere. Keep that branch when you add
a long-running child — same reason `npm run dev` checks the ports up front and
prints the `REELFORGE_*_PORT` override hint.

- **SAPI narration** uses Windows PowerShell **5.1** (`powershell.exe`, which
  ships `System.Speech`), not `pwsh` 7. On Linux/macOS the provider is simply
  unavailable and `auto` falls through to silent.
- **ffmpeg paths in filters**: `subtitles=filename='…'` needs `:` and `\` escaped
  (`C\:`), which is why `packages/render/src/index.ts` normalises separators
  instead of interpolating a raw Windows path.
- **Line endings**: the repo is LF (`eol=lf` in `.gitattributes`); keep it that
  way — `*.ps1` is the only CRLF exception.
- **SQLite WAL** means `data/reelforge.db` alone is not a backup; copy
  `-wal`/`-shm` too or use the backup procedure in `docs/DEPLOY.md`.
- **Ports**: `4400` API, `4401` Vite dev dashboard, `4402` demo product. Override
  with `REELFORGE_API_PORT` / `REELFORGE_WEB_PORT` / `REELFORGE_DEMO_PORT` if
  something else on your machine owns them.

---

## 7. Definition of done for a change

1. `npm run typecheck` — clean (root + `packages/web` + `packages/agent` tsconfigs).
2. `node packages/render/test/render-selftest.ts` if you touched render/ffmpeg.
3. `npm run smoke` if you touched the agent, pipeline, API contract, graph or DB.
4. `docker build -t reelforge:dev .` if you touched the Dockerfile, dependencies
   or build outputs.
5. Docs updated where you invalidated them, plus a CHANGELOG entry under
   `[Unreleased]`.
6. No secrets, no `data/`, no built bundles in the diff.

If you are unsure where something belongs, the rule of thumb is: **contract in
`core`, behaviour in the package that owns the stage, wiring in `api`.** Ask in
an issue before adding a dependency or a database column.
