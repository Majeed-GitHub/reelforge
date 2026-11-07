---
description: Record a narrated demo of a URL and report the video and share links
argument-hint: <url> <instruction> [language]
allowed-tools: mcp__reelforge__health, mcp__reelforge__create_demo, mcp__reelforge__get_demo_status, mcp__reelforge__wait_for_demo, mcp__reelforge__answer_demo_question, mcp__reelforge__get_demo_video, mcp__reelforge__share_demo_link
---

Record a Reelforge demo.

- Target URL: `$1`
- Goal / instruction: `$2`
- Language: `$3` — use `en` when this is blank.

Steps:

1. Call `mcp__reelforge__health` once. If `worker.running` is false, stop and tell the user the
   recorder is not running (`npm run api`).
2. Call `mcp__reelforge__create_demo` with `instruction` = `$2`, `target_url` = `$1`,
   `language` = `$3` (or `en`). If it returns `DOMAIN_AUTHORIZATION_REQUIRED`, show the
   remediation and ask the user before retrying with `authorized: true`.
3. Poll `mcp__reelforge__get_demo_status` using the returned `pollAfterSeconds`, or call
   `mcp__reelforge__wait_for_demo` once with `timeout_seconds: 180`.
4. If the status is `question`, call `mcp__reelforge__answer_demo_question` with one of the
   option ids. If it is `failed`, quote `failure.code`, `failure.message` and
   `failure.remediation` and stop — do not retry blindly.
5. On `complete`, call `mcp__reelforge__get_demo_video` and
   `mcp__reelforge__share_demo_link`.
6. Report: demo id, duration, credits used, the signed video URL (valid 1 hour) and the
   share URL (valid 30 days).

Use exactly the ids and URLs the tools return — never invent or guess them.
