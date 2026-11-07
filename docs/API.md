# Reelforge API & MCP reference

Reelforge reproduces Screenforge Director's public contract: same base path, same
`{message, data}` success envelope, same `{code, message, remediation}` failure
envelope, same polling model, and the same seven documented error codes.

```
Base URL    http://127.0.0.1:4400/api          (REELFORGE_API_PORT)
Auth        X-API-Key: rg_…                    or: Authorization: Bearer rg_…
MCP         POST http://127.0.0.1:4400/api/mcp  (streamable HTTP, same key or OAuth-free)
```

```json
{ "message": "OK", "data": { } }
{ "code": "TARGET_UNREACHABLE", "message": "…", "remediation": { "action": "use_tunnel", "hint": "…" } }
```

## Errors

| Code | Status | What to do |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Fix the request body (zod issues are in `remediation`). |
| `INVALID_INSTRUCTION` | 400 | Instruction must be 3–2000 characters. |
| `TARGET_UNREACHABLE` | 400 | The URL is local/private. Record it through a tunnel, or set `REELFORGE_BLOCK_LOCAL=false`. |
| `UNAUTHORIZED` | 401 | Missing/invalid API key. |
| `DOMAIN_BLOCKED` | 403 | This host is not allowed. |
| `NOT_FOUND` | 404 | No such resource in your workspace. |
| `DOMAIN_AUTHORIZATION_REQUIRED` | 409 | New public host: send `authorized: true` once you've confirmed you may demo it. |
| `DESTRUCTIVE_ACTIONS_CONFIRMATION_REQUIRED` | 409 | The plan includes a step like deleting. Send `confirmDestructive: true`. |
| `ENVIRONMENT_SESSION_EXPIRED` | 409 | The saved sign-in no longer works. Capture a new session. |
| `INSUFFICIENT_CREDITS` | 402 | Out of minutes (only when `REELFORGE_ENFORCE_CREDITS=true`). |
| `CONCURRENCY_LIMIT_REACHED` | 429 | Demos are all running; retry when one finishes. |

## Record a demo

```bash
curl -X POST http://127.0.0.1:4400/api/demos \
  -H "X-API-Key: $REELFORGE_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "target": { "type": "url", "url": "http://127.0.0.1:4402" },
    "instruction": "Sign in, create a project called Q4 Launch, invite sam@example.com, then upgrade to Team.",
    "authorized": true,
    "options": { "language": "en", "fps": 30, "maxSteps": 30, "scaleHeight": 720, "watermark": true, "zoom": 1.6 }
  }'
# → { "data": { "id": "dem_…", "status": "queued", "pollAfterSeconds": 3 } }
```

Poll:

```bash
curl http://127.0.0.1:4400/api/demos/$DEMO_ID -H "X-API-Key: $REELFORGE_API_KEY"
```

```json
{
  "data": {
    "id": "dem_…", "status": "complete", "progress": 1,
    "videoUrl": "/api/files/<signed>", "posterUrl": "/api/files/<signed>",
    "durationMs": 41300, "creditsUsed": 0.689,
    "outcome": { "goalMet": true, "stepsCompleted": 9, "whatWasShown": ["…"] },
    "failure": null, "question": null, "pollAfterSeconds": null
  }
}
```

### `POST /demos` fields

| Field | Type | Notes |
|---|---|---|
| `instruction` | string 3–2000 | Required. Plain language; the planner resolves steps. |
| `target` | `{ type: "url" \| "tunnel", url }` | Required unless `environmentId` is given. |
| `environmentId` | id | Saved product: stored sign-in + joins that product's Product Graph. |
| `path` | string | Page to start on, resolved against the environment base URL. |
| `credentials` | `{ username, password }` | Test account for this run only (encrypted, deleted after use). |
| `authorized` | boolean | Confirms you own / may demo the host. Needed once per public host. |
| `confirmDestructive` | boolean | Allows delete/revoke style steps. |
| `options.language` | locale | Narration + captions language (`en`, `es`, `hi`, …). |
| `options.fps` | 1–60 | Default 30. |
| `options.scaleHeight` | 120–2160 | Output height; width follows 16:9. |
| `options.maxSteps` | 1–60 | Step budget. Default 40. |
| `options.watermark` | boolean | Default true. |
| `options.zoom` | 1.0–2.5 | Auto-zoom strength. Default 1.6. |
| `options.presetId` | id | Saved recording preset. |

### `GET /demos/:id`

