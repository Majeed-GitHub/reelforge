# Reelforge for Claude Code

Three slash commands plus the Reelforge MCP server (39 tools). No build step, no
dependencies — this folder is just JSON and Markdown.

## Install (three steps)

**1. Load the plugin**

For a single session, point Claude Code at this folder:

```bash
claude --plugin-dir /absolute/path/to/reelforge/plugins/claude-code
```

For every session, copy the folder into your user plugin directory:

```bash
# macOS / Linux
mkdir -p ~/.claude/plugins
cp -r plugins/claude-code ~/.claude/plugins/reelforge

# Windows PowerShell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\plugins" | Out-Null
Copy-Item -Recurse plugins\claude-code "$env:USERPROFILE\.claude\plugins\reelforge"
```

Then enable it in `/plugin` (or restart Claude Code and run `/plugin` once). If this
repository is later published as a Claude Code marketplace, the managed alternative is
`/plugin marketplace add <owner>/reelforge` followed by
`/plugin install reelforge@reelforge`.

**2. Export your API key**

The manifest expands `${REELFORGE_API_KEY}` into the `X-API-Key` header — the key is never
stored in this file.

```bash
export REELFORGE_API_KEY="rg_…"          # bash / zsh
```

```powershell
$env:REELFORGE_API_KEY = "rg_…"           # PowerShell (current shell)
[Environment]::SetEnvironmentVariable("REELFORGE_API_KEY", "rg_…", "User")   # persistent
```

Get the key from `data/dev-api-key.txt` after `npm run seed`, or from the dashboard under
Settings → API keys.

**3. Restart Claude Code**

Run `/mcp` and confirm `reelforge` is connected. You should see commands
`/record-demo`, `/publish-article` and `/demo-status`.

## Commands

| Command | What it does |
|---|---|
| `/record-demo <url> <instruction> [language]` | Calls `health`, `create_demo`, polls to completion, returns the video and share links. |
| `/publish-article <flow_id> [channel]` | Reads the flow, generates the article, asks for approval, then publishes. |
| `/demo-status <demo_id>` | Reports status/progress; for finished demos returns video, duration, credits and narration count. |

The plugin trusts only the MCP server: the commands tell Claude to read ids and URLs from
tool results, never to invent them.

## Requirements

- The API must be running and reachable from Claude Code:
  `npm run api` (or `docker compose up`) on `http://127.0.0.1:4400`. If you changed
  `REELFORGE_API_PORT`, edit the `url` in
  `.claude-plugin/plugin.json` (`http://127.0.0.1:<port>/api/mcp`).
- Node is **not** required by this plugin — Claude Code speaks streamable HTTP directly.
- This is a convenience wrapper, not a hosted service: with the API down, the tools fail
  with a connection error.

## Security notes

- Do not commit your key. This folder contains no key.
- Signed video URLs returned by tools expire after one hour; share links last 30 days.
- Destructive demo steps still require `confirm_destructive: true`, and a new public host
  requires `authorized: true` once.
