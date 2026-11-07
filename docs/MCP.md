# Reelforge MCP

Reelforge exposes its whole product surface over the **Model Context Protocol**, so an
agent can record a demo, poll it, collect the video, write documentation from the
resulting Product Graph, and publish it — without a human clicking through a dashboard.

Version `0.2.0` ships:

| Capability | Count | Transport |
|---|---|---|
| Tools | **39** | streamable HTTP **and** stdio (through the bridge) |
| Resources | 4 URI templates | streamable HTTP **and** stdio |
| Prompts | 4 templates | streamable HTTP **and** stdio |

The MCP server and the REST API are the *same implementation*: every tool calls the same
service function as its REST route, so the two surfaces cannot drift. See
[API.md](./API.md) for the REST contract and [ARCHITECTURE.md](./ARCHITECTURE.md) for the
pipeline behind a recording.

```
Streamable HTTP   POST http://127.0.0.1:4400/api/mcp      (stateless, X-API-Key)
stdio bridge      node packages/cli/src/mcp-stdio.ts --stdio
                  └─ speaks MCP on stdin/stdout to Claude Desktop
                  └─ speaks MCP over HTTP to http://127.0.0.1:4400/api/mcp
```

---

## 1. Connect a client

### Prerequisites

```bash
npm run seed          # creates the local workspace + key, prints data/dev-api-key.txt
npm run api           # API on http://127.0.0.1:4400  (REELFORGE_API_PORT to change)
```

The key in `data/dev-api-key.txt` looks like `rg_<32 hex>` and is sent as `X-API-Key`.
`GET /api/health` needs no key; every `/api/mcp` call does.

### Claude Code (streamable HTTP)

One line:

```bash
claude mcp add --transport http reelforge http://127.0.0.1:4400/api/mcp \
  --header "X-API-Key: rg_…your key…"
```

Or let the CLI write the project `.mcp.json` for you:

```bash
npm run cli -- mcp --api-key rg_… --agent claude-code
```

### Cursor (streamable HTTP)

`.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "reelforge": {
      "url": "http://127.0.0.1:4400/api/mcp",
      "headers": { "X-API-Key": "rg_…your key…" }
    }
  }
}
```

### Claude Desktop (stdio bridge)

Claude Desktop cannot open an HTTP MCP session, so point it at the local bridge. The
bridge is a normal Node script — no build step — and writes every diagnostic to **stderr**,
because **stdout belongs to the protocol**.

`claude_desktop_config.json`:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "reelforge": {
      "command": "node",
      "args": [
        "C:/Users/you/src/reelforge/packages/cli/src/mcp-stdio.ts",
        "--stdio"
      ],
      "env": {
        "REELFORGE_API_URL": "http://127.0.0.1:4400/api",
        "REELFORGE_API_KEY": "rg_…your key…"
      }
    }
  }
}
```

Use the **absolute** path to `mcp-stdio.ts` (Claude Desktop starts the process from its own
working directory). Node **25 or newer** runs the TypeScript directly; there is nothing to
compile. On Windows, forward slashes in the JSON path are fine.

Equivalent invocations of the same bridge:

```bash
# after the CLI alias (wired in packages/cli/src/index.ts)
npm run cli -- mcp-proxy --stdio --api-url http://127.0.0.1:4400/api --api-key rg_…

# or directly, always works
node packages/cli/src/mcp-stdio.ts --stdio \
  --api-url http://127.0.0.1:4400/api --api-key rg_…
```

Flags win over environment variables. Without `--stdio` the bridge refuses to start (it
would otherwise print protocol traffic to a terminal). On stdin close it shuts down with
exit code 0.

> **What the bridge forwards:** `initialize`, `tools/list`, `tools/call`, `resources/list`,
> `resources/read`, `prompts/list`, `prompts/get`. It intentionally returns the remote
> server's answers verbatim, including `isError` tool results. `resources/templates/list`
> and argument-completion requests are not bridged yet — use the HTTP transport (Claude
> Code, Cursor) if you need template enumeration; concrete resources still appear in
> `resources/list` over stdio.

### Environment variables

| Variable | Default | Used by |
|---|---|---|
| `REELFORGE_API_URL` | `http://127.0.0.1:4400/api` | CLI, stdio bridge |
| `REELFORGE_API_KEY` | — | CLI, stdio bridge |
| `REELFORGE_API_PORT` | `4400` | API server |

---

## 2. Resources

Resources are read-only JSON documents addressed by a stable URI. Every read returns
`mimeType: "application/json"`; the payload is the same view the matching tool returns,
so an agent can pull one object without a tool round-trip.

