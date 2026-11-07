# Reelforge v0.2.0 — bring your own model, or run fully local

The release that turns Reelforge from a working demo agent into something you can
hand to someone else.

## Highlights

### Bring your own key (BYOK)
One OpenAI-compatible planner now drives against **GMI Cloud, OpenAI, OpenRouter,
Groq, Together, Fireworks, DeepSeek, a local Ollama, LM Studio, or any custom
gateway**. Configure with an env var or paste a key in the dashboard — keys are
stored AES-256-GCM encrypted, scoped to the workspace, and never returned by the API
(only a masked hint). Model lists are discovered live from the provider.

### Run fully local
No keys at all still works: the offline scripted planner drives the browser and
Windows SAPI (or `edge-tts`) narrates. Zero network calls, zero accounts, zero cost.

### MCP, both transports
- `POST /api/mcp` — streamable HTTP, 39+ tools, resources and prompts.
- `reelforge mcp-proxy --stdio` — bridges stdio-only clients (Claude Desktop) to
  the same server.

### More outputs from one recording
- **Public share pages** — send a prospect a video page that needs no account.
- **GIF previews** — 3.5 s loop around the most interesting action.
- **WebVTT captions** alongside the burned-in SRT.
- **Webhooks** — HMAC-signed JSON on completion or failure; paste a Slack incoming
  webhook and it just works.

### Ship it
- Multi-stage **Dockerfile** on the Playwright base image (browsers included).
- **docker-compose** with a data volume and an optional local Ollama service.
- **GitHub Actions**: typecheck, builds, render self-test, end-to-end smoke on
  Node 22 and 24; GHCR image on tag.

## Verification

`npm run smoke` — 23/23 checks against a real recording (see docs/VERIFICATION.md).
New in this release: provider resolution and encrypted key round-trip (self-test),
53/53 live checks for webhooks/share/exports, and the dashboard suite extended to
cover the provider cards, exports and webhook form.

## Upgrade notes

- `workspace_settings` is created on first boot of an existing database — no
  migration step needed.
- `REELFORGE_PUBLIC_URL` now matters for share links and webhook media URLs: set it
  to the externally reachable origin when deploying behind a proxy.
- Credits remain enforced off by default (`REELFORGE_ENFORCE_CREDITS=true` to enable).

## Known limitations

- The offline planner covers a fixed grammar (sign in, navigate, create, invite,
  upgrade); open-ended instructions need a model key.
- Passkeys cannot be replayed — origin and device bound, same as every recorder.
- Cancellation is cooperative: an in-flight browser phase finishes before stopping.
