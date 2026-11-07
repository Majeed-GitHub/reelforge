## v0.3 verification

Every number from an executed run on Windows 11 / Node 25.8, still with **no API keys**.

### Cross-platform narration

`describeTtsProviders()` reports what the current OS can actually do, and the `auto`
chain is openai → elevenlabs → edge-tts → macOS `say` → Linux
espeak-ng/espeak/pico2wave/festival → Windows SAPI → silent. Verified from this Windows
host: SAPI reports available with two System.Speech voices; the macOS and Linux providers
report `available:false` with a platform reason (asserted via a platform override, because
the binaries obviously are not on Windows). On the Linux and macOS CI legs those same
checks run against the real platform.

### Aspect ratios

| Ratio | Output | Corner luma (blurred background present?) |
|---|---|---|
| 16:9 | 1280×720 — unchanged filter path | n/a (no reframe) |
| 9:16 @ scaleHeight 1920 | **1080×1920** | tl 67 · tr 86 · bl 67 · br 86 → non-black |
| 1:1 @ 480 | **480×480** | tl 67 · br 120.6 → non-black |

### Music with ducking

| Render | Mean volume |
|---|---|
| music only (gain 0.18) | −38.5 dB |
| music + narration, ducked | −23.9 dB |
| missing music file | warns, still renders a valid MP4 |

### Redactions

Fixture with a password, `cc-number`, `ssn` and `api-key` input:

- **24/24** recorded boxes are pure **RGB(0,0,0)** in the saved PNGs (5 sample points each); the
  neighbouring email and notes fields are untouched.
- Boxes are emitted **per step** and never collapsed across steps; the renderer merges
  contiguous identical geometry itself (merge test → one window over steps 0–2; gap test → two
  windows). Blur pixel diff **3.04 inside** the box/window, **0.00 outside** the box and
  **0.00 outside** the window.
- Values are stored as `••••`, `capture.json` contains no secrets, and logs are scrubbed of
  bearer tokens and API keys. The vision planner's observation screenshot is masked too, so a
  BYOK model never sees the secret.
- Known gaps, stated rather than hidden: closed shadow roots, iframes, canvas-painted text, and
  a secret inside prose unless the caller names a selector around it.

### Interactive walkthrough

One self-contained HTML file per demo — 329 196 bytes for 11 steps, zero external
references, CSP `default-src 'none'`. Click-through verified in Chromium: hotspot 1→2,
Back 2→1, ArrowRight 1→3, Esc → cover, Next → 11/11 → finish card; the page makes exactly
**one** network request (itself). It also works opened from `file://`, so it can be emailed.

### Suites

```
node packages/render/test/render-selftest.ts       29/29   (was 12)
node packages/agent/scripts/verify-redaction.ts    49/49
node packages/agent/scripts/verify-guards.ts       38/38
node packages/agent/scripts/verify-credentials.ts  14/14
node packages/providers/test/providers-selftest.ts 78/78   (was 48)
npm test                                           43/43 + 22/22 + 8/8
npm run smoke                                      23/23, exit 0
npx tsc -p tsconfig.json --noEmit                  exit 0
```
