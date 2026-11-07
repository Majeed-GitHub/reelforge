# Verification log

Every number below comes from a real run on this machine, not from a plan.

**Machine:** Windows 11 · Node v25.8.1 (TypeScript run natively via type stripping) ·
Chromium `chromium-1254` (Playwright 1.56) · ffmpeg 6.1.1 `essentials_build` (bundled via
`ffmpeg-static`, includes libass) · narration via Windows SAPI (`Microsoft Zira Desktop`) ·
**no** API keys of any kind, so the offline scripted planner drove the browser.

## 1. Typecheck

```
npx tsc -p tsconfig.json --noEmit     → exit 0, zero errors (core, agent, render, api, cli, scripts)
node node_modules/typescript/bin/tsc -p packages/web/tsconfig.json --noEmit → exit 0
node node_modules/typescript/bin/tsc -p packages/agent/tsconfig.json --noEmit → exit 0
```

## 2. Unit-level proofs

| Command | Result |
|---|---|
| `node packages/render/test/render-selftest.ts` | **12/12** — synthetic 8 s webm + 4 steps → 1280×720 h264 + AAC, duration within tolerance, SRT + poster extracted |
| `node packages/agent/scripts/e2e.ts` | real capture: 11 steps, every click/type with viewport box + point + accessible name; 728 239-byte `demo.webm`, ffprobe 19.28 s @ 1280×720 |
| `node packages/agent/scripts/verify-overlay.ts` | **15/15** — cursor arrow, click ripple and focus ring present in the captured pixels |
| `node packages/agent/scripts/verify-guards.ts` | **39/39** — destructive gate, `maxSteps` cap, `TARGET_UNREACHABLE` fail-fast, LLM JSON repair + fallback, password redaction |
| `node packages/web/test/dashboard-smoke.mjs` | **22/22** — every screen, live polling, failure remediation, API-down states, zero page errors |
| `node packages/guide/test/widget-smoke.mjs` | **12/12** — shadow-DOM isolation, spotlight geometry, keyboard nav, stale-step skip + report |
| `node packages/web/test/integration-check.mjs` | **12/12 against the live API** — real demo, graph, article, guide, settings |

## 3. End-to-end (`npm run smoke`) — 23/23

Boots the demo product (`apps/demo-site`, port 4402) and the API (port 4400, with its
in-process worker), then drives the whole product through its public REST surface.

```
PASS  demo product boots                     http://127.0.0.1:4402
PASS  API boots                              http://127.0.0.1:4400
PASS  GET /health                            version 0.1.0
PASS  health advertises features             environments,login-codes,graph,guides,mcp
PASS  unauthenticated request rejected       401 UNAUTHORIZED
PASS  environment saved                      env_ukauuy5d
PASS  POST /demos accepted                   dem_e4wqphjy
PASS  POST /demos returns a poll hint        3
PASS  demo finished                          complete
PASS  video URL returned                     signed /api/files/…
PASS  video downloads                        862 479 bytes, video/mp4
PASS  video is a real mp4                    ftypisom
PASS  duration is sane                       32 549 ms
PASS  outcome carries a verdict              goalMet:true, stepsCompleted:11
PASS  transcript has narration               11 lines
PASS  Product Graph gained a flow            "Sign in then create project"
PASS  flow re-check runs                     stale (real drift — see §5)
PASS  help article drafted from the flow     1 article, 3 159 chars
PASS  in-app guide drafted                   1 guide, 10 steps
PASS  guide is publicly embeddable           200 with no API key
23/23 checks passed.  exit 0
```

## 4. What was actually produced by that run

The instruction was: *"Sign in, create a project called Q4 Launch, invite sam@example.com
to the team, then upgrade to the Team plan."*

| # | kind | narration | ms | selector | box |
|---|---|---|---|---|---|
| 0 | click | Open the sign-in form. | 2050–3754 | `[data-testid="signin-link"]` | 76×39 |
| 1 | click | Sign in to the workspace. | 3985–5654 | `[data-testid="login-submit"]` | 79×34 |
| 2 | click | Start a new project. | 5745–7412 | `[data-testid="new-project"]` | 109×39 |
| 3 | type | Type the project name. | 7651–9480 | `[data-testid="project-name"]` | 794×38 |
| 4 | click | Click Create project. | 9618–11374 | `[data-testid="create-project"]` | 126×34 |
| 5 | click | Open the Team page. | 11483–13031 | `[data-testid="nav-team"]` | 53×33 |
| 6 | type | Type the teammate's email address. | 13104–14783 | `[data-testid="invite-email"]` | 794×38 |
| 7 | click | Send the invitation. | 14880–16343 | `[data-testid="invite-submit"]` | 107×34 |
| 8 | click | Open the Billing page. | 16424–17913 | `[data-testid="nav-billing"]` | 58×33 |
| 9 | click | Upgrade to the Team plan. | 17997–19474 | `[data-testid="upgrade-team"]` | 145×34 |
| 10 | wait | The flow is complete: sign in, create a project, invite a teammate and upgrade the plan. | 19551–20458 | — | — |

