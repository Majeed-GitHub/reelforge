# Editor plugins

Reelforge is usable from **Claude Code**, **OpenCode** and **DeepSeek Harness** without
cloning the repository into your agent or hand-writing MCP config: each folder under
[`plugins/`](../plugins) is a handful of small text files (< 10 KB each) that point the
agent at the Reelforge MCP endpoint.

| Host | What you get | Install | Env vars | Say this to the agent |
|---|---|---|---|---|
| **Claude Code** | `.claude-plugin/plugin.json` manifest + 3 slash commands (`/record-demo`, `/publish-article`, `/demo-status`) + MCP over streamable HTTP | `claude --plugin-dir <repo>/plugins/claude-code` (session) or copy to `~/.claude/plugins/reelforge` and enable in `/plugin`; set the key; restart | `REELFORGE_API_KEY` (required, expanded into the `X-API-Key` header) | "Record a demo of signing up at http://127.0.0.1:4402, then publish the help article for the flow it creates." |
| **OpenCode** | `opencode.json` MCP block + optional zero-dependency plugin that warns when the API is down | Merge the `mcp` block into `opencode.json`; optionally copy `plugin/reelforge.ts` to `.opencode/plugin/`; set the key; restart | `REELFORGE_API_KEY` (required, `{env:…}` substituted by OpenCode); `REELFORGE_API_URL` (optional, plugin probe) | "Use the reelforge MCP server to record a demo of our signup flow and publish the help article." |
| **DeepSeek Harness** | `SKILL.md` skill (triggers on demo/walkthrough/help-article requests) + `mcp.example.json` | Copy `plugins/deepseek` to `~/.agents/skills/reelforge`; merge `mcpServers` from `mcp.example.json` into the profile; reload session | `REELFORGE_API_KEY` (required by the MCP server entry) | "Record a demo of our signup flow and publish the help article for it." |

## Install commands

### Claude Code

```bash
# session-scoped
claude --plugin-dir /absolute/path/to/reelforge/plugins/claude-code

# persistent
mkdir -p ~/.claude/plugins && cp -r plugins/claude-code ~/.claude/plugins/reelforge
```

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\plugins" | Out-Null
Copy-Item -Recurse plugins\claude-code "$env:USERPROFILE\.claude\plugins\reelforge"
```

Then `/mcp` should list `reelforge` with 39 tools, and the three slash commands appear.
Full detail: [plugins/claude-code/README.md](../plugins/claude-code/README.md).

### OpenCode

Merge [plugins/opencode/opencode.json](../plugins/opencode/opencode.json) into your
`opencode.json` (project) or `~/.config/opencode/config.json` (global), then optionally:

```bash
mkdir -p .opencode/plugin
cp plugins/opencode/plugin/reelforge.ts .opencode/plugin/reelforge.ts
```

The plugin pings `GET {REELFORGE_API_URL}/health` once and shows a warning toast if
Reelforge is not running; otherwise it returns `{}` and registers nothing. Full detail:
[plugins/opencode/README.md](../plugins/opencode/README.md).

### DeepSeek Harness

```bash
mkdir -p ~/.agents/skills
cp -r plugins/deepseek ~/.agents/skills/reelforge
```

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.agents\skills" | Out-Null
Copy-Item -Recurse plugins\deepseek "$env:USERPROFILE\.agents\skills\reelforge"
```

Merge the `mcpServers` block from
[plugins/deepseek/mcp.example.json](../plugins/deepseek/mcp.example.json) into your profile
MCP config. Full detail: [plugins/deepseek/README.md](../plugins/deepseek/README.md).

## Environment variables

| Variable | Required | Used by | Notes |
|---|---|---|---|
| `REELFORGE_API_KEY` | yes | all three | `rg_<32 hex>`. From `data/dev-api-key.txt` (`npm run seed`) or Dashboard → Settings → API keys. |
| `REELFORGE_API_URL` | no | OpenCode plugin probe | Defaults to `http://127.0.0.1:4400/api`. The MCP URL itself is written in each config file. |

Every plugin keeps the key out of the repository. If you maintain a local env file
(`.env`, `.env.local`, `*.local.env`), [plugins/.gitignore](../plugins/.gitignore) already
excludes it — never commit a key.

## The honest requirement

**The Reelforge API must be running and reachable from the agent process.** Each plugin is a
convenience wrapper, not a hosted service: they contain no server, no dependencies and no
build step. Start the backend first:

```bash
npm run api          # http://127.0.0.1:4400
# or
docker compose up    # same API, containerised
```

Then verify from the same machine/agent:

```bash
curl -s http://127.0.0.1:4400/api/health
# {"version":"0.3.0","features":[...]}
```

Notes:

- If you run an agent inside a container and Reelforge on the host, `127.0.0.1` points at
  the container — use `host.docker.internal` (or the host's LAN address).
- If you changed `REELFORGE_API_PORT`, update the `url` in the config file you installed.
- The MCP server is `POST http://127.0.0.1:4400/api/mcp` (streamable HTTP, stateless,
  `X-API-Key`). Full MCP reference: [MCP.md](./MCP.md).
- Claude Desktop (stdio-only) is not covered by these folders; use the stdio bridge
  documented in [MCP.md](./MCP.md#claude-desktop-stdio-bridge).
