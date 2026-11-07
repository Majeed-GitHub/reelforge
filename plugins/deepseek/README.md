# Reelforge for DeepSeek Harness

A skill (procedural knowledge) plus an MCP server example. Two small text files — nothing
to install, nothing to build.

## Install (three steps)

**1. Copy the skill**

DeepSeek Harness discovers skills under `~/.agents/skills/<name>/SKILL.md`:

```bash
mkdir -p ~/.agents/skills
cp -r plugins/deepseek ~/.agents/skills/reelforge
```

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.agents\skills" | Out-Null
Copy-Item -Recurse plugins\deepseek "$env:USERPROFILE\.agents\skills\reelforge"
```

**2. Connect the MCP server**

Merge the `mcpServers` block from [mcp.example.json](./mcp.example.json) into the MCP
configuration of the profile you use, and replace `rg_REPLACE_WITH_YOUR_KEY` (or reference
the `REELFORGE_API_KEY` environment variable if your host supports it):

```json
{
  "mcpServers": {
    "reelforge": {
      "type": "http",
      "url": "http://127.0.0.1:4400/api/mcp",
      "headers": { "X-API-Key": "rg_…" }
    }
  }
}
```

**3. Start a new session**

The `reelforge` skill should appear in the skill catalog. Say:

> "Record a demo of our signup flow and publish the help article for it."

## What the skill does

`SKILL.md` is the playbook: check `health`, `create_demo`, poll via `wait_for_demo` /
`get_demo_status`, answer questions, collect `get_demo_video` / `share_demo_link`, then
`list_graph_flows` → `create_article_from_flow` → `publish_article`. It is only loaded when
a request matches the description, so it costs no context otherwise.

## Requirements and notes

- The Reelforge API must be running and reachable from the DeepSeek Harness process:
  `npm run api` (or `docker compose up`) on `http://127.0.0.1:4400`.
- This is a convenience wrapper, not a hosted service. Keep the API key out of
  `mcp.example.json` if the file is committed; prefer an environment-variable reference.
- Video URLs expire after one hour; share links last 30 days.