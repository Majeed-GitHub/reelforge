# Reelforge promotional video — video as code

A 30-second, 1920×1080 motion-graphics promo built entirely from this repository's
own stack: an HTML/CSS/JS composition recorded by Playwright Chromium, encoded by
the bundled `ffmpeg-static`, and verified with `ffprobe-static`. The same
timeline engine also ships vertical and square cuts (story / post / 4:5) and a
lightweight 720p hero.

| File | What it is |
|---|---|
| [`promo.html`](promo/promo.html) | The whole composition. Self-contained 1920×1080 canvas, no external assets, deterministic JS timeline. |
| [`record.mjs`](promo/record.mjs) | Recorder + encoder + verifier. One command reproduces the deliverables. |
| [`reelforge-promo.mp4`](reelforge-promo.mp4) | The 16:9 master: 30.000 s, 1920×1080, H.264 High/yuv420p, AAC 48 kHz, faststart, ~1.9 MB. |
| [`reelforge-promo-poster.jpg`](reelforge-promo-poster.jpg) | Poster frame (wordmark + tagline, captured at 2.4 s). |
| [`reelforge-promo-720p.mp4`](reelforge-promo-720p.mp4) | Lightweight hero: 1280×720, 30 s, 0.77 MB, mono AAC tone bed. |
| [`promo/promo-story.html`](promo/promo-story.html) | 1080×1920 story cut (IG story + WhatsApp status), 18 s, safe areas respected. |
| [`promo/promo-square.html`](promo/promo-square.html) | 1080×1080 feed post cut, 18 s. |
| [`promo/promo-4x5.html`](promo/promo-4x5.html) | 1080×1350 feed cut, 18 s. |
| [`promo/social.css`](promo/social.css) + [`promo/social.js`](promo/social.js) | Shared styles + 18 s timeline engine behind the three social cuts. |
| [`promo/record-social.mjs`](promo/record-social.mjs) | One command for all social cuts + the 720p hero. |
| [`reelforge-story-9x16.mp4`](reelforge-story-9x16.mp4), [`reelforge-post-1x1.mp4`](reelforge-post-1x1.mp4), [`reelforge-feed-4x5.mp4`](reelforge-feed-4x5.mp4) | The social outputs (+ a poster JPG each). |
| [`promo/frames/`](promo/frames/) | Eight 16:9 storyboard frames plus three review frames per social cut. |

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

## Social cuts — story / post / 4:5 (18 s)

One command renders every social cut **and** the lightweight 720p hero:

```sh
node docs/media/promo/record-social.mjs          # --fps 60 · --silent · --keep
```

The three HTML files are thin wrappers around the shared `social.css` +
`social.js` timeline engine (local files, still zero network requests); the
format is declared as `<body data-format="story|square|feed45">`. `social.js`
exposes the same `?t=` seek, `window.__start()` and `window.__ready` contract as
the 16:9 composition.

| Variant | File | Dimensions | Duration | Bytes |
|---|---|---|---|---|
| story 9:16 (IG story + WhatsApp status) | `reelforge-story-9x16.mp4` | 1080×1920 | 18.00 s | 800,249 (0.76 MB) |
| post 1:1 (IG feed) | `reelforge-post-1x1.mp4` | 1080×1080 | 18.00 s | 803,533 (0.77 MB) |
| feed 4:5 (IG feed) | `reelforge-feed-4x5.mp4` | 1080×1350 | 18.00 s | 786,772 (0.75 MB) |
| hero 720p (from the 16:9 master) | `reelforge-promo-720p.mp4` | 1280×720 | 30.02 s | 809,326 (0.77 MB) |

Posters at 8.6 s: `reelforge-story-9x16-poster.jpg`, `reelforge-post-1x1-poster.jpg`,
`reelforge-feed-4x5-poster.jpg`. Review frames: `promo/frames/{story,post,feed}/frame-01..03.jpg`
(at 1.5 s, 8.6 s, 15.5 s).

### Safe areas

Instagram/WhatsApp cover the top 250 px and bottom 250 px of a 1080×1920 story,
so every scene is a flex column inside the middle **250 … 1670 px** band (CSS
`--safe-top` / `--safe-bottom`). The recorder seeks to five points in the
storyboard and measures the real bounding boxes of the hook lines, typed
instruction, URL chip, output cards, provider headline/sub/marquee and end-card
text, asserting `top ≥ 250` and `bottom ≤ 1670`. The square and 4:5 cuts use
64 px / 80 px safe bands. Measured story content spans y 278…1394 px.

### Storyboard (18 s, same timeline for all three canvases)

| Time | Beat | Detail |
|---|---|---|
| 0.00–2.50 | Hook | *"Your product demos, written by the product."* on three lines, last line ember; lines ease up at 0.16/0.30/0.44 s; hold to 2.5. |
| 2.50–6.45 | Instruction → tap → zoom | Label; *"Sign in, create a project, invite a teammate."* types on 3.0–4.35 s; `your-product.com` chip 4.45 s; browser frame 4.2–4.9 s; ember tap ripple at 5.0 s; the page camera-zooms 5.2–6.25 s. |
| 6.15–10.30 | Four outputs | *One capture, four outputs*: Video · Article · Walkthrough · Guide. Story = four stacked cards sliding in (186 px each, ember spine growing); square/feed = 2×2 grid. Stagger 6.45 s + 0.24 s. The story-specific hero moment. |
| 10.00–13.80 | Provider wall | *31 model providers* + *"Bring your own key — or run fully offline."* Two compact linear marquees stream (free+local / paid) at 54 / 72 px/s. |
| 13.50–18.00 | End card | REELFORGE 13.65 s; ember rule 13.9 s; *"Open source · MIT · Free forever"* 14.05 s; `github.com/Majeed-GitHub/reelforge` 14.3 s; **↳ link in bio** 14.6 s; fade to black 17.25–18 s. |

### Verification

`node docs/media/promo/record-social.mjs` → **SOCIAL RECORD PASS — 42/42 checks**.
Per variant it asserts: composition meta + exact stage size (no scroll), key text
inside the safe area, end card contains the repo URL on-screen (and 16.9–18.2 %
bright pixels measured inside the URL box of `frame-03.jpg`), zero external
http(s) requests, zero page errors, exact dimensions + H.264/yuv420p, duration
18 s ±1 s, < 4 MB, audio present, poster rendered (not blank), 3/3 frames.
The 720p hero is transcoded from `reelforge-promo.mp4` at CRF 26 with 48 kHz mono
audio and checked for 1280×720, ~30 s, < 900 KB and an audible tone bed.

