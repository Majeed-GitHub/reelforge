# Reelforge v0.3.0 — universal byok, cross-platform, and a front door

The release that makes the project usable by someone who has never heard of it.

## Bring your own key, from anywhere

The provider catalog went from **10 to 31**: ten free tiers (Google Gemini,
OpenRouter, Groq, Mistral, Cerebras, NVIDIA NIM, GitHub Models, Hugging Face,
SambaNova, DashScope), fifteen paid (GMI Cloud, OpenAI, Anthropic, DeepSeek, xAI,
Together, Fireworks, DeepInfra, Nebius, Novita, Hyperbolic, Moonshot, Zhipu,
Perplexity, Azure OpenAI) and six local (Ollama, LM Studio, llama.cpp, vLLM,
LocalAI, Custom).

- **Auto-detect**: with no provider configured, Reelforge reads conventional key
  environment variables in a documented priority order, then probes local servers.
  A user with `OPENAI_API_KEY` set needs to configure nothing.
- **Quirks are data, not code paths**: Azure's deployment URL, `api-key` header and
  `api-version`; Anthropic's native Messages API (translated, including vision
  blocks); Gemini's `/openai` suffix. One request builder is shared by the planner
  and the connection test, so they cannot drift.
- AWS Bedrock and Vertex are documented as unsupported (SigV4/OAuth) with a proxy
  workaround rather than half-working.

## Cross-platform, actually

The first CI run on a three-OS matrix found two real defects that a Windows-only
workflow never would: the Linux `ffmpeg-static` build has no `drawtext`, so the
watermark was being dropped silently, and the renderer assumed a system Arial.

- Narration chain is now openai → elevenlabs → edge-tts → **macOS `say`** →
  **Linux espeak-ng / espeak / pico2wave / festival** → Windows SAPI → silent.
- DejaVu Sans is bundled, so captions and the watermark never depend on the host's
  font set.
- Filter support is probed once (`ffmpeg -filters`) and the graph is planned from
  what the build can actually do; a missing filter is a reported capability, not a
  silent degradation. Fallback warnings now carry ffmpeg's stderr.
- CI: Ubuntu × Node 22 and 24 run the full pipeline including a real recording;
  macOS and Windows run build, render and provider self-tests.

## A front door

- **Marketing site** (`site/`) — a build-less static page: Instrument Serif over
  Manrope, self-hosted fonts, quiet editorial layout, honest comparison table.
  Served by GitHub Pages.
- **Promotion video** — 30 seconds, 1920×1080, 1.87 MB. Generated **from code**: a
  self-contained HTML composition recorded by headless Chromium and encoded with
  the bundled ffmpeg. `node docs/media/promo/record.mjs` reproduces it.
- **Embeddable player** at `GET /embed/:token` — an iframe-able 16:9 player with
  captions, a removable badge and autoplay/loop/start params, plus privacy-respecting
  view counts (no IPs, no user agents, no cookies).
- **docs/ROADMAP.md** — an honest audit of what is still missing and the order to
  do it, including the five things this product deliberately will not do.

## Outputs and capture

- **Clickable walkthrough**: one self-contained HTML file per demo, hotspots at the
  recorded coordinates, keyboard navigation, works from `file://`. This is the output
  Director explicitly does not produce.
- **Aspect ratios** 9:16 / 1:1 / 4:5 over a blurred, darkened copy of the frame.
- **Privacy masking**: passwords, card numbers, SSNs and API keys are masked in the
  screenshots (pixels verified black) and blurred in the video only while on screen.
  Fail-closed: an unmasked screenshot is never written.
- **Music bed with auto-ducking** via sidechain compression.

## Verified

| Suite | Result |
|---|---|
| End-to-end smoke | 23/23 |
| Render self-test | 28/28 (Windows), capability-aware on Linux |
| Provider self-test | 78 |
| Redaction | 49/49 |
| UI | 43/43 + 22/22 |
| MCP | 39 tools, 20/20 HTTP, 8/8 stdio |
| Site | 18/18 |
| CI | green on ubuntu 22/24, macOS, Windows, and the Docker image |

## Upgrade notes

- `workspace_settings` is created on first boot; no migration needed.
- Set `REELFORGE_PUBLIC_URL` to your public origin — share links, embed snippets and
  webhook media URLs are built from it.
- Linux containers should mount a volume at `/data`; the image runs as `pwuser`.