| URI template | Returns | Discovery |
|---|---|---|
| `reelforge://demos/{id}` | One demo: status, progress, signed `videoUrl`/`posterUrl`, outcome, failure, question, per-step narration timings | `resources/list` lists the 25 newest demos |
| `reelforge://flows/{id}` | One Product Graph flow with steps, screens and dependent articles/guides (staleness lives here) | `resources/list` lists up to 50 flows |
| `reelforge://articles/{id}` | One article with Markdown body, excerpt, status, published URL and stale flag | `resources/list` lists the 25 newest articles |
| `reelforge://guides/{embedKey}` | The exact public embed payload the widget walks: guide id, name, status, ordered steps (drafts included) | `resources/list` lists up to 50 guides |

Example (HTTP transport):

```bash
curl -s http://127.0.0.1:4400/api/mcp \
  -H "X-API-Key: $REELFORGE_API_KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"resources/read",
       "params":{"uri":"reelforge://demos/dem_e4wqphjy"}}'
```

---

## 3. Prompts

Prompts are named, parameterised playbooks. An MCP client surfaces them as slash-commands
(`/mcp__reelforge__record-demo`) or templates the model can select; each expands to a
system-style instruction that tells the model exactly which tools to call, in what order,
and when to ask for approval.

| Prompt | Arguments | What it drives |
|---|---|---|
| `record-demo` | `url` (required), `goal` (required) | Full recording loop: health → create_demo → poll/wait → answer questions → get_demo_video / transcript / share link |
| `write-article` | `flow_id` (required) | get_graph_flow → create_article_from_flow(help_center) → review → publish_article after approval |
| `fix-stale-flow` | `flow_id` (required) | Locate environment → reverify_flow → re-record with create_demo → regenerate articles/guides → summarise drift |
| `summarise-product` | `environment_id` (required) | get_environment + list_graph_flows + articles/guides/demos → operator summary with top three fixes |

Prompts are guidance, not side effects: calling one never records or publishes anything by
itself. They are the recommended entry point when a human is driving an agent
conversationally and you want a predictable tool order.

---

## 4. Tools

All tool arguments are **snake_case**; every result is JSON text. A failure is returned with
`isError: true` and a JSON body `{ "code", "message", "remediation": { "action", "hint" } }`
— the same envelope as the REST API.

### Demos

| Tool | What it does | Required args |
|---|---|---|
| `create_demo` | Start a narrated recording of a URL or saved product; returns `{id, status:"queued", pollAfterSeconds, environmentId}` | `instruction` + (`target_url` or `environment_id`) |
| `get_demo_status` | Non-blocking current state: progress, media links, outcome, failure, question | `demo_id` |
| `wait_for_demo` | Block until finished (or timeout) and return the same view | `demo_id` (`timeout_seconds` ≤180) |
| `answer_demo_question` | Answer a pre-recording planner question so the run continues | `demo_id`, `option_id` |
| `get_demo_transcript` | Raw narration lines with `startMs`/`durationMs` | `demo_id` |
| `cancel_demo` | Cancel a queued/running demo | `demo_id` |
| `list_demos` | Recent demos, newest first (≤100) | — |
| `batch_create_demos` | Queue 1–10 demos in one call; per-item errors do not abort the batch | `requests[]` |

### Artifacts, sharing and outputs

| Tool | What it does | Required args |
|---|---|---|
| `get_demo_video` | Finished MP4/poster/SRT signed URLs, duration, billed credits, `ready` flag | `demo_id` |
| `get_transcript_markdown` | Narration as paste-ready Markdown with timestamps and video link | `demo_id` |
| `list_outputs` | Every finished artifact this workspace owns, plus GIF/VTT exports | — (`limit`, `demo_id` optional) |
| `share_demo_link` | Public 30-day, no-API-key share page for a demo | `demo_id` |

### Environments

| Tool | What it does | Required args |
|---|---|---|
| `create_environment` | Save a product (name, base URL, sign-in mode) for future demos | `name`, `base_url` |
| `list_environments` | Every saved product with base URL, sign-in mode, session state | — |
| `get_environment` | One product plus its screens and stored-session state | `environment_id` |
| `verify_environment` | Structural check that a stored sign-in is present (no browser) | `environment_id` |

### Product Graph

| Tool | What it does | Required args |
|---|---|---|
| `list_graph_flows` | Every flow with status, step count, dependent article/guide counts | `environment_id` |
| `get_graph_flow` | One flow with steps, screens, articles and guides | `environment_id`, `flow_id` |
| `reverify_flow` | Re-check a flow against the live product without recording; marks it stale | `environment_id`, `flow_id` |

### Domains

| Tool | What it does | Required args |
|---|---|---|
| `attest_domain` | Confirm once that a host may be recorded (clears `DOMAIN_AUTHORIZATION_REQUIRED`) | `host` |
| `list_domains` | Attested/verified domains with timestamps | — |

