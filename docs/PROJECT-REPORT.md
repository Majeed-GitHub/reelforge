# Reelforge — project report

**An open-source, self-hosted reimplementation of an AI product-demo agent**

Shaik Majeed · 2026 · MIT licensed
Developed with the **DeepSeek Harness**, using the **GMI Cloud API**.
Source: `github.com/YOUR_GITHUB_USER/reelforge`

---

## Abstract

Commercial "demo agents" such as Screenforge Director turn a URL and one sentence into a
narrated product demo video, a help-centre article and an in-app guide, all derived from a
single structured map of the product. This project reverse-engineers that system from its
public documentation, its documented REST/MCP contract and its published npm client, and
reimplements it end to end as **Reelforge**: an MIT-licensed, self-hosted system that runs
with **no cloud account at all** — a local browser, bundled ffmpeg and Windows speech
synthesis — and upgrades to any OpenAI-compatible model by pasting a key. The system
records an eleven-step demo in a real Chromium session, renders a 32.5-second narrated MP4
with auto-zoom and burned captions, and publishes a Product Graph flow, a 3 159-character
help article and a 10-step embeddable guide from that one capture. It exposes 40+ REST
endpoints and 39 MCP tools over two transports, and ships as a Docker image with CI.

## 1. Introduction

Product demos are produced three times over in a typical release: marketing records a video,
support screenshots every step, and onboarding writes a walkthrough. All three describe the
same flow and all three rot at the next deploy.

Director's insight — visible on its public site — is to keep **one persistent map** of the
product (screens, flows, controls) and render every output as a *view* of that map. The
map is extended by recording, and re-checked against the live product to detect drift.

Reelforge reproduces that architecture and answers a question the hosted product cannot:
*can this be done open-source, offline, and with the user's own model?* The answer is yes,
and the engineering is in the three pipelines: browser automation, video rendering, and
graph/agent plumbing.

## 2. Background: what was reverse-engineered

Three sources of ground truth were used, in increasing order of fidelity:

1. **The public site** — a 13-route sitemap documenting the product surface, and a
   `/developers` page publishing the complete REST contract: field-by-field request and
   response shapes, seven stable error codes, 20 endpoints and the MCP tool list.
2. **Runtime probes** — `GET /api/demos` returns `401` with an empty body, confirming a real,
   key-gated API rather than a marketing mockup.
3. **The published npm client** — `@screenforge/director-cli@0.1.8`, unpacked and read. This
   was decisive: it revealed the `{code, message, data}` envelope with `NOT_FOUND*` codes,
   a `/health` endpoint returning `{version, features: [...]}` used for feature gating,
   single-use `DIR-XXXX-XXXX-XXXX` login codes with a 30-minute expiry, and — most
   importantly — that session capture uploads a Playwright `storageState` **including
   IndexedDB**, which is why Firebase/Supabase-style apps survive the capture.

What is not observable — the planner, the Product Graph matching rules, the render pipeline —
was rebuilt from first principles. Section 5 describes those choices.

## 3. System architecture

```
URL + one sentence
      │
      ▼
 Chromium (Playwright) ──► recorded run ──► MP4 (zoom · cursor · captions · voice)
      │                        │
      │                        └──► Product Graph (screens · flows · controls)
      │                                   ├──► help-centre article
      │                                   ├──► internal training doc
      │                                   ├──► in-app guide (embed script)
      │                                   └──► GIF · share page · webhook
      ▼
 REST API (40+) + MCP (39 tools, HTTP + stdio) + dashboard
```

Six packages with one shared domain contract (`packages/core`), so a schema change becomes
a compile error rather than a blank table:

| Package | Responsibility |
|---|---|
| `core` | Domain types, SQLite schema, credits, flow signatures, article templates |
| `agent` | Playwright runner, injected cursor overlay, observers, LLM + offline planners |
| `render` | TTS, captions, auto-zoom timeline, single-pass ffmpeg render |
| `api` | REST, MCP server, in-process worker, Product Graph |
| `web` / `guide` | React dashboard; dependency-free embeddable guide widget |
| `cli` | Session capture, MCP wiring, stdio bridge, diagnostics |

## 4. Methodology

Development used the DeepSeek Harness with the GMI Cloud API as the model backend, and a
deliberate parallel-work discipline: five independent workstreams (browser agent, renderer,
API, dashboard, packaging) with disjoint write scopes, a frozen interface contract, and an
integration pass owned by one agent. The contract-first approach is what allowed the
pipeline to be assembled without merge conflicts.

The offline planner was built early and on purpose, so that CI and every test suite could
run with **no credentials and no network**, and so that the system's behaviour is
reproducible by a reviewer.

