# Luxury promo — motion design with sound

A 30-second promo built as a **composition, not an edit**: an HTML canvas with a
WebGL background, real CSS-3D depth, a deterministic timeline, neural narration and
fully synthesized sound design. Re-render either the video or the audio alone.

> Deliberately **no Remotion/three dependency**. The repo stays light (that was an
> explicit requirement), and a hand-built WebGL + CSS composition renders the same
> craft without adding ~200 MB of tooling to the project.

## Deliverables

| File | For | Spec |
|---|---|---|
| `../reelforge-promo-lux.mp4` | website, YouTube, presentations | 1920×1080 · 30 s · 8.7 MB · h264 + AAC |
| `../reelforge-promo-lux-9x16.mp4` | Instagram story, WhatsApp status, Reels | 1080×1920 · 30 s · 8.5 MB |
| `../reelforge-promo-lux-1x1.mp4` | feed post | 1080×1080 · 30 s · 5.6 MB |
| `../reelforge-promo-lux-720p.mp4` | the marketing site hero | 1280×720 · 1.2 MB |

Posters sit next to each file (`*-poster.jpg`, frame at 2.6 s).

## Sound design

All original — nothing sampled, nothing licensed. Built by `audio/build-audio.mjs`.

| Layer | How it is made |
|---|---|
| **Narration** | `edge-tts` neural voice (`en-US-AriaNeural`, rate +10%), six short lines timed to the acts |
| **Impacts** | sine drop (76→38 Hz) + noise transient, low-passed — the wordmark landing, the end card |
| **Whooshes** | pink noise through a moving band-pass with a bell envelope — the browser flight and the provider wall |
| **Ticks** | 2.4 kHz sine burst with a 90 ms decay — one per typed word |
| **Card arrivals** | short harmonic thuds (320–560 Hz) with staggered pitch |
| **Bed** | four detuned partials (A2/E3/A3/E4) plus low-passed brown noise, 2.5 s fade in, 2 s out |
| **Ducking** | the music is compressed *by* the voice bus (`sidechaincompress`, threshold 0.045, ratio 7) |
| **Mastering** | `loudnorm=I=-14:TP=-1.5:LRA=11` → **−14.8 LUFS integrated, −1.3 dBTP true peak, LRA 9.6** |

The narration ends at 27.37 s, inside the 30 s cut, so it never talks over the fade.

## Storyboard

| Time | Act | Picture | Sound |
|---|---|---|---|
| 0.0–3.3 | Mark | Wordmark scales in with wide tracking, ember rule draws, tagline rises | riser into a soft impact, "Reelforge." |
| 3.3–8.1 | Instruction | URL chip snaps in, the sentence types on, caret blinks | one tick per word, "Give it a URL, and one sentence." |
| 8.1–14.6 | Pipeline | Browser card flies in from z −420 with rotation, camera pushes 1.14×, cursor moves and clicks, zoom frame, four output cards fan out in depth | whoosh, click, card thuds |
| 14.6–20.1 | Providers | Three depth lanes of 31 provider names scroll at different speeds and blurs | whoosh, "One capture. Your own model, or fully offline." |
| 20.1–24.6 | Three beats | Frame morphs 16:9 → 9:16 → 1:1, a mask snaps over an email field, a hotspot pulses | three punctuations |
| 24.6–30.0 | End card | Mark, "Open source · MIT · Free forever", repo URL, three commands, fade to black | impact + swell, "Free forever." |

## Re-render

```bash
# 1. audio (neural narration + synthesized effects + mix) — needs python + edge-tts
node docs/media/lux/audio/build-audio.mjs

# 2. video: records 16:9, 9:16 and 1:1 in headless Chromium, muxes audio, verifies
node docs/media/lux/record.mjs

# 3. the 720p site cut
ffmpeg -i docs/media/reelforge-promo-lux.mp4 -vf scale=1280:720 -c:v libx264 -crf 26 \
  -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart docs/media/reelforge-promo-lux-720p.mp4
```

`record.mjs` prints a table, then asserts: resolution, duration, codec, audio stream,
size, that six sampled frames are neither black nor blown out, that the brightness arc
is real, and that the end card actually renders the repository URL (it measures the
element's DOM box at 27.6 s and samples exactly that region of the finished frame —
a guessed crop band is how that check lied to me the first time).

## Files

```
lux/
├── composition.html        the stage
├── lux.css                 design + per-format layout (16:9 / 9:16 / 1:1)
├── lux.js                  WebGL background + deterministic renderAt(t) timeline
├── record.mjs              record → mux → encode → verify
└── audio/
    └── build-audio.mjs     narration + effects + bed + mix + loudness report
```

Generated audio (`audio/vo`, `audio/sfx`, `audio/mix.wav`) and render scratch
(`.work/`) are gitignored; the two scripts rebuild them.