### Articles

| Tool | What it does | Required args |
|---|---|---|
| `create_article_from_flow` | Generate a step-by-step article from a flow (`help_center` or `internal_training`) | `flow_id`, `channel` |
| `list_articles` | Articles, filterable by channel/status | — |
| `get_article` | One article with body, excerpt, status, stale flag | `article_id` |
| `update_article` | Edit title/excerpt/body/channel/status | `article_id` |
| `publish_article` | Publish (and record the public URL) | `article_id` |
| `unpublish_article` | Move a published article back to draft | `article_id` |

### Guides

| Tool | What it does | Required args |
|---|---|---|
| `list_guides` | In-app guides with embed keys, status and step counts | — |
| `get_guide` | One guide with ordered steps and report count | `guide_id` |
| `publish_guide` | Make a draft guide live on customer pages | `guide_id` |
| `unpublish_guide` | Move a live guide back to draft | `guide_id` |

### Ops and meta

| Tool | What it does | Required args |
|---|---|---|
| `health` | API version/features, worker state, active LLM + TTS providers, queue depth | — |
| `get_usage` | Current-month credits, remaining free seconds, plan limits | — |
| `get_workspace` | Workspace identity, plan limits, lifetime counters | — |
| `list_recording_presets` | Saved presets plus supported narration voices | — |
| `get_default_preset` | The default recording preset | — |
| `list_integrations` | Helpdesk/chat/webhook integrations and configured flags | — |
| `list_api_keys` | Key prefixes and last-used times (plaintext never returned) | — |
| `create_login_code` | Single-use `DIR-XXXX-XXXX-XXXX` code for `reelforge session` | `environment_id` |

---

## 5. A worked session

Task: *"Record a demo of signing up, then publish a help article about it."*

Below is the MCP traffic an agent generates (HTTP transport, results trimmed). The demo
site used here is `apps/demo-site` on `http://127.0.0.1:4402`; the API is on `:4400`.

**1. Check the instance is ready to record.**

```json
→ tools/call { "name": "health", "arguments": {} }
← {
    "service": "reelforge", "version": "0.2.0",
    "worker": { "running": true, "concurrency": 3, "active": [] },
    "queue": { "queued": 0, "running": 0 },
    "providers": {
      "llm": { "providerId": "none", "model": null, "source": "none", "configured": [] },
      "tts": { "providerId": "sapi", "voice": null, "source": "env", "offline": ["sapi", "edge", "none"] }
    }
  }
```

`worker.running: true` means the recorder is live; `tts.providerId: "sapi"` means narration
works offline. No key is required for the scripted planner + local TTS path.

**2. Start the recording.**

```json
→ tools/call {
    "name": "create_demo",
    "arguments": {
      "instruction": "Sign up for a new account, then create a project called Q4 Launch.",
      "target_url": "http://127.0.0.1:4402/signup",
      "language": "en",
      "fps": 30,
      "max_steps": 30,
      "authorized": true
    }
  }
← { "id": "dem_e4wqphjy", "status": "queued", "pollAfterSeconds": 3,
    "environmentId": "env_ukauuy5d" }
```

`authorized: true` is required once per public host; loopback targets (`127.0.0.1`) do not
need it.

**3. Wait for it to finish.**

```json
→ tools/call { "name": "wait_for_demo", "arguments": { "demo_id": "dem_e4wqphjy" } }
← {
    "id": "dem_e4wqphjy", "status": "complete", "progress": 1,
    "duration_ms": 32549, "credits_used": 0.543,
    "videoUrl": "http://127.0.0.1:4400/api/files/eyJwIjoidmlkZW9z…",
    "outcome": { "goalMet": true, "stepsCompleted": 9,
                 "whatWasShown": ["Open the signup page", "Fill in name and email", "…"] },
    "failure": null, "question": null, "pollAfterSeconds": null
  }
```

If the run asks a question instead, the agent calls `answer_demo_question` with one of
`question.options[].id`; if it fails, `failure.remediation` says what to fix.

**4. Collect the artifacts.**

```json
→ tools/call { "name": "get_demo_video", "arguments": { "demo_id": "dem_e4wqphjy" } }
← { "ready": true, "videoUrl": "http://127.0.0.1:4400/api/files/…",
    "posterUrl": "http://127.0.0.1:4400/api/files/…", "srtUrl": "http://127.0.0.1:4400/api/files/…",
    "durationSeconds": 32.5, "creditsUsed": 0.543, "expiresInSeconds": 3600 }

→ tools/call { "name": "share_demo_link", "arguments": { "demo_id": "dem_e4wqphjy" } }
← { "url": "http://127.0.0.1:4400/api/share/eyJkIjoiZGVtX2U0d3FwaGp5Iiwi…",
    "expiresAt": "2026-12-07T07:54:27.889Z", "ttlDays": 30 }
```

