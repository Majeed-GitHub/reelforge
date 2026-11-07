# Reelforge for OpenCode

A remote MCP server block plus a tiny optional plugin. No dependencies, no build step.

## Install (three steps)

**1. Add the MCP server**

Merge the `mcp` block from [opencode.json](./opencode.json) into your OpenCode config
(project `opencode.json`, or `~/.config/opencode/config.json` globally):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "reelforge": {
      "type": "remote",
      "url": "http://127.0.0.1:4400/api/mcp",
      "enabled": true,
      "headers": { "X-API-Key": "{env:REELFORGE_API_KEY}" }
    }
  }
}
```

OpenCode substitutes `{env:REELFORGE_API_KEY}` at load time, so the key stays out of the
file.

**2. Export your API key**

```bash
export REELFORGE_API_KEY="rg_…"            # bash / zsh
```

```powershell
$env:REELFORGE_API_KEY = "rg_…"             # PowerShell
```

**3. (Optional) copy the no-op plugin, then restart OpenCode**

```bash
mkdir -p .opencode/plugin
cp plugins/opencode/plugin/reelforge.ts .opencode/plugin/reelforge.ts
```

The plugin pings `GET {REELFORGE_API_URL}/health` once and shows a warning toast if
Reelforge is not running. It registers nothing and returns `{}` — remove it and OpenCode
works exactly the same, just with a less helpful failure when the API is down.

Start (or restart) OpenCode. The `reelforge` MCP server should appear with 39 tools.

## What to say

> "Use the reelforge MCP server to record a demo of signing up at
> http://127.0.0.1:4402, then publish the help article for the flow it creates."

OpenCode does not install the Claude Code slash commands; ask in natural language — the
tools are available to the agent regardless.

## Requirements and notes

- The API must be running and reachable from OpenCode: `npm run api` (or
  `docker compose up`) on `http://127.0.0.1:4400`. If you changed `REELFORGE_API_PORT`,
  edit the `url` in your config.
- If OpenCode runs in a container and Reelforge on the host, `127.0.0.1` is wrong — use
  the host-reachable address (e.g. `http://host.docker.internal:4400/api/mcp`).
- This is a convenience wrapper, not a hosted service. No key is stored in this folder;
  never commit one.