Artifacts:

| Artifact | Path | Size |
|---|---|---|
| Finished video (h264 1280×720 + AAC, 32.5 s) | `data/videos/dem_e4wqphjy.mp4` | 862 479 B |
| Poster frame | `data/videos/dem_e4wqphjy/poster.png` | ~140 KB |
| Burned captions | `data/videos/dem_e4wqphjy/captions.srt` | 11 blocks |
| Per-step screenshots | `data/screenshots/dem_e4wqphjy/0…10.png` | 11 files |
| Narration clips (WAV) | `data/videos/dem_e4wqphjy/tts/line-*.wav` | 11 files |
| Contact sheet for review | `data/exports/demo-sheet.png` | 101 129 B |
| Help-centre article (draft) | `art_5jllk08d` — "Sign in then create project" | 3 159 chars, 11 sections + signed screenshots |
| In-app guide (draft) | `gde_fwtko56x` — embed key `c521965e572be97cfb0dc4aa` | 10 resolvable steps |
| Product Graph flow | `flw_0ys3yw8z`, signature `617d4a55e9fa0a75` | 11 steps, 6 screens |
| Credits billed | 32.549 s → **0.542 credits** (1 min = 1 credit, 15 s minimum) | ledger row written |

## 5. Drift detection is real, not a demo flag

The smoke run finishes by re-checking the recorded flow. It comes back **stale** because the
flow's own last step upgrades the demo product to the Team plan — so on re-check the
`upgrade-team` button genuinely no longer exists. That is the Product Graph doing its job,
and it is the same behaviour Director's docs describe ("a live guide flags a step it can't
find").

## 6. Surfaces verified live

```
GET  /app/                    200, built dashboard bundle linked
GET  /g/guide.js              200, 10 236 bytes (3.91 KB gzip)
GET  /api/health              200 { version: "0.1.0", features: [environments, login-codes, graph, guides, mcp] }
GET  /api/guides/embed/<key>  200 with NO api key — 10 steps
GET  /api/articles            200 — draft with 3 159-char body
POST /api/mcp (initialize)    200 { serverInfo: { name: "reelforge", version: "0.1.0" }, protocolVersion: "2025-06-18" }
```

Also exercised by the team, with the documented envelopes: `401 UNAUTHORIZED`,
`400 TARGET_UNREACHABLE` (private address → `remediation.action=use_tunnel`),
`409 DOMAIN_AUTHORIZATION_REQUIRED`, `409 DESTRUCTIVE_ACTIONS_CONFIRMATION_REQUIRED`,
`429 CONCURRENCY_LIMIT_REACHED`, `403 FORBIDDEN` (bad signed token).

## 7. Known limitations (honest list)

1. **Planner coverage.** With no model key, the scripted planner understands a fixed
   grammar: sign in, open a page, create, invite, upgrade. Anything outside it degrades to a
   short hold rather than pretending. Setting `REELFORGE_LLM_API_KEY` switches on the
   reasoning planner (tested against a fake OpenAI-compatible endpoint for parse/repair and
   failure-fallback paths).
2. **Narration voice.** Offline Windows SAPI is intelligible but robotic compared with
   neural TTS. `edge-tts` (if installed) and OpenAI TTS are wired and preferred automatically
   when available.
3. **Passkeys cannot be replayed** — they are bound to origin *and* device. Same limitation
   Director documents.
4. **Cancellation is cooperative**: the queue marks the demo cancelled and the pipeline stops
   between phases, but an in-flight browser run is allowed to finish its current phase.
5. **No download / file-input / multi-tab flows**, and the demo product used for verification
   keeps its state in memory (one global), so two concurrent runs against the same demo site
   can race on plan state.
6. **Zendesk sync** is an adapter stub: endpoint shape matches, external call does not exist.
7. **Credits are modelled but not enforced** by default (`REELFORGE_ENFORCE_CREDITS=false`),
   because a self-hosted install shouldn't be blocked by its own billing.
