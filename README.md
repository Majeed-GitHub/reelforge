# Reelforge

**Give it a URL and one sentence. It drives your product in a real browser and publishes a narrated demo video, a help-centre article, an internal training doc and an in-app guide — all from one Product Graph.**

Reelforge is a self-hosted, open reimplementation of [Screenforge Director](https://director.screenforge.co),
built by reverse-engineering the public product: its documented REST/MCP surface, its
published CLI (`@screenforge/director-cli`), and its observable behaviour. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for exactly what was recovered and how.

```
URL + one sentence
      │
      ▼
 real Chromium  ──►  recorded run  ──►  narrated MP4 (auto-zoom, cursor, captions)
      │                    │
      │                    └────────►  Product Graph (screens · flows · controls)
      │                                        │
      │                                        ├─►  Help-centre article
      │                                        ├─►  Internal training doc
      │                                        └─►  In-app guide (embed script)
      ▼
 REST API + MCP server, so your coding agent can do all of it too
```

## Quickstart

```bash
npm install
npx playwright install chromium     # once
npm run seed                        # creates the workspace + an rg_… API key
npm run dev                         # demo product :4402 · API+worker :4400 · dashboard :4401
```

Open <http://127.0.0.1:4401>, paste the key printed by `npm run seed`, and record a demo
of the bundled test product (Northwind) at <http://127.0.0.1:4402>.

Then prove the whole pipeline works end to end:

```bash
npm run smoke
```

## What it does

| Stage | What happens |
|---|---|
| **Plan** | The instruction is turned into browser actions. Uses any OpenAI-compatible model when configured; otherwise an offline scripted planner that understands sign-in, navigation, create/invite/upgrade style flows. |
| **Drive** | Playwright Chromium opens the product, signs in if needed, and acts. A cursor and click ripples are injected *into the page* so the recording already contains them. |
| **Capture** | Every step records timing (ms), the target element's box, selector, accessible name, a screenshot and a narration line. |
| **Render** | One ffmpeg pass: eased auto-zoom onto the action, burned captions, watermark, and a synthesised voiceover timed to the steps. |
| **Index** | The run is filed into the Product Graph: one flow per route (deduplicated by signature), screens, and the controls each step used. |
| **Publish** | Video + help article + internal training doc + in-app guide are all views of that one flow. Re-checking a flow flags it stale when the product drifts. |

## Everything in the box

- **REST API** at `/api` mirroring Director's contract (envelope, error codes, polling model).
- **MCP server** at `POST /api/mcp` (streamable HTTP) with 20+ tools — works in Claude Code, Cursor, Claude Desktop.
- **Dashboard** — demos, live status, video player, transcript, Product Graph, articles, guides, environments, API keys.
- **Embeddable guide** — one `<script>` tag, no dependencies, no CSS leakage (shadow DOM).
- **Product Graph** — flows deduplicated by signature, staleness detection on re-check.
- **Offline-first** — no API keys required: Windows SAPI narration + scripted planner. Add a key and it upgrades in place.

## Configure

Everything is optional; copy `.env.example` to `.env`. The important knobs:

| Variable | Default | Purpose |
|---|---|---|
| `REELFORGE_LLM_BASE_URL` / `_API_KEY` / `_MODEL` | unset | Any OpenAI-compatible endpoint for the planner and narration. |
| `REELFORGE_TTS_PROVIDER` | `auto` | `auto` → openai → edge-tts → Windows SAPI → silent. |
| `REELFORGE_TTS_VOICE` | system default | Voice name for the narration. |
| `REELFORGE_DATA_DIR` | `./data` | Database, videos, screenshots, audio. |
| `REELFORGE_BLOCK_LOCAL` | `false` | Set `true` to reject loopback targets like Director does. |
| `REELFORGE_ENFORCE_CREDITS` | `false` | Turn on per-minute credit metering (1 credit = 1 finished minute, 15 s minimum). |

## Use it from an agent

```bash
# REST
curl -s -X POST http://127.0.0.1:4400/api/demos \
  -H "X-API-Key: $REELFORGE_API_KEY" -H "Content-Type: application/json" \
  -d '{"target":{"type":"url","url":"https://app.example.com"},
       "instruction":"Create a project, then invite a teammate.",
       "authorized":true,"options":{"language":"en"}}'
# -> { "data": { "id": "dem_…", "status": "queued", "pollAfterSeconds": 3 } }
```

```bash
# MCP (Claude Code)
claude mcp add --transport http reelforge http://127.0.0.1:4400/api/mcp --header "X-API-Key: rg_…"
```

## Repository map

```
packages/core     domain contract, SQLite schema, credits, flow signatures, article templates
packages/agent    Playwright runner, injected cursor, observer, LLM + scripted planners, re-check
packages/render   TTS, captions, auto-zoom timeline, single-pass ffmpeg render
packages/api      Fastify REST surface, MCP server, in-process worker, Product Graph
packages/web      React dashboard (Vite)
packages/guide    embeddable in-app guide widget (esbuild, <6 KB gzip)
packages/cli      reelforge session | mcp | init | doctor  (Director CLI parity)
apps/demo-site    a real little SaaS to record demos of
scripts/          dev runner, seeding, smoke test, contact-sheet preview
docs/             ARCHITECTURE.md (reverse-engineering notes), API.md, VERIFICATION.md
```

## Verify

```bash
npm run typecheck    # whole monorepo, zero errors
npm run smoke        # records a demo, renders it, checks graph + article + guide
```

`npm run smoke` boots the demo product and the API, records a real 11-step demo,
renders it with narration and captions, then asserts 23 things about the result — exit 0
when all pass. Full evidence, including the step table, artifact sizes and the honest
limitation list: **[docs/VERIFICATION.md](docs/VERIFICATION.md)**.

Verified on this machine (Windows 11, Node 25.8.1, no API keys at all):

| | |
|---|---|
| Finished video | `data/videos/dem_e4wqphjy.mp4` — 862 479 B, h264 1280×720 + AAC, 32.5 s |
| Steps captured | 11, each with viewport box, click point, selector, screenshot, narration |
| Product Graph | 1 flow, signature `617d4a55e9fa0a75`, 6 screens |
| Help article | 3 159 chars, 11 sections, signed screenshots |
| In-app guide | 10 resolvable steps, public embed key |
| Billed | 0.542 credits (32.549 s at 1 credit/minute) |
| Smoke | **23/23** |

## Licence

MIT. The design is reverse-engineered for interoperability; no Screenforge code is
included — the API shape, error codes and CLI behaviour were reimplemented from public
documentation and the published npm client.