## 5. Key implementation decisions

**Cursor without compositing.** Playwright's recording contains no pointer. Rather than
compositing a cursor in ffmpeg — frame-exact, expensive, and prone to drift — the pointer is
injected *into the page* with `addInitScript`: a DOM element follows `mousemove`, so every
`page.mouse.move(x, y, { steps: n })` produces real eased motion in the recorded pixels, and
`mousedown` spawns a ripple. Nothing needs to be kept in sync because the cursor is *in* the
capture.

**Auto-zoom as a generated filter program.** Each step records the element's bounding box and
millisecond timing. The renderer derives keyframes `(t, cx, cy, zoom)`, eases between them,
clamps the camera to the viewport, and emits an ffmpeg filter program to a file
(`-filter_complex_script`) rather than a giant quoted argument — the Windows-safe path.

**One flow, deduplicated by signature.** A flow's identity is
`sha256(kind:label > kind:label > …)`, so re-recording the same route updates one flow
instead of creating a duplicate. Re-checking re-resolves each recorded selector and marks
the flow stale — which, in testing, correctly flagged a flow whose final step had upgraded
the demo product and thereby removed the very button it clicked.

**Bring your own key, or nothing at all.** Every inference provider now exposes
`POST {baseUrl}/chat/completions`, so one planner covers GMI Cloud, OpenAI, OpenRouter,
Groq, Together, Fireworks, DeepSeek, a local Ollama, LM Studio, or a custom gateway.
Resolution order is env → workspace → none, where "none" selects the offline scripted
planner. Workspace keys are sealed with AES-256-GCM before they reach SQLite and are only
ever returned as a hint.

## 6. Results

All figures below are from executed runs on Windows 11 / Node 25.8, with **no API keys**.

| Metric | Result |
|---|---|
| End-to-end pipeline | **23/23** checks, exit 0 |
| Recorded demo | 11 steps; 850 059-byte MP4, h264 1280×720 + AAC, 32.5 s |
| Each step recorded | box, click point, stable selector, accessible name, screenshot, narration |
| Product Graph | 1 flow (signature `617d4a55e9fa0a75`), 6 screens |
| Article generated | 3 159 characters, 11 sections, signed screenshots |
| Guide generated | 10 resolvable steps, public embed key |
| Metering | 0.542 credits for 32.549 s (1 credit = 1 finished minute, 15 s minimum) |
| Provider layer | 48-check self-test: precedence, encryption round-trip, typed failures |
| Outputs (webhooks/share/GIF/VTT) | 53/53 live checks, including HMAC re-verification |
| MCP | 39 tools, 20/20 over HTTP, 7/7 through the stdio bridge |
| Dashboard | 22 + 18 browser checks, zero page errors |
| Type safety | `tsc --noEmit` clean across six packages |
| Dependencies | `npm audit --omit=dev` → **0** vulnerabilities |
| Packaging | `docker build` → running container, `/api/health` v0.2.0, `/app/` 200 |

## 7. Limitations

1. The offline planner covers a fixed grammar (sign in, navigate, create, invite, upgrade);
   open-ended instructions require a model key. This is a deliberate trade for reproducibility.
2. Passkey replay is impossible — WebAuthn credentials are bound to origin *and* device.
   Director documents the same limitation.
3. Cancellation is cooperative: the queue stops between pipeline phases, so an in-flight
   browser phase completes first.
4. Downloads, file inputs and multi-tab flows are not handled.
5. Multi-tenant BYOK needs the workspace id threaded through the worker; the resolver
   deliberately refuses to guess when more than one workspace exists.

## 8. Conclusion

The experiment shows that a commercial demo agent's architecture is reproducible from
public artefacts alone, and that the expensive parts — a real browser, a video encoder, a
speech synthesiser — are already available offline. What remains genuinely model-dependent
is the planner: the same system is either a deterministic flow recorder or an open-ended
agent depending on whether a key is present. Publishing it under MIT with a one-command
Docker image makes the approach reviewable and forkable.

## 9. References

1. Screenforge Director — product site and developer reference, <https://director.screenforge.co> (accessed 2026).
2. `@screenforge/director-cli` v0.1.8 — npm registry tarball, unpacked for protocol analysis.
3. Playwright — browser automation and video recording, <https://playwright.dev>.
4. FFmpeg — filtering, subtitles, palette-quantised GIF export, <https://ffmpeg.org>.
5. Model Context Protocol — specification and TypeScript SDK, <https://modelcontextprotocol.io>.
6. K. Beck, *Test-Driven Development: By Example*, Addison-Wesley, 2002 — applied here as
   "the offline planner exists so the pipeline can be tested without credentials".
