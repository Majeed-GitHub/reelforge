# Reelforge outputs — video, articles, GIFs, captions, share pages, webhooks, walkthroughs

Reelforge turns one recording into more than a video. This document covers
everything a demo produces once it reaches `complete`, and how to get it out of
the instance: **webhooks (including Slack)**, **public share pages**, **GIF
previews**, **WebVTT captions**, **clickable walkthroughs**, plus the
video/article/guide that already ship in v0.1.

```
POST /api/demos
      │
      ▼
  browser capture ──► narrated MP4 + poster + SRT
      │
      ├─ Product Graph flow ──► help-centre article ──► in-app guide
      │
      ├─ POST /api/demos/:id/exports { kind: "gif" }  ──► looping preview GIF
      ├─ POST /api/demos/:id/exports { kind: "vtt" }  ──► WebVTT captions
      ├─ GET  /api/demos/:id/share                     ──► 30-day public page
      ├─ POST /api/demos/:id/walkthrough               ──► one self-contained HTML walkthrough
      └─ demo.complete / demo.failed                   ──► webhook POST
```

All media (video, poster, GIF, VTT, walkthrough HTML) is served from the same
signed-URL mechanism: `GET /api/files/<token>`, HMAC-SHA256 over
`{ path, expiry }` with the instance's local secret, **1 hour** TTL, no API key
needed (a `<video src>` cannot send headers). Share pages re-sign those media
URLs on every page load.

---

## 1. The finished video

`GET /api/demos/:id` → `videoUrl`, `posterUrl`, `srtUrl`, `durationMs`,
`creditsUsed`, `outcome`.

The MP4 is the source of truth every other output derives from: H.264 +
`yuv420p` + `+faststart`, auto-zoom, narration muxed per line, captions burned
from the generated SRT.

## 2. Article + in-app guide

The completion path upserts the recording into the Product Graph and exposes
`POST /api/articles/from-flow` (`channel: "help_center" | "internal_training"`)
and `GET /api/guides`, `GET /api/guides/embed/:embedKey`. The guide embed is the
only one of these that is public, and it is what the widget at `/g/guide.js`
walks.

## 3. GIF previews

A looping, 3–4 second GIF is the thing people actually paste into Slack,
READMEs and bug reports. It is rendered from the finished MP4, not from the raw
capture.

### Request

```bash
curl -X POST http://127.0.0.1:4400/api/demos/$DEMO_ID/exports \
  -H "X-API-Key: $REELFORGE_API_KEY" -H "Content-Type: application/json" \
  -d '{ "kind": "gif" }'
# → { "message": "Export queued (animated GIF preview).",
#     "data": { "id": "exp_…", "kind": "gif", "status": "queued" } }
```

Poll the list until `status` is no longer `queued`:

```bash
curl http://127.0.0.1:4400/api/demos/$DEMO_ID/exports -H "X-API-Key: $REELFORGE_API_KEY"
# → { "data": { "exports": [
#       { "id": "exp_…", "kind": "gif", "status": "complete",
#         "url": "/api/files/<signed>", "bytes": 1482913 } ] } }
```

| Field | Meaning |
|---|---|
| `id` | Export id (`exp_…`). |
| `kind` | `gif` or `vtt`. |
| `status` | `queued` → `running` → `complete` \| `failed`. |
| `url` | Signed **path** (`/api/files/…`), same-origin; append it to the API origin (or use it directly in a page served by the API). `null` until complete. |
| `bytes` | File size on disk, `null` until complete. |

An unsupported `kind` (say `mp4`) returns **501** with the normal error
envelope — `{ code: "VALIDATION_ERROR", message: …, remediation: { action:
"use_supported_export", … } }` — so a dashboard can disable the button instead
of hitting an internal error. A demo that is not `complete` yet returns **409**
with the same envelope.

### How the moment is chosen and encoded

1. Read the demo's recorded steps. Each step carries the bounding box of the
   element it acted on. The step with the **largest box area** wins — a
   full-width form or modal reads far better at thumbnail size than a 40 px nav
   link. The loop is centred on that step's click and clamped to the video.
