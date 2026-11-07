# Reelforge — architecture, and what was reverse-engineered

Reelforge is a self-hosted clone of [Screenforge Director](https://director.screenforge.co).
Give it a URL and one sentence; it drives your product in a real browser, records the
run, and publishes a **narrated demo video**, a **help-centre article**, an
**internal-training doc** and an **in-app guide** — all views of one **Product Graph**.

---

## 1. What was reverse-engineered, and how

| Evidence | What it told us |
|---|---|
| Public sitemap (13 routes) | Full product surface: demo videos, help center, in-app guides, release demos, API/MCP, integrations, compare, pricing. |
| `/developers` page | Complete REST surface: base URL, `X-API-Key: dir_…`, field-by-field request/response, all 7 error codes, 20 endpoints, MCP tool list, CLI commands, tunnel rules. |
| `GET https://api.director.screenforge.co/api/demos` → `401` | The API is real and key-gated, and returns an empty body on unauthenticated requests (no JSON error envelope before auth). |
| `@screenforge/director-cli@0.1.8` (npm tarball, `dist/*.js`) | **Ground truth for internals.** Revealed: `{ code, message, data }` envelope with `NOT_FOUND*` codes; `GET /health` → `{ version, features: ["environments","login-codes", …] }`; NestJS-style bare 404s; single-use `DIR-XXXX-XXXX-XXXX` login codes expiring in 30 min; `POST /environments/:id/session` and `POST /environments/by-code/:code/session` taking a Playwright `storageState` **with `indexedDB: true`**; `GET /environments/by-code/:code`; CLI feature-gates itself on `/health.features`. |
| CLI README | The auth model: session capture instead of passwords; "captured session is encrypted at rest, never readable through the API"; passkeys can't be replayed (origin + device bound) — a real, documented limitation we inherit. |

What is **not** observable (and therefore reimplemented from first principles):
the planner, the Product-Graph matching logic, the render/zoom pipeline, and the
narration pipeline.

## 2. Reconstructed API contract (what Reelforge implements)

```
Base            http://127.0.0.1:4400/api
Auth            X-API-Key: rg_…      (or Authorization: Bearer rg_…)
Envelope        { "message": "…", "data": { … } }
Errors          { "code": "…", "message": "…", "remediation": { "action": "…", "hint": "…" } }
Health          GET /health → { version, features: ["environments","login-codes","graph","guides"] }
```

| Endpoint | Purpose |
|---|---|
| `POST /api/demos` | Start a demo. Returns `{ id, status:"queued", pollAfterSeconds }` immediately. |
| `GET /api/demos/:id` | Status, progress, `videoUrl` (signed), `outcome`, `question`, `failure`. |
| `GET /api/demos/:id/transcript` | Narration line by line with timestamps. |
| `POST /api/demos/:id/question/answer` | Answer a pre-recording question `{ optionId }`. |
| `POST /api/demos/:id/cancel` | Cancel an unfinished run. |
| `GET /api/demos` | Recent demos (≤100). |
| `POST /api/environments` | Save a product: name, base URL, sign-in mode. |
| `POST /api/environments/:id/session` | Attach a captured Playwright `storageState`. |
| `POST /api/environments/:id/verify` | Check the stored sign-in still works. |
| `POST /api/domains/attest` | Confirm once that you may record a domain. |
| `GET/POST /api/domains/verification` | DNS/file token proving domain control. |
| `GET /api/environments/:id/graph/flows` | Every flow in the Product Graph, with status. |
| `POST /api/environments/:id/graph/flows/:flowId/reverify` | Re-check a flow without recording. |
| `POST /api/articles/from-flow` | Write an article from a flow (`channel: help_center\|internal_training`). |
| `POST /api/articles/:id/publish` | Publish (and sync to Zendesk if configured). |
| `GET /api/presets`, `GET /api/presets/voices` | Recording presets and narration voices. |
| `POST /api/mcp` | MCP server, streamable HTTP, same tool set. |

Error codes reproduced verbatim: `INSUFFICIENT_CREDITS` (402),
`TARGET_UNREACHABLE` (400), `DOMAIN_AUTHORIZATION_REQUIRED` (409),
`DESTRUCTIVE_ACTIONS_CONFIRMATION_REQUIRED` (409), `CONCURRENCY_LIMIT_REACHED` (429),
`ENVIRONMENT_SESSION_EXPIRED` (409), `DOMAIN_BLOCKED` (403).

## 3. Pipeline

```
POST /api/demos
      │  1. validate + credit check + domain attestation
      ▼
  demos row (queued) ──────────────► worker picks it up (single process, in-proc queue)
      │                                    │
      │                    2. browser agent (packages/agent)
      │                       • Playwright Chromium, 1280×720, video on
      │                       • injects cursor + click-ripple DOM overlay (see §5)
      │                       • loop: observe → plan → act → screenshot
      │                       • records per-step timing, box, selector, narration
      │                       ▼
      │                    CaptureResult { steps, videoPath, viewport }
      │                    3. renderer (packages/render)
      │                       • TTS each narration line → wav/mp3
      │                       • build keyframe timeline → auto-zoom crop
      │                       • burn captions (SRT), watermark, mux audio
      │                       ▼
      │                    finished MP4 + poster + transcript
      ▼
  demos row (complete) ──► Product Graph upsert (flows, flow_steps, screens)
                       └─► article from flow (help centre / training)
                       └─► in-app guide draft
```

The worker is deliberately in-process (no Redis/BullMQ) so the whole thing runs
with `node` and SQLite. Swapping in a real queue is a one-file change.

## 4. Data model

SQLite (`node:sqlite`, no native build step):

`workspaces · api_keys · environments · environment_secrets · domains · demos ·
demo_steps · flows · flow_steps · screens · articles · guides · presets ·
credit_ledger · login_codes`

Secrets (`environment_secrets.credentials`, `.storage_state`) are AES-256-GCM
encrypted at rest with a keyfile at `data/.secret` — the same promise Director
makes ("encrypted at rest, never readable through the API").

A flow's identity is `sha256(kind:label>kind:label>…)`, so re-recording the same
route updates one flow instead of creating a duplicate (the "stored once" claim).

## 5. The two hard parts, solved

### 5.1 Cursor + click feedback without compositing

Playwright's recorded video has no pointer. Rather than compositing a cursor in
ffmpeg (frame-exact, expensive, brittle), Reelforge injects the pointer *into the
page* with `addInitScript`:

- a styled `div` follows `mousemove` (so every `page.mouse.move(x, y, {steps:n})`
  produces real, eased motion in the recorded pixels);
- `mousedown` spawns a ripple animation at the click point;
- `:focus`/`:active` outlines are augmented slightly so actions read on video.

Nothing to composite, nothing to keep in sync — the cursor is *in* the capture.

### 5.2 Auto-zoom

Per-step `box` (element bounds) + `point` are recorded with ms timings relative
to video start. The renderer derives keyframes `(t, cx, cy, zoom)` and applies
them with a single ffmpeg pass:

- upscale to 2× (keeps crops sharp),
- animated crop whose `x`/`y`/size follow an eased interpolation between
  keyframes (generated as an ffmpeg expression program, not eyeballed),
- scale back to the target height, `yuv420p`, `+faststart`.

Zoom strength is configurable (`options.zoom`, default 1.6×); steps whose target
is already small in frame zoom further. Cuts are clamped so the camera never
leaves the viewport.

## 6. Narration, offline-first

No API keys are required to produce a narrated video:

1. `sapi` — Windows `System.Speech` voices via PowerShell (works offline, no deps);
2. `edge` — `edge-tts` if installed (natural neural voices, cross-platform);
3. `openai` — `gpt-4o-mini-tts` if `OPENAI_API_KEY` is set;
4. `none` — silent video + burned captions.

The same applies to the planner: `infra` uses an OpenAI-compatible chat endpoint
when `REELFORGE_LLM_API_KEY` exists, and otherwise falls back to a **scripted
planner** that executes a deterministic instruction grammar — so the full
pipeline (browser → video → article → guide) is demonstrable with zero
credentials, and upgraded by setting one env var.

## 7. Deliberate differences from Director

| Director | Reelforge |
|---|---|
| Hosted SaaS, credits billed per minute | Self-hosted; credits modelled for parity but enforcement off by default |
| Proprietary planner | Provider-agnostic: any OpenAI-compatible endpoint, or offline scripted planner |
| Cloud TTS | Offline SAPI fallback, no key needed |
| Cloud workers, 30 tunnel demos/day | Local Chromium; tunnels supported the same way (public HTTPS URL + `authorized:true`) |
| Zendesk sync | Same endpoint shape; adapter is a stub you can point at any helpdesk |

## 8. Verification

`npm run smoke` drives the whole pipeline against `apps/demo-site` (a small SaaS
with real flows: sign up → create project → invite teammate → upgrade plan) and
asserts: a demo reaches `complete`, the MP4 exists and is non-trivial in size,
the Product Graph gained a flow, an article was generated, and a guide draft
exists with resolvable selectors.
