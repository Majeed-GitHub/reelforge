---
description: Show one Reelforge demo's status, video and narration
argument-hint: <demo_id>
allowed-tools: mcp__reelforge__get_demo_status, mcp__reelforge__get_demo_video, mcp__reelforge__get_transcript_markdown, mcp__reelforge__list_demos
---

Report the current state of Reelforge demo `$1`.

Steps:

1. Call `mcp__reelforge__get_demo_status` with `demo_id` = `$1`.
2. If the status is `queued` or `running`, report `progress`, the current step count and
   `pollAfterSeconds`. Do not claim it is finished.
3. If the status is `failed`, quote `failure.code`, `failure.message` and
   `failure.remediation`.
4. If the status is `complete`, call `mcp__reelforge__get_demo_video` and
   `mcp__reelforge__get_transcript_markdown`, then report:
   - duration (`durationSeconds`) and `creditsUsed`
   - the signed video URL (expires in 1 hour — re-run the tool for a fresh one)
   - poster/SRT links
   - narration line count
5. If the user asked for a demo by instruction instead of id, call
   `mcp__reelforge__list_demos` first and match on `instruction`; never guess an id.