| Field | Holds |
|---|---|
| `status` | `queued` · `running` · `complete` · `failed` · `cancelled` |
| `progress` | 0–1 |
| `pollAfterSeconds` | Wait this long before asking again; `null` when finished. |
| `videoUrl` / `posterUrl` / `srtUrl` | Signed links, valid for one hour. Re-read the demo for fresh ones. |
| `durationMs`, `creditsUsed` | Finished length and billed credits. |
| `outcome` | `goalMet`, `stepsCompleted`, `whatWasShown`, `stoppedBefore?` |
| `failure` | `{ code, message, remediation }` — actionable by an agent. |
| `question` | `{ id, prompt, options[] }` when the planner needs a choice before recording. |

## Every endpoint

| Method & path | Purpose |
|---|---|
| `GET /health` | `{ version, features }` — used by the CLI to feature-gate. **No auth.** |
| `POST /demos` | Start a demo. |
| `GET /demos/:id` | Status, progress, media links, verdict, failure, question. |
| `GET /demos/:id/transcript` | Narration line by line with timestamps, once complete. |
| `POST /demos/:id/question/answer` | `{ optionId }` |
| `POST /demos/:id/cancel` | Cancel a queued/running demo. |
| `GET /demos?limit=` | Recent demos (≤100). |
| `POST /environments` | Save a product: `{ name, baseUrl, signInMode: "none"\|"password"\|"session" }`. |
| `GET /environments` · `GET /environments/:id` · `PATCH /environments/:id` | Manage saved products. |
| `POST /environments/:id/session` | Attach a Playwright `storageState` (cookies + localStorage + IndexedDB). Stored encrypted. |
| `POST /environments/:id/verify` | Check the stored sign-in still exists and looks valid. |
| `POST /environments/:id/login-code` | Mint a single-use `DIR-XXXX-XXXX-XXXX` code (30 min) for `reelforge session`. |
| `POST /environments/by-code/:code` | **No auth.** Resolve a login code → `{ environmentId, name, baseUrl }`. |
| `POST /environments/by-code/:code/session` | **No auth.** Upload the captured session for that code. |
| `POST /domains/attest` | Confirm once that you may record a host. |
| `GET /domains` · `POST /domains/verification` · `POST /domains/verification/check` | DNS/file proof of domain control. |
| `GET /environments/:id/graph/flows` | Every flow in the Product Graph with status. |
| `GET /environments/:id/graph/flows/:flowId` | One flow: steps, screens, controls. |
| `POST /environments/:id/graph/flows/:flowId/reverify` | Re-check against the live product without recording. Marks stale. |
| `POST /articles/from-flow` | `{ flowId, channel: "help_center" \| "internal_training" }` |
| `GET /articles` · `GET /articles/:id` · `PATCH /articles/:id` | Manage articles. |
| `POST /articles/:id/publish` · `POST /articles/:id/unpublish` | Draft ↔ published. |
| `GET /guides` · `GET /guides/:id` · `POST /guides/:id/publish` | In-app guides. |
| `GET /guides/embed/:embedKey` | **No auth.** Payload the embed widget walks. |
| `POST /guides/:id/report` | **No auth.** Widget reports skipped steps. |
| `GET /presets` · `GET /presets/voices` · `POST /presets` | Recording presets + narration voices. |
| `GET /api-keys` · `POST /api-keys` · `DELETE /api-keys/:id` | Key management. Plaintext returned once. |
| `GET /files/:token` | Signed, expiring media (videos, posters, screenshots, SRT). |
| `POST /mcp` | MCP server (streamable HTTP). |

## MCP tools

Same implementation, two transports. Snake_case args, JSON results.

**Demos** `create_demo` · `get_demo_status` · `wait_for_demo` (≤3 min) · `answer_demo_question` ·
`get_demo_transcript` · `cancel_demo` · `list_demos`

**Environments** `create_environment` · `list_environments` · `get_environment` · `update_environment` ·
`verify_environment` · `create_login_code`

**Product Graph** `list_graph_flows` · `get_graph_flow` · `reverify_flow`

**Domains** `attest_domain` · `list_domains` · `start_domain_verification` · `check_domain_verification`

**Articles** `create_article_from_flow` · `list_articles` · `get_article` · `update_article` ·
`publish_article` · `unpublish_article`

**Presets / integrations** `list_recording_presets` · `create_recording_preset` · `list_integrations`

### Wire it into an agent

```bash
npm run cli -- mcp --api-key rg_… --agent claude-code
# writes .mcp.json: { "mcpServers": { "reelforge": { "type": "http", "url": "…/api/mcp", "headers": { "X-API-Key": "rg_…" } } } }
```

or in Claude Code directly:

```bash
claude mcp add --transport http reelforge http://127.0.0.1:4400/api/mcp --header "X-API-Key: rg_…"
```

## CLI

