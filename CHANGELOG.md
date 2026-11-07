# Changelog

All notable changes to Reelforge are documented here.

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Everything marked "verified" was actually executed; the evidence lives in
[docs/VERIFICATION.md](docs/VERIFICATION.md).

## [0.2.0] — unreleased

The "bring your own model" release. Everything here is in the tree; the tag is
cut when the Docker image has been published to GHCR (see
[docs/DEPLOY.md](docs/DEPLOY.md)).

### Added

- **Docker, in one command.** Multi-stage `Dockerfile` on the official
  Playwright image (Chromium and every OS library pre-installed, version-matched
  to the locked Playwright release), running as non-root, with `/data` as a volume,
  `EXPOSE 4400`, a real `/api/health` healthcheck and a `docker-compose.yml`
  (named volume, optional `.env`, restart policy, commented Ollama service for a
  fully local setup). `docker compose up -d` gives you the API, dashboard, guide
  widget and worker.
- **BYO model (BYOK).** `/api/providers` exposes a provider catalog — GMI Cloud,
  OpenAI, OpenRouter, Groq, Together, Fireworks, DeepSeek, Ollama and LM Studio —
  with model listing and a connection test. Point `REELFORGE_LLM_BASE_URL` at any
  OpenAI-compatible endpoint; keys are stored encrypted per workspace.
- **More likely narration voices.** ElevenLabs joins OpenAI TTS, edge-tts and
  Windows SAPI in the `auto` provider chain; `none` renders a silent video with
  burned captions (what CI and the Docker image use).
- **MCP, extended.** Beyond Director's published tool list: guides
  (`list_guides`, `get_guide`, `publish_guide`, `unpublish_guide`), login codes,
  domains, integrations, workspace settings and recording presets — same
  streamable-HTTP transport at `POST /api/mcp`.
- **Share pages.** `GET /api/demos/:id/share` mints a 30-day, no-API-key,
  HMAC-signed link to a self-contained demo page (video + step transcript).
- **GIF and WebVTT exports.** `POST /api/demos/:id/exports { kind: "gif" | "vtt" }`
  queues an out-of-band job; `GET` lists every export with a signed media URL.
- **Webhook notifications.** A per-workspace webhook target receives a JSON
  payload when a demo finishes, so "record a demo of the new feature" can be the
  last step of a deploy instead of a manual chore.
- **CI and releases.** GitHub Actions matrix (Node 22 and 24: typecheck,
  dashboard build, guide build, render self-test, full smoke test) and a tag
  pipeline that builds and pushes the image to GHCR.
- **Community files.** CONTRIBUTING, CODE_OF_CONDUCT, SECURITY (with a threat
  model), this CHANGELOG, editorconfig/gitattributes, issue and PR templates,
  and [docs/CONTRIBUTING-DEV.md](docs/CONTRIBUTING-DEV.md) — a tour for people
  who want to add a planner, a render filter or an MCP tool.

### Changed

- `REELFORGE_LLM_PROVIDER` and the narration chain now accept named providers
  instead of only `auto`.
- The dashboard gained screens for providers, exports, sharing and settings.

### Fixed

- Bodyless `POST`s (`cancel`, `reverify`, `publish`, `verify`) no longer fail
  with Fastify's empty-JSON-body error.
- Media and share tokens are long enough for Fastify's default param length;
  `/api/files/:token` and `/api/share/:token` now route correctly.

## [0.1.0] — 2026-11-07

The verified baseline: one URL + one sentence in, a narrated MP4, a help-centre
article, an internal training doc and an in-app guide out — from one Product
Graph, with no API keys required.

### Added

- **REST API** mirroring Director's contract: `{ message, data }` envelope, the
  seven documented error codes, `X-API-Key` auth, signed 1-hour media URLs, and
  a polling model for demo progress (`GET /api/health` advertises features).
- **MCP server** at `POST /api/mcp` (streamable HTTP), Director-compatible tool
  names, works with Claude Code, Cursor and Claude Desktop.
- **Browser agent** (`packages/agent`): Playwright Chromium at 1280×720 with
  video capture, a cursor + click-ripple overlay injected into the page (so the
  recording already contains them), per-step timing/box/selector capture,
  observers, guards and a re-check path.
- **Render pipeline** (`packages/render`): ease-in auto-zoom keyframes, burned
  captions, watermark, narration mux — one ffmpeg pass — plus a 12/12 self-test
  on synthetic input.
- **Product Graph**: flows deduplicated by `sha256` signature, screens and flow
  steps indexed, staleness detection on re-check (real drift, demonstrated in
  the smoke test).
- **Publishables from a flow**: help-centre article, internal training doc and
  an embeddable in-app guide (shadow DOM, `< 6 KB` gzip budget, no CSS leakage).
- **Offline-first defaults**: scripted planner and Windows SAPI narration when no
  LLM/TTS keys are set — the whole pipeline is demonstrable with zero credentials.
- **Dashboard** (React/Vite) served by the API at `/app/`, and the guide widget at
  `/g/`.
- **CLI** (`reelforge session | mcp | init | doctor`), Director CLI parity.
- **Demo product** (`apps/demo-site`) — a small SaaS with real flows used by the
  smoke test.
- **Tooling**: `npm run dev` (three services, tree-kill on Windows),
  `npm run seed`, `npm run smoke` (23/23 assertions), `npm run typecheck`.

### Verified

- `npm run typecheck` — zero errors across the monorepo.
- `node packages/render/test/render-selftest.ts` — 12/12.
- `node packages/agent/scripts/verify-overlay.ts` — 15/15, `verify-guards.ts` —
  39/39, `e2e.ts` — 11-step real capture.
- `node packages/web/test/dashboard-smoke.mjs` — 22/22;
  `packages/guide/test/widget-smoke.mjs` — 12/12.
- `npm run smoke` — 23/23: 11-step demo recorded, 862 479 B MP4, Product Graph
  flow, 3 159-char article, 10-step embeddable guide, stale flow detected.

### Verified

- `docker build -t reelforge .` succeeds from a clean checkout (4.32 GB on disk;
  Playwright base image dominates). The image's runtime guard confirms
  `chromium-1254` matches `playwright-core@1.65.0`.
- The container answers `GET /api/health` (200, features
  `environments,login-codes,graph,guides,mcp,providers,webhooks,exports,share`),
  serves `/app/` and `/g/guide.js` (200), returns 403 for path traversal under
  `/app/`, and runs as non-root `pwuser` (uid 1001).
- `npm run smoke` **inside the built image** → **23/23**: real Chromium recording,
  ffmpeg render, Product Graph flow, article and embeddable guide. No TTS, no
  model key.
- `docker compose up -d` builds, seeds, and reports healthy on `/api/health`.

### Known limitations

See [docs/VERIFICATION.md § 7](docs/VERIFICATION.md#7-known-limitations-honest-list):
scripted-planner coverage, robotic offline voice, passkey-bound-account
limitations, cooperative cancellation, no download/file-input/multi-tab flows,
Zendesk sync is a stub, and credits are modelled but not enforced by default.