2. One ffmpeg pass:

   ```
   -ss <start> -t 3.5 -i demo.mp4
   -filter_complex "[0:v]fps=12,scale=720:-1,split[a][b];
                    [a]palettegen=max_colors=128:stats_mode=diff[p];
                    [b][p]paletteuse=dither=bayer:bayer_scale=3"
   -loop 0 out.gif
   ```

   `palettegen`/`paletteuse` gives a per-clip palette instead of the 256-colour
   web-safe one, which is the difference between "banded mess" and "looks like
   the video".
3. Width is capped at **720 px**; if the first encode is over **2 MB** the
   renderer retries at 10 fps / 96 colours and 8 fps / 64 colours, so the result
   is always paste-able. The 3–4 s loop length keeps even 720p clips inside the
   budget.

Files land at `data/exports/<demoId>/preview-<exportId>.gif`.

## 4. WebVTT captions

The MP4 gets burned-in captions from an SRT. A `.vtt` is the same cues in the
format web players, `<track>`, and most editors actually consume.

### Request

```bash
curl -X POST http://127.0.0.1:4400/api/demos/$DEMO_ID/exports \
  -H "X-API-Key: $REELFORGE_API_KEY" -H "Content-Type: application/json" \
  -d '{ "kind": "vtt" }'
# → { "data": { "id": "exp_…", "kind": "vtt", "status": "queued" } }
```

When the demo has a rendered SRT, the export is a **verbatim conversion of the
burned SRT** (`HH:MM:SS,mmm` → `HH:MM:SS.mmm`, `WEBVTT` header, blank-line
separated cues). If the SRT is missing, the cues are rebuilt from the persisted
step timings with the same minimum-display and gap rules the renderer uses, so
the two never drift.

```vtt
WEBVTT

1
00:00:02.050 --> 00:00:03.754
Open the sign-in form.

2
00:00:03.985 --> 00:00:05.654
Sign in to the workspace.
```

Timestamps are **relative to the finished video** (t = 0 is the first frame),
not to the browser session, so `video` + `track` line up exactly. Files land at
`data/exports/<demoId>/captions-<exportId>.vtt` and are served as `text/vtt`.

Use it in a player:

```html
<video controls src="/api/files/<signed mp4>">
  <track default kind="captions" srclang="en" src="/api/files/<signed vtt>" />
</video>
```

## 5. Public share pages

Send anyone a link that renders a clean, self-contained page — no account, no
API key, no dashboard.

### Create the link

```bash
curl http://127.0.0.1:4400/api/demos/$DEMO_ID/share -H "X-API-Key: $REELFORGE_API_KEY"
# → { "message": "Share link created — valid for 30 days.",
#     "data": { "url": "http://127.0.0.1:4400/api/share/<token>",
#               "expiresAt": "2026-12-07T12:00:00.000Z" } }
```

`GET /api/share/<token>` is public. The page is a single HTML document with
inlined CSS and no JavaScript; its only external references are the signed
poster and video URLs. It shows:

- the **instruction** as the `<h1>`,
- a `<video controls>` (plus the poster) pointing at a freshly signed MP4 URL,
- status, recording date and **duration**,
- the **goal-met** verdict and up to eight "what this demo shows" lines,
- **"Read the step-by-step article"** when the demo's flow has an article
  (published URL when set, otherwise the dashboard deep link).

### Behaviour and limits

| Property | Value |
|---|---|
| Token | HMAC-SHA256 over `{ demoId, expiry }` with the instance secret. |
| TTL | **30 days**. Expired links return a rendered HTML "expired" page (HTTP 404), never JSON. |
| Auth | None — the token *is* the capability. `noindex, nofollow` + `x-robots-tag` are set. |
| Media | Poster/video URLs are signed for 1 hour and **re-signed on every page load**, so the page keeps working for the whole 30 days. |
| Revocation | Rotating `data/.secret` invalidates every share link (and every media URL). |
| Scope | The token names one demo id; it cannot list or read anything else. |

Anyone with the link can view that one demo. Treat it like a public URL, not a
secret.

## 6. Webhooks

Per-workspace webhook config lives in `workspace_settings` under
`webhook.url` / `webhook.secret` (the secret is encrypted at rest with the same
local keyfile that protects stored sign-ins and is never returned by the API).

### Manage it

