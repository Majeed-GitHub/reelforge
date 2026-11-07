# @reelforge/render

The render stage: turns the browser agent's raw Playwright `.webm` plus its
`StepRecord[]` into a finished, narrated MP4 with auto-zoom, captions,
watermark, social reframes, a music bed and time-scoped redaction blur.

```ts
import { renderDemo } from './packages/render/src/index.ts';

const result = await renderDemo({
  capture,          // CaptureResult (videoPath, viewport, steps, …)
  steps,            // StepRecord[]
  outDir,           // working dir for SRT / poster / temp audio
  outputPath,       // finished .mp4
  options: { fps: 30, scaleHeight: 720, watermark: true, language: 'en', zoom: 1.6 }
});
// -> { videoPath, posterPath, durationMs, width, height, lines, srtPath, warnings }
```

Everything is one ffmpeg pass: 2x upscale → animated `zoompan` camera →
time-scoped redaction blur → aspect reframe → captions burn → watermark →
narration (+ optional ducked music) → libx264/yuv420p/+faststart. Per-line
failures and optional features degrade with warnings; they never fail the
render.

## Self-test

```sh
node packages/render/test/render-selftest.ts
```

Generates a synthetic 8s capture, renders the narrated 16:9 master, 9:16 and
1:1 reframes, a music bed (and a missing-music case) and two redaction renders,
then asserts with ffprobe/ffmpeg. Exits non-zero on any failure.

## Cross-platform narration (`src/tts.ts`)

`auto` tries the first available provider:

| Order | Provider | Availability |
|---|---|---|
| 1 | `openai` | `OPENAI_API_KEY` set. `gpt-4o-mini-tts` via `/audio/speech`. |
| 2 | `elevenlabs` | `ELEVENLABS_API_KEY` set. `eleven_multilingual_v2`. |
| 3 | `edge` | Python module `edge_tts` importable (`python -c "import edge_tts"`). |
| 4 | `macos` | macOS `say` on PATH; wrote AIFF at `--data-format=LEF32@22050`, converted to WAV with the bundled ffmpeg. |
| 5 | `linux` | First of `espeak-ng`, `espeak`, `pico2wave`, `festival` on PATH. Festival uses `text2wave` when present, else a Scheme `utt.save.wave` script. |
| 6 | `sapi` | Windows only: PowerShell 5.1 `System.Speech.Synthesis` → WAV, voice picked by language (falls back to Zira/David). |
| 7 | `none` | Silent video + burned captions. |

All probes are cheap (PATH checks / cached one-shot calls) and fail soft. To
see what actually works on a machine (the dashboard uses this):

```ts
import { describeTtsProviders } from './packages/render/src/tts.ts';
const infos = await describeTtsProviders();        // native platform
const onMac = await describeTtsProviders('darwin'); // platform override
// [{ id, label, available, reason, platform, backend?, offline? }]
```

Force a provider with `DemoOptions.voice` / `REELFORGE_TTS_PROVIDER`
(`auto | openai | elevenlabs | edge | macos | linux | sapi | none`). Any other
`voice` string is treated as a voice name for the active provider.

## Aspect ratios (`src/aspect.ts`)

`options.aspect`: `16:9` (default, native capture) | `9:16` | `1:1` | `4:5`.
The canvas height is `options.scaleHeight` and the width follows the ratio, so:

| aspect | scaleHeight | output |
|---|---|---|
| 16:9 | 720 | 1280×720 (unchanged pipeline) |
| 9:16 | 1920 | 1080×1920 |
| 1:1 | 1080 | 1080×1080 |
| 4:5 | 1350 | 1080×1350 |

Social aspects keep the full 16:9 camera frame fitted and centred, and fill the
rest with a blurred, darkened, cover-scaled copy of that same frame (Screen
Studio / Loom style). The auto-zoom camera stays clamped inside the visible
frame. 16:9 skips the reframe graph entirely.

## Music bed (`src/music.ts`)

```ts
options.music = { path: 'audio/track.mp3', gain: 0.18, duck: true };
```

- `path` is absolute or relative to `REELFORGE_DATA_DIR`.
- The track is looped/trimmed to the video length and mixed at `gain` (0–1,
  default 0.18).
- `duck` (default true) runs `sidechaincompress` keyed off the narration bus:
  `threshold=-25dB, ratio=4, attack=200ms, release=1000ms`.
- **No music file ships with Reelforge — you supply your own licensed track.**
- A missing/unreadable file logs a warning and the render continues without
  music.

## Redactions (`src/redactions.ts`)

```ts
options.redactions = [{ x, y, width, height, stepIndex }]; // viewport CSS px
```

- Each box is blurred only inside its own step's window
  (`startedAtMs`→`endedAtMs`) plus a 150 ms lead-in/out.
- Contiguous identical boxes (within 4 px) across consecutive steps merge into
  one interval, so a still-visible field does not flicker.
- A step with no redaction entry never gets bridged to a later identical box.
- Blur is applied to the source frame **before** the auto-zoom camera, so the
  region follows the camera and the blurred social background cannot leak the
  masked pixels. Filters are emitted as `crop → boxblur → overlay` with
  `enable='between(t,start,end)'`.
