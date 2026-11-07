# Features, and what they cost elsewhere

Reelforge is MIT and every feature below is free — no paid tier, no seat limit, no
watermark you cannot turn off, no export cap. This page exists because "free" is easy to
claim and hard to verify, so it says exactly what is implemented, what is borrowed as an
*idea*, and what we deliberately do not do.

## Where the ideas came from

| Source | Licence | What we took |
|---|---|---|
| [Screenforge Director](https://director.screenforge.co) | commercial SaaS | The architecture (Product Graph → four outputs), the REST/MCP contract, the error-code vocabulary, the CLI's session-capture model. Reimplemented from public docs and the published npm client; **no code copied**. |
| [screenforgeai/screenforge](https://github.com/screenforgeai/screenforge) | **AGPL-3.0** | Feature ideas only: auto-zoom, cursor tracking, timeline thinking, and the two features its own `FEATURES.md` lists as planned (music auto-duck, camera background blur). **No code is copied** — AGPL is copyleft and would force this project to adopt it. We deliberately keep Reelforge MIT. |
| Loom, Screen Studio, Tella, Supademo, Arcade | commercial | Feature parity targets: aspect ratios for social, blurred-background reframes, privacy masking, clickable walkthroughs, instant sharing. Ideas, not code. |

If you want to *use* Screenforge's code, it is AGPL and you are welcome to — just not in
this repository, because the licences are incompatible.

## The two products are complements, not competitors

**Screenforge (desktop)** records *a human* using a screen: webcam, microphone, timeline
editor, manual capture.

**Reelforge** records *a product*, by driving a browser itself — no human in the loop, so
it can re-record after every deploy, at 3 a.m., from CI, for every branch. It produces a
narrated video plus articles, guides and an interactive walkthrough from the same capture.

## Feature matrix

Legend: **●** implemented · **◐** partial · **—** not implemented (and why).

| Feature | Reelforge | Paid equivalent that charges for it |
|---|---|---|
| Drive the product with a real browser, from a URL + one sentence | ● | Director |
| Narration (TTS) in the demo language | ● OpenAI · ElevenLabs · edge-tts · macOS `say` · Linux espeak · Windows SAPI · silent | Loom, Tella |
| Auto-zoom onto the action | ● eased, camera clamped to viewport | Screen Studio, Screenforge |
| Cursor + click feedback in the recording | ● injected into the page, so it is in the captured pixels | Screenforge, Screen Studio |
| Burned captions + `.srt` + `.vtt` | ● | Loom (paid), most tools |
| **Aspect ratios** 16:9 / 9:16 / 1:1 / 4:5 | ● reframed over a blurred background | Screen Studio (paid), Kap |
| **Background music with auto-ducking** | ● ffmpeg sidechain, ducked under narration | Screenforge (planned), Tella |
| **Privacy masking** of passwords / cards / keys | ● screenshots masked at capture, video blurred per step | Loom (paid), Screen Studio |
| **Clickable walkthrough** (no video, real hotspots) | ● self-contained HTML, offline, one file | Supademo, Arcade, Navattic (all paid) |
| Public share page, no account for the viewer | ● 30-day signed link | Loom (limits), Vidyard |
| Help-centre article from the same capture | ● Markdown, signed screenshots, Zendesk-shaped publish | Director |
| Internal training doc (private channel) | ● | Director |
| In-app guide you embed with one script | ● 3.9 KB gzip, shadow DOM, skips moved targets | Userpilot, Appcues (paid) |
| GIF preview for chat | ● 3.5 s loop, <2 MB | many, usually paid tier |
| Webhooks (+ Slack) | ● HMAC-signed, retries | Director (Slack only) |
| Product Graph: dedupe flows by signature, flag drift | ● | Director |
| Re-record from CI / on every deploy | ● REST + MCP + CLI | Director |
| Agent access (MCP) | ● 39 tools, HTTP **and** stdio, resources + prompts | Director (HTTP only) |
| Bring your own model | ● ~30 providers, free and paid, or fully offline | Director (their models) |
| Runs fully offline, no keys at all | ● offline planner + offline TTS | none of them |
| Cameras / webcam bubble | — | Screenforge, Loom, Screen Studio |
| Microphone voiceover | — (TTS narration instead) | Screen Studio, Loom |
| Human timeline editor (scrub, cut, rearrange) | — (steps are the timeline; re-record instead) | Screenforge, Screen Studio |
| Person segmentation / virtual background | — (needs per-frame ML; Screenforge lists it as planned) | mmhmm, Loom (paid) |
| Real-time recording of a human's screen | — (that is Screenforge's job, and it is free too) | Screenforge, Loom |

## Why some things are "—" rather than "coming soon"

- **Webcam / microphone capture** would require a human at the keyboard, which is the
  opposite of an autonomous agent. Where a face adds warmth, record it separately and
  composite; pretending to support it would produce a worse product.
- **A timeline editor** is a different product surface. Reelforge's timeline is the step
  list: to change the story, change the instruction and re-record — 90 seconds, no editing.
- **Person segmentation** needs per-frame ML segmentation on the video encoder path. It is
  feasible (MediaPipe selfie segmenter, which is what Screenforge proposes) but it belongs
  with webcam capture above.

## Free forever, concretely

- **MIT licence** — fork it, rebrand it, sell services around it.
- **No watermark by default**, and the watermark is a *render option you control*, not a
  licence gate (`options.watermark`).
- **No export cap, no resolution cap** (120–2160 px height), no seat limit, no "business
  plan" for webhooks or aspect ratios.
- **No account** — self-hosted means the workspace is a row in your own SQLite file.
- **No telemetry.** There is no analytics endpoint in this codebase, by design.

The only thing you can pay for is someone else's inference: your own model key, or nothing
at all if you use the offline planner and offline TTS.