```bash
# Save (secret optional; omit it to keep the existing one, send null to clear)
curl -X POST http://127.0.0.1:4400/api/webhooks \
  -H "X-API-Key: $REELFORGE_API_KEY" -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/hooks/reelforge", "secret": "whsec_…" }'
# → { "data": { "url": "https://example.com/hooks/reelforge",
#               "hasSecret": true,
#               "lastDelivery": { "at": "2026-11-07T12:00:00.000Z", "ok": true, "status": 200 } } }

curl http://127.0.0.1:4400/api/webhooks -H "X-API-Key: $REELFORGE_API_KEY"   # same shape
curl -X DELETE http://127.0.0.1:4400/api/webhooks -H "X-API-Key: $REELFORGE_API_KEY"
```

`lastDelivery` is written after every real delivery attempt (including the test
button), so the dashboard can show the last status at a glance.

### Send a test event

```bash
curl -X POST http://127.0.0.1:4400/api/webhooks/test \
  -H "X-API-Key: $REELFORGE_API_KEY" -H "Content-Type: application/json" -d '{}'
# → { "data": { "delivered": true, "status": 200, "latencyMs": 88 } }
```

The test goes through the real delivery path — same body builders, same
signature, same timeout and retry — against the workspace's most recent
completed demo (or a sample body when there is none).

### When it fires

The worker pipeline fires exactly two events, **after** the demo row and the
Product Graph/article/guide are written:

| Event | When |
|---|---|
| `demo.complete` | The MP4, poster and SRT finished and the demo row is `complete`. |
| `demo.failed` | The pipeline failed (agent error, render error, unreachable target, …). |

Delivery is **fire-and-forget**: a webhook that hangs or 500s is logged and
swallowed. It can never fail, block or delay the demo that produced it.

### Delivery contract

| Property | Value |
|---|---|
| Method | `POST`, `application/json; charset=utf-8` |
| Timeout | **5 s** per attempt |
| Retries | **1**, after a **500 ms** backoff (so 2 attempts max) |
| Success | Any `2xx` |
| Headers | `X-Reelforge-Signature: sha256=<hex>` (only when a secret is set), `X-Reelforge-Event: demo.complete` |
| Signature | HMAC-SHA256 of the **raw request body bytes**, lowercase hex, prefixed `sha256=` |
| Body | JSON event object (see below), or `{ text, blocks }` for Slack |
| Failure handling | Logged (`[webhook] demo.complete delivery failed after 2 attempt(s)…`), never retried again, never surfaced to the demo |

### Payload

```json
{
  "event": "demo.complete",
  "timestamp": "2026-11-07T12:00:00.000Z",
  "demo": {
    "id": "dem_e4wqphjy",
    "status": "complete",
    "durationMs": 32549,
    "creditsUsed": 0.542,
    "videoUrl": "http://127.0.0.1:4400/api/files/<signed>",
    "posterUrl": "http://127.0.0.1:4400/api/files/<signed>",
    "outcome": { "goalMet": true, "stepsCompleted": 11, "whatWasShown": ["Open the sign-in form.", "…"] }
  },
  "flow": { "id": "flw_…", "name": "Sign in then create project", "status": "fresh", "signature": "617d4a55e9fa0a75", "stepCount": 11 },
  "article": { "id": "art_…", "title": "Sign in then create project", "slug": "sign-in-then-create-project", "channel": "help_center", "status": "draft", "url": "http://127.0.0.1:4400/app/#/articles/art_…" },
  "guide": { "id": "gde_…", "name": "Sign in then create project", "status": "draft", "embedKey": "c521965e572be97cfb0dc4aa", "embedUrl": "http://127.0.0.1:4400/api/guides/embed/c521965e572be97cfb0dc4aa", "stepCount": 10 }
}
```

- `flow`, `article` and `guide` are **omitted** when the workspace has none.
- A failed run uses the same shape with `"event": "demo.failed"`, `"status":
  "failed"`, `outcome: null`, and an extra
  `demo.failure: { code, message, remediation }` so the receiver knows *why*.
- `videoUrl` / `posterUrl` are signed and expire after **1 hour**; re-read
  `GET /api/demos/:id` for fresh URLs.

### Verify the signature (Node 25, no dependencies)