```bash
npm run cli -- doctor                     # node, chromium, API, key
npm run cli -- init                       # install Playwright Chromium
npm run cli -- session DIR-XXXX-XXXX-XXXX # capture an SSO/2FA sign-in, upload the session
npm run cli -- mcp --api-key rg_…         # wire MCP into Claude Code / Cursor
```

`session` is the only flow an API key can't cover: log into your own product in a real
browser, press Enter, and the resulting `storageState` (cookies, localStorage, **IndexedDB**)
is uploaded encrypted. Reelforge replays it in its own browser, so demos of products behind
SSO/MFA work without ever holding your password.

## Billing model (parity)

1 credit = 1 minute of **finished** video, billed by the second to 3 decimals, with a 15-second
minimum for any demo that produces video. A 45-second demo is `0.75` credits. Articles,
environments, lookups and re-checks are free. Enforcement is off by default when self-hosting
(`REELFORGE_ENFORCE_CREDITS=true` turns it on).
---

# v0.2 additions

Four new surface areas. All use the same envelope and error codes above.

## Bring your own key (`/api/providers`)

| Method & path | Purpose |
|---|---|
| `GET /api/providers` | Catalog + live state: which LLM and TTS provider is active, where it came from (`env` / `workspace` / `none`), a masked key hint, the model. Never returns a key. |
| `POST /api/providers` | Set the provider for this workspace. Body `{ llm?: { providerId, apiKey?, model?, baseUrl? }, tts?: { providerId, voice? } }`. Sending `providerId: "none"` clears the override; omitting `apiKey` keeps the stored one; `apiKey: ""` clears just the key. |
| `DELETE /api/providers` | Clear the workspace override (env still wins). |
| `GET /api/providers/models?provider=gmi` | Live model discovery from the provider's `/models`. Always 200; `source: "live" \| "default"`. |
| `POST /api/providers/test` | One real round trip. `{ ok, latencyMs, model, error }` — a provider-side failure is 200 with `ok:false`, never a 500. |

Keys posted here are sealed with AES-256-GCM before they reach SQLite, scoped to the
workspace, and only ever returned as a hint like `sk-…4f2a`.

```bash
curl -X POST http://127.0.0.1:4400/api/providers \
  -H "X-API-Key: $REELFORGE_API_KEY" -H 'content-type: application/json' \
  -d '{"llm":{"providerId":"gmi","apiKey":"...","model":"vendor/model"}}'
```

## Outputs: exports, share pages, webhooks

| Method & path | Purpose |
|---|---|
| `POST /api/demos/:id/exports` | `{ kind: "gif" \| "vtt" }` → `{ id, kind, status }`. Async; unsupported kind is a 501 envelope, not a 500. |
| `GET /api/demos/:id/exports` | `{ exports: [{ id, kind, status, url, bytes }] }`, `url` is a signed `/api/files/…` path. |
| `GET /api/demos/:id/share` | `{ url, expiresAt }` — a 30-day public link. |
| `GET /api/share/:token` | **No auth.** Self-contained HTML page: poster, signed `<video>`, instruction as title, duration, goal-met summary, article link. Expired token renders a 404 page, not JSON. |
| `GET /api/webhooks` | `{ url, hasSecret, lastDelivery }` |
| `POST /api/webhooks` | `{ url, secret? }`. Omitted secret keeps the stored one; `null` clears it. |
| `DELETE /api/webhooks` | Remove the endpoint. |
| `POST /api/webhooks/test` | `{ delivered, status, latencyMs }` — sends a synthetic event now. |

Webhook deliveries carry `X-Reelforge-Event` and, when a secret is set,
`X-Reelforge-Signature: sha256=<HMAC-SHA256 of the raw body>`:

```json
{
  "event": "demo.complete",
  "timestamp": "2026-11-07T07:12:44.101Z",
  "demo": { "id": "dem_…", "status": "complete", "durationMs": 32549, "creditsUsed": 0.542,
            "videoUrl": "…", "posterUrl": "…", "outcome": { "goalMet": true, "stepsCompleted": 11 } },
  "flow": { "id": "flw_…", "name": "Sign in then create project", "steps": 11 },
  "article": { "id": "art_…" },
  "guide": { "embedKey": "…" }
}
```

An endpoint on `hooks.slack.com` receives `{ text, blocks }` instead, so a Slack
incoming webhook works by pasting the URL. Delivery has a 5 s timeout and one retry;
failures never affect the demo. See [OUTPUTS.md](OUTPUTS.md).

## MCP transports

| Transport | Where | Client |
|---|---|---|
| Streamable HTTP | `POST /api/mcp` | Claude Code, Cursor, anything that speaks remote MCP |
| stdio bridge | `node packages/cli/src/mcp-stdio.ts --stdio` | Claude Desktop and other stdio-only clients |

Both expose the same tools, resources and prompts.