**5. Find the flow the recording created.**

```json
→ tools/call { "name": "list_environments", "arguments": {} }
← [ { "id": "env_ukauuy5d", "name": "127.0.0.1", "baseUrl": "http://127.0.0.1:4402/", … } ]

→ tools/call { "name": "list_graph_flows", "arguments": { "environment_id": "env_ukauuy5d" } }
← [ { "id": "flw_0ys3yw8z", "name": "Sign in then create project", "status": "fresh",
      "stepCount": 11, "articleCount": 0, "guideCount": 0, … } ]
```

**6. Write and publish the help-centre article.**

```json
→ tools/call { "name": "create_article_from_flow",
               "arguments": { "flow_id": "flw_0ys3yw8z", "channel": "help_center" } }
← { "id": "art_5jllk08d", "title": "Sign in then create project",
    "status": "draft", "stale": false, "body_md": "## Overview\n…", … }

→ tools/call { "name": "publish_article", "arguments": { "article_id": "art_5jllk08d" } }
← { "id": "art_5jllk08d", "status": "published",
    "published_url": "http://127.0.0.1:4401/#/articles/sign-in-then-create-project" }
```

The agent reports: demo `dem_e4wqphjy` (32.5s, 0.543 credits, video + 30-day share link),
flow `flw_0ys3yw8z` (fresh, 11 steps), article `art_5jllk08d` published. Nothing was
invented — every id and URL came from a tool result.

> **Prompt equivalent.** The same run is available as the `record-demo` and `write-article`
> prompts, or as one `summarise-product` call once the flow exists.

---

## 6. Error contract

Every failed `tools/call` returns:

```json
{
  "content": [ { "type": "text", "text": "{\n  \"code\": \"DOMAIN_AUTHORIZATION_REQUIRED\",\n  \"message\": \"You must confirm once that you may record app.example.com.\",\n  \"remediation\": { \"action\": \"attest_domain\", \"hint\": \"…\" }\n}" } ],
  "isError": true
}
```

An agent should read `code` and `remediation.action` and act on it:

| Code | Remediation |
|---|---|
| `VALIDATION_ERROR` | Fix arguments (`remediation.hint` names the field). |
| `DOMAIN_AUTHORIZATION_REQUIRED` | Re-send with `authorized: true`, or call `attest_domain`. |
| `DESTRUCTIVE_ACTIONS_CONFIRMATION_REQUIRED` | Re-send with `confirm_destructive: true` after operator approval. |
| `TARGET_UNREACHABLE` | Local/private target: record a public tunnel URL instead. |
| `ENVIRONMENT_SESSION_EXPIRED` | Capture a fresh session with `reelforge session` + `create_login_code`. |
| `CONCURRENCY_LIMIT_REACHED` | Wait for a running demo to finish, then retry. |
| `INSUFFICIENT_CREDITS` | Only when enforcement is on (`REELFORGE_ENFORCE_CREDITS=true`). |
| `NOT_FOUND` | Wrong id for this workspace; list the resource again. |

---

## 7. Manual verification

With the API on `:4400`:

```bash
KEY=$(cat data/dev-api-key.txt)

# initialize
curl -s http://127.0.0.1:4400/api/mcp \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# tool count (expect 39)
curl -s http://127.0.0.1:4400/api/mcp \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.tools.length))'

# one tool call
curl -s http://127.0.0.1:4400/api/mcp \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"health","arguments":{}}}'
```

The same calls over stdio: pipe newline-delimited JSON-RPC into
`node packages/cli/src/mcp-stdio.ts --stdio` and read newline-delimited responses from
stdout (stderr carries diagnostics only).

---

## 8. Design notes

- **Stateless HTTP.** `POST /api/mcp` builds a fresh `McpServer` per request with
  `sessionIdGenerator: undefined`. Any number of API replicas can sit behind a load
  balancer; there are no sticky sessions and no server-side MCP session store.
- **No REST/MCP drift.** Tools are thin wrappers over `packages/api/src/services/*`; the
  route handlers call the same functions.
- **Secrets stay server-side.** Tool results never contain environment credentials or
  provider keys. Media URLs are HMAC-signed for one hour; share links are a separate
  30-day claim and are explicitly public.
- **Offline by default.** `health` shows which TTS provider is active. With no keys at all,
  narration falls back to Windows SAPI (or edge-tts) and the planner falls back to its
  deterministic scripted mode, so every tool above still works on a laptop.