```js
import crypto from 'node:crypto';
import http from 'node:http';

const SECRET = process.env.REELFORGE_WEBHOOK_SECRET;

http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks); // the exact bytes we signed
      const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
      const received = String(req.headers['x-reelforge-signature'] ?? '');

      const ok =
        received.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));

      if (!ok) {
        res.writeHead(401).end('bad signature');
        return;
      }

      const event = JSON.parse(raw.toString('utf8'));
      console.log(event.event, event.demo.id, event.demo.durationMs, event.demo.outcome?.goalMet);
      res.writeHead(200).end('ok');
    });
  })
  .listen(9099, '127.0.0.1');
```

### Verify the signature (Python 3, standard library)

```python
import hashlib, hmac, json
from http.server import BaseHTTPRequestHandler, HTTPServer

SECRET = b"whsec_change_me"

class Hook(BaseHTTPRequestHandler):
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length", 0)))
        expected = "sha256=" + hmac.new(SECRET, raw, hashlib.sha256).hexdigest()
        received = self.headers.get("X-Reelforge-Signature", "")
        if not hmac.compare_digest(expected, received):
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b"bad signature")
            return

        event = json.loads(raw)
        print(event["event"], event["demo"]["id"], event["demo"]["durationMs"])
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

HTTPServer(("127.0.0.1", 9099), Hook).serve_forever()
```

Sign the **raw body** — re-serialising the parsed JSON can change key order or
whitespace and will break the comparison.

### Slack

Point the webhook URL straight at a Slack incoming webhook
(`https://hooks.slack.com/services/T000/B000/XXXX`). Reelforge detects that host
and sends `{ text, blocks }` instead of the event JSON, so no adapter is needed:

- a header (`✅ Reelforge demo is ready` / `⚠️ Reelforge demo failed`),
- the instruction, and the failure reason on failed runs,
- status / duration / credits / goal-met fields,
- actions: **Watch the demo** and **Read the article** (when those URLs exist).

The signature header is still sent for consistency; Slack ignores it. If you set
a `secret`, note that the signature covers the Slack-shaped body, not the event
JSON.

Setup:

1. In Slack: **Apps → Incoming Webhooks → Add to Slack**, pick a channel, copy
   the URL.
2. `POST /api/webhooks { "url": "https://hooks.slack.com/services/…" }`.
3. `POST /api/webhooks/test` — a message should land in the channel within a
   second.
4. Record a demo; the next `demo.complete` posts itself.

Use a Slack *workflow* webhook instead if you need the raw JSON event; those are
not on `hooks.slack.com` and receive the normal event body.

---

## 7. Clickable walkthrough

The one output Director explicitly does not have: the same capture — step
screenshots, element boxes, narration — turned into an **interactive
click-through demo**. Every step shows the real screenshot with a pulsing
hotspot over the element that was actually clicked, the narration as its
tooltip, and a `3 / 11` progress bar.

### Request

```bash
curl -X POST http://127.0.0.1:4400/api/demos/$DEMO_ID/walkthrough \
  -H "X-API-Key: $REELFORGE_API_KEY" -H "Content-Type: application/json" -d '{}'
# → { "message": "Walkthrough generated — 11 steps, 322 KB, one self-contained file.",
#     "data": { "url": "http://127.0.0.1:4400/api/walkthrough/<token>",
#               "bytes": 329196, "steps": 11 } }
```

| Field | Meaning |
|---|---|
| `url` | Public, 90-day HMAC-signed URL. No API key needed. |
| `bytes` | Size of the generated HTML file. |
| `steps` | Number of recorded steps covered. |

A demo that is not `complete`, or has no recorded steps, returns **409** with
the normal error envelope.

### One file, no server

The output is `data/exports/<demoId>/walkthrough-<exportId>.html`:

- inline CSS and inline JS — no framework, no build step at view time;
- every step screenshot embedded as a base64 `data:image/png` URI;
- no `<script src>`, no `<link href>`, no web fonts, no CDNs, no relative
  assets;
- a CSP meta tag (`default-src 'none'; img-src data:; style-src
  'unsafe-inline'; script-src 'unsafe-inline'`) makes the promise enforceable
  by the browser.

So it can be emailed as an attachment, dropped on any static host, attached to a
ticket, or opened straight from disk (`file://`) with no network at all.

**Size budget.** 11 screenshots at 1280×720 come to ~320 KiB. The generator logs
a warning if a file exceeds **8 MB** and still returns it — there is no hard
failure.

### Interaction

