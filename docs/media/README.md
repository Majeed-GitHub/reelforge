# Reelforge promotional video — video as code

A 30-second, 1920×1080 motion-graphics promo built entirely from this repository's
own stack: an HTML/CSS/JS composition recorded by Playwright Chromium, encoded by
the bundled `ffmpeg-static`, and verified with `ffprobe-static`.

| File | What it is |
|---|---|
| [`promo.html`](promo/promo.html) | The whole composition. Self-contained 1920×1080 canvas, no external assets, deterministic JS timeline. |
| [`record.mjs`](promo/record.mjs) | Recorder + encoder + verifier. One command reproduces the deliverables. |
| [`reelforge-promo.mp4`](reelforge-promo.mp4) | The deliverable: 30.000 s, 1920×1080, H.264 High/yuv420p, AAC 48 kHz, faststart, ~1.9 MB. |
| [`reelforge-promo-poster.jpg`](reelforge-promo-poster.jpg) | Poster frame (wordmark + tagline, captured at 2.4 s). |
| [`promo/frames/`](promo/frames/) | Eight storyboard frames spread across the video, for review and site thumbnails. |

No music file is shipped: the optional tone bed is generated from two ffmpeg
sine waves (220 Hz + 329.63 Hz, 0.1 Hz tremolo, fades), so there is nothing to
license. Pass `--silent` for a silent master.

## Re-render

From the repository root (the only requirement is the existing root install and a
Playwright Chromium):

```sh
node docs/media/promo/record.mjs
```

Options:

```sh
node docs/media/promo/record.mjs --fps 60     # re-time to 60 fps
node docs/media/promo/record.mjs --silent     # no tone bed
node docs/media/promo/record.mjs --keep       # keep the raw .webm in promo/.tmp/
```

The recorder:

1. launches Chromium headless at 1920×1080, `deviceScaleFactor: 1`, with
   `recordVideo` sized 1920×1080;
2. loads `promo.html`, waits for `window.__ready`, calls `window.__start()` and
   lets the 30 s timeline play in real time;
3. checks the storyboard through the composition's `?t=` seek mode (every act,
   the redaction snap, the end-card URL and commands) and asserts the page made
   **zero** http(s) requests and logged **zero** page errors;
4. trims Playwright's startup lead-in, generates the tone bed, and encodes with
   the bundled ffmpeg — `libx264 -crf 22 -preset medium -pix_fmt yuv420p
   -movflags +faststart`, AAC 128 kb/s 48 kHz stereo;
5. extracts the poster and the eight frames;
6. ffprobes the MP4 and checks duration, dimensions, codecs, size, poster, frame
   brightness and the rendered repo-URL pixels. Exits non-zero if anything is off.

### Frame on demand (the `?t=` seek)

Open `promo.html?t=12.4` in any browser (or drive it from Playwright) to freeze
the composition at 12.4 s. `window.__seek(t)` does the same from script. The
timeline is a pure function of `t`, so a frame rendered on demand is identical
to the frame in the video.

## Storyboard and timing

30.0 s, five acts (plus a cold open), one accent colour (`#ff5c38` ember) on a
near-black canvas, 8 pt rhythm, `cubic-bezier(.16,1,.3,1)` entrances, linear
marquees.

| Act | Time | Beat | Detail |
|---|---|---|---|
| 1 | 0.00–3.30 | Wordmark | Black hold; kicker 0.25 s; **REELFORGE** scales/letter-spaces in 0.35–1.35 s; thin ember rule draws 1.0–1.7 s; tagline *"Your product demos, written by the product."* rises 1.55–2.4 s; fade 2.95–3.35 s. |
| 2 | 3.30–8.05 | The instruction | Label 3.4 s; *"Sign in, create a project, invite a teammate."* reveals word by word from 3.72 s with a blinking caret; `your-product.com` chip snaps in 5.5–6.15 s; caption 6.2 s; out 7.72–8.05 s. |
| 3 | 8.10–15.30 | Pipeline | Browser → Capture → Render → Publish nodes stagger 8.55–9.15 s, connector grows 8.7–9.9 s; stylised 800×440 browser window settles 9.0–9.95 s; cursor dot travels 9.55–12.1 s; ember zoom rectangle frames the form field 10.15–12.45 s; four output cards **Video · Article · Walkthrough · Guide** fan out 12.5–13.5 s; out 14.95–15.3 s. |
| 4 | 15.30–21.20 | Provider wall | *"Bring your own model — or run fully offline."* 15.55–16.35 s; three linear marquee rows — FREE (10), PAID (15), LOCAL (6) = the 31 catalog providers — stream continuously at 62/78/50 px/s; out 20.85–21.2 s. |
| 5 | 21.20–25.30 | Three beats | 21.35–22.55 s: `16:9 · 9:16 · 1:1` with a frame morphing landscape → portrait → square. 22.65–23.85 s: *"Passwords masked"* with a black box snapping over the password field. 23.95–25.15 s: *"Clickable walkthrough"* with a pulsing hotspot and cursor. |
| 6 | 25.30–30.00 | End card | REELFORGE 25.55 s; rule 25.85 s; *"Open source · MIT · Free forever"* 26.0 s; `github.com/Majeed-GitHub/reelforge` 26.35 s; three mono commands 26.9–27.5 s; *"No accounts · No telemetry · No watermark"* 27.7 s; fade to black 29.05–30.0 s. |

### Frames

| Frame | Time | Shows |
|---|---|---|
| `frame-01.jpg` | 0.6 s | wordmark scaling in |
| `frame-02.jpg` | 3.9 s | instruction typing begins |
| `frame-03.jpg` | 7.4 s | instruction + URL chip |
| `frame-04.jpg` | 10.9 s | browser window, cursor and zoom rectangle |
| `frame-05.jpg` | 14.2 s | four output cards fanned out |
| `frame-06.jpg` | 17.8 s | provider wall |
| `frame-07.jpg` | 22.9 s | redaction box snapping over the password field |
| `frame-08.jpg` | 28.4 s | end card with repo URL + commands |

## Verified output

`node docs/media/promo/record.mjs` → **PROMO RECORD PASS — 20/20 checks**.

```json
{
  "duration": 30.0,
  "size": 1956665,
  "video": { "codec": "h264", "width": 1920, "height": 1080, "pix_fmt": "yuv420p", "fps": "30/1" },
  "audio": { "codec": "aac", "sample_rate": "48000", "channels": 2 }
}
```

Additional checks include: 0 external requests, no page errors, all five acts
visible at their seek times, four cards fanned out, redaction box at `scaleX`
≥ 0.8 during its beat, end-card URL text inside the 1920×1080 frame (18.4 % bright
pixels measured inside the URL box of `frame-08.jpg`), poster not blank, tone bed
at −34.6 dB mean (subtle, not clipping), file under the 10 MB budget.

## Editing the promo

- All timing lives in `renderAt(tSeconds)` in `promo.html`; `DURATION` is 30.
  Change a number, re-run the recorder — no timeline editor, no project file.
- Keep the stage at 1920×1080 and node text at multiples of 8; entrances use the
  shared `ease` curve, marquees stay linear.
- `record.mjs` keeps `FRAME_TIMES` in sync with the storyboard table; update both
  if you move scenes.
- The only non-deterministic input is system font rasterisation (the composition
  uses the system UI font stack and a system mono stack). Frames are otherwise
  reproducible byte-for-byte from the same browser build.
