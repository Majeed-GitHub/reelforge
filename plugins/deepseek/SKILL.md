---
name: reelforge
description: Record narrated product demo videos, poll them to completion, then generate and publish help-centre articles and in-app guides from the recorded Product Graph. Use when the user asks to record a demo, make a walkthrough or product tour, capture a narrated screen recording of a web app, publish a help article or training doc from a flow, share a demo link, or check a demo/render status.
---

# Reelforge

Reelforge is a local MCP server (39 tools) that drives a real browser, records a narrated
video, and turns the run into a Product Graph flow, a help-centre article and an in-app
guide. Configure it as an MCP server first — see `mcp.example.json` in this folder, or the
full setup in the repository's `docs/MCP.md`.

Before the first tool call, the Reelforge API must be running (`npm run api`) at
`http://127.0.0.1:4400`. If a tool fails to connect, say that instead of retrying.

## Record a demo

1. `health` — confirm `worker.running` is true. If false, tell the user the recorder is not
   running and stop.
2. `create_demo` with:
   - `instruction` — what the demo should show, one or two sentences;
   - `target_url` (or `environment_id` + optional `path`);
   - optional `language`, `fps`, `max_steps`, `voice`.
   Returns `{ id, status: "queued", pollAfterSeconds, environmentId }`.
3. Wait: `wait_for_demo` (≤180s) or poll `get_demo_status` every `pollAfterSeconds`.
   - `question` → `answer_demo_question` with one of `question.options[].id`.
   - `failed` → quote `failure.code`, `failure.message`, `failure.remediation`; retry at
     most once after fixing the request.
4. `complete` → `get_demo_video` for signed MP4/poster/SRT URLs (1-hour expiry),
   `get_transcript_markdown` for narration as Markdown, `share_demo_link` for a public
   30-day link. Report duration and `creditsUsed`.

## Publish documentation

1. `list_environments`, then `list_graph_flows` for the environment the recording created
   (or `get_graph_flow` if the user gave a flow id).
2. `create_article_from_flow` with `{ flow_id, channel: "help_center" | "internal_training" }`.
3. If the article has `stale: true`, stop and offer to fix the flow first — do not publish
   documentation from a drifted flow.
4. Show the draft, then publish with `publish_article` only after explicit approval.
   `publish_guide` makes a draft in-app guide live.

## Rules

- Never invent ids or URLs. Use exactly what the tools return.
- `authorized: true` only after the user confirms permission to record the host. A new
  public host fails with `DOMAIN_AUTHORIZATION_REQUIRED` until confirmed.
- `confirm_destructive: true` only with explicit approval for delete/revoke steps.
- Poll; do not busy-loop. `health` reports queue depth and the active TTS/LLM providers.
- Media links expire (1 hour); re-call `get_demo_video` when a fresh link is needed.