| Action | Result |
|---|---|
| Click the pulsing hotspot | next step |
| Click anywhere on the image when that step recorded no box | next step |
| `Next` / `Back` buttons | next / previous |
| `→` / `↓` / `PageDown` | next |
| `←` / `↑` / `PageUp` | previous |
| `Esc` (or `Home`) | close the walkthrough (back to the title screen) |
| `Start` / `Restart` | begin at step 1 |

The title screen shows the instruction, step count, duration and recording date.
Progress is `3 / 11` plus a filled bar (`role="progressbar"` with
`aria-valuenow`); a polite live region announces each step and its narration;
focus moves to the current hotspot, so the walkthrough is fully keyboard-operable;
and `prefers-reduced-motion: reduce` disables the pulsing ring and transitions.

### Honest degradation

- **No screenshot** for a step → a text card with the narration and a
  "click to continue" affordance.
- **No box** for a step (e.g. the final wait/verification step) → the whole
  screenshot becomes the click target, outlined with a dashed border.
- **No narration** → the step still appears, labelled `Step N`.

### Public link + first-class export

`GET /api/walkthrough/:token` serves the file with **no API key**; invalid or
expired tokens get a rendered HTML 404 page. The token is an HMAC claim over one
`demo_exports` row id, so it cannot read anything else; rotating `data/.secret`
invalidates it.

Each generated walkthrough is recorded in `demo_exports` with
`kind: "walkthrough"`, so it appears in the existing exports list and the
dashboard can offer it next to GIF/VTT:

```bash
curl http://127.0.0.1:4400/api/demos/$DEMO_ID/exports -H "X-API-Key: $REELFORGE_API_KEY"
# → { "data": { "exports": [ …,
#       { "id": "exp_…", "kind": "walkthrough", "status": "complete",
#         "url": "/api/files/<signed>", "bytes": 329196 } ] } }
```

That `url` is the standard 1-hour signed media path (`.html` is served as
`text/html`, so it opens directly in a new tab). Use the `url` from the POST
response when you need a link that keeps working for longer than an hour.

---

## API summary (v0.2 + v0.3 outputs)

| Method | Path | Auth | Body / result |
|---|---|---|---|
| `POST` | `/api/demos/:id/exports` | yes | `{ kind: "gif" \| "vtt" }` → `{ id, kind, status }` |
| `GET` | `/api/demos/:id/exports` | yes | → `{ exports: [ { id, kind, status, url, bytes } ] }` |
| `GET` | `/api/demos/:id/share` | yes | → `{ url, expiresAt }` |
| `GET` | `/api/share/:token` | **no** | self-contained HTML page |
| `POST` | `/api/demos/:id/walkthrough` | yes | `{}` → `{ url, bytes, steps }` |
| `GET` | `/api/walkthrough/:token` | **no** | self-contained HTML walkthrough (90-day token) |
| `GET` | `/api/webhooks` | yes | → `{ url, hasSecret, lastDelivery }` |
| `POST` | `/api/webhooks` | yes | `{ url, secret? }` → `{ url, hasSecret, lastDelivery }` |
| `DELETE` | `/api/webhooks` | yes | → `{ url: null, hasSecret: false, lastDelivery: null }` |
| `POST` | `/api/webhooks/test` | yes | `{}` → `{ delivered, status, latencyMs }` |
| `GET` | `/api/files/:token` | **no** | signed media (mp4, png, gif, vtt, html, …) |

Error responses are always the standard envelope:
`{ "code": …, "message": …, "remediation": { "action": …, "hint": … } }`.

## Things that are deliberately not here

- **No public article hosting.** The share page links to the article's
  `published_url` when a helpdesk sync set one, otherwise to the dashboard
  (which needs a key). Articles themselves are not exposed publicly.
- **GIF audio.** GIF has none; the preview is silent by design.
- **Export `kind`s stay a closed set.** `POST /api/demos/:id/exports` accepts
  only `gif` and `vtt`; walkthroughs have their own endpoint (`POST
  /api/demos/:id/walkthrough`). Unknown kinds return 501 so clients can
  feature-gate.
- **No walkthrough analytics or editing.** Generated files are static snapshots —
  no click telemetry, no visitor counts, and no in-place editing; re-record and
  regenerate instead.
- **Webhook replay queue.** Delivery is best-effort, one retry. If you need a
  durable log, point the URL at a queue (SQS, Zapier, n8n) and acknowledge 2xx
  immediately.
