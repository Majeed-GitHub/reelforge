---
description: Turn a recorded Product Graph flow into a published help-centre article
argument-hint: <flow_id> [channel]
allowed-tools: mcp__reelforge__list_environments, mcp__reelforge__list_graph_flows, mcp__reelforge__get_graph_flow, mcp__reelforge__create_article_from_flow, mcp__reelforge__get_article, mcp__reelforge__update_article, mcp__reelforge__publish_article
---

Write and publish a help article from a Reelforge flow.

- Flow id: `$1`
- Channel: `$2` — use `help_center` when this is blank.

Steps:

1. If you do not know the environment that owns the flow, call
   `mcp__reelforge__list_environments` then `mcp__reelforge__list_graph_flows` for each
   environment until `$1` appears. Do not guess an environment id.
2. Call `mcp__reelforge__get_graph_flow` to read the real steps, screens and existing
   articles/guides.
3. Call `mcp__reelforge__create_article_from_flow` with `flow_id` = `$1` and `channel` =
   `$2` (or `help_center`).
4. If the returned article has `stale: true`, stop and offer to fix the flow first
   (`fix-stale-flow`). Do not publish documentation generated from a stale flow.
5. Show the title, excerpt and the Markdown body, then ask the user to approve publishing.
6. Only after approval, call `mcp__reelforge__publish_article` with the article id and
   report `published_url`.

Never publish without explicit approval.
