# Embedding a Reelforge demo

Every finished demo can be dropped into your own site, docs, changelog or blog as
a **16:9 iframe player** — no JavaScript bundle, no third-party embed script, no
external fonts or CDNs. The player is plain HTML + native `<video>` served by your
own Reelforge instance, so it works on any static host that allows iframes.

The same page counts views for you: see [Analytics](#analytics) and
[Privacy](#privacy).

---

## 1. Get the embed code

```bash
curl http://127.0.0.1:4400/api/demos/$DEMO_ID/embed \
  -H "X-API-Key: $REELFORGE_API_KEY"
```

```json
{
  "message": "Embed ready — paste the iframe snippet wherever the demo should appear.",
  "data": {
    "url": "http://127.0.0.1:4400/embed/<token>",
    "iframe": "<iframe src=\"http://127.0.0.1:4400/embed/<token>\" width=\"640\" height=\"360\" title=\"…\" loading=\"lazy\" allow=\"autoplay; fullscreen; picture-in-picture; encrypted-media\" allowfullscreen referrerpolicy=\"no-referrer\" style=\"border:0;width:100%;max-width:960px;aspect-ratio:16/9\"></iframe>"
  }
}
```

Paste the `iframe` field as-is (Markdown, MDX, HTML, a CMS “embed” block, a
newsletter template — anything that accepts raw HTML). Or build your own with
`url` as the `src`.

The token is an HMAC-signed claim over the demo id with a **90-day** TTL. It is
unlisted (`noindex`) and names exactly one demo. Rotating the instance secret
(`data/.secret`) revokes every embed and share link at once.

## 2. Parameters

Append them to the embed `url` (not to the iframe attribute soup — a clean
snippet is: `<iframe src="<url>?autoplay=1&muted=1" …>`).

| Parameter | Values | Default | Effect |
|---|---|---|---|
| `autoplay` | `1` | off | Starts playback on load. **Implies muted** (browsers block audible autoplay). |
| `muted` | `0` \| `1` | off | Mutes (or unmutes) the initial playback. Ignored when `autoplay=1`. |
| `loop` | `1` | off | Loops the video forever — good for a silent background demo. |
| `start` | seconds (`12`) | `0` | Starts playback at that offset using an MP4 media fragment (`#t=12`). |
| `badge` | `0` \| `1` | `1` | `badge=0` removes the quiet “Made with Reelforge” corner mark. |

Examples:

```html
<!-- click-to-play, branded (the default) -->
<iframe src="https://reelforge.example.com/embed/<token>" width="640" height="360" title="Product demo" loading="lazy" allowfullscreen style="border:0;width:100%;max-width:960px;aspect-ratio:16/9"></iframe>

<!-- silent autoplay loop, no badge -->
<iframe src="https://reelforge.example.com/embed/<token>?autoplay=1&muted=1&loop=1&badge=0" …></iframe>

<!-- jump to the interesting part -->
<iframe src="https://reelforge.example.com/embed/<token>?start=14" …></iframe>
```

## 3. Sizing

The player fills its iframe and letterboxes the video to **16:9** with
`object-fit: contain`, so it stays correct at any size. Two good options:

```html
<!-- intrinsic 16:9 -->
<iframe src="…" width="640" height="360" style="border:0" allowfullscreen></iframe>

<!-- responsive, keeps 16:9 at any container width -->
<div style="position:relative;width:100%;aspect-ratio:16/9">
  <iframe src="…" style="position:absolute;inset:0;width:100%;height:100%;border:0"
          allowfullscreen loading="lazy"></iframe>
</div>
```

The generated snippet already uses `width:100%; max-width:960px; aspect-ratio:16/9`.
Do not set a fixed height without a matching width, or the black letterbox bars
will grow.

## 4. Captions

If the demo has a completed **WebVTT** export, the player includes a real
`<track kind="captions" default>` — viewers can toggle it with the player’s
native captions button, and it also works with OS/browser caption preferences.

Create the captions once:

```bash
curl -X POST http://127.0.0.1:4400/api/demos/$DEMO_ID/exports \
  -H "X-API-Key: $REELFORGE_API_KEY" -H "Content-Type: application/json" \
  -d '{ "kind": "vtt" }'
```

The embed picks the newest completed VTT automatically on the next load. If none
exists, the player simply has no caption track (the burned-in captions from the
MP4 are of course still visible in the video itself).

The `<video>` is marked `crossorigin="anonymous"` so a caption file served from
the API origin can be read by a player framed on another origin. If you put a
CDN/proxy in front of the API, keep `Access-Control-Allow-Origin` on the
`/api/files/*` responses (the API’s CORS plugin already sets `*`).

## 5. CSP and framing notes

The embed page is the **only** route in the API that is allowed to be framed. It
sends, on every response (including the HTML error page):

```
Content-Security-Policy: frame-ancestors *
```

and it never sends `X-Frame-Options`. Nothing else changes: `/app`, `/api/*` and
the share page keep exactly the headers they had before, and none of them gain a
`frame-ancestors` header.

If the site *doing the embedding* has its own Content-Security-Policy, add the
Reelforge origin to it:

```http
Content-Security-Policy: frame-src https://reelforge.example.com;
```

`X-Frame-Options` on **your** page does not matter for child frames — only your
`frame-src`/`child-src` directives do.

Public deployments: set `REELFORGE_PUBLIC_URL` to the externally reachable
origin. The embed URL (and the iframe snippet) are built from it; with the
default it points at `http://127.0.0.1:<port>` and will not work for visitors.

## 6. Analytics

The share page, the embed player and the walkthrough each record **one row per
load**. Owners can read the rollup:

```bash
curl http://127.0.0.1:4400/api/demos/$DEMO_ID/analytics \
  -H "X-API-Key: $REELFORGE_API_KEY"
```

```json
{
  "message": "OK",
  "data": {
    "views": {
      "total": 5,
      "today": 5,
      "last7": 5,
      "bySurface": { "embed": 3, "share": 2 }
    },
    "firstViewedAt": "2026-11-07T11:40:12.345Z",
    "lastViewedAt": "2026-11-07T11:41:03.998Z"
  }
}
```

| Field | Meaning |
|---|---|
| `views.total` | All recorded views for this demo, all time. |
| `views.today` | Views whose UTC day is today. |
| `views.last7` | Views in the last 7 UTC calendar days, **including today**. |
| `views.bySurface` | Counts per surface that has views: `share`, `embed`, `walkthrough` (and `dashboard`, reserved). Surfaces with zero views are omitted. |
| `firstViewedAt` / `lastViewedAt` | ISO timestamps of the first/last view, or `null`. |

Notes:

- Counts are per **load**, not unique viewers — there is no way to tell one
  person reloading from three people, by design (no identifiers are stored).
- Obvious crawlers, link unfurlers and uptime monitors are **not** counted:
  the request’s User-Agent is classified as `bot` / `human` / `unknown` in
  memory and only the non-bot loads are written. The classification itself is
  not stored either.
- `dashboard` is a reserved surface value for a future dashboard-side view.

## 7. Privacy

Explicitly, the analytics design is:

- **No IP addresses** are read, logged or stored.
- **No User-Agent strings** are stored. The header is inspected in memory only to
  bucket the request as bot/human/unknown and to drop crawlers.
- **No cookies**, no fingerprinting, no client-side script, no localStorage.
- **No third-party requests.** The embed has zero external assets: no fonts, no
  CDNs, no analytics SaaS. It only requests the video/poster/captions from your
  own Reelforge instance.
- The only stored fields are: `id`, `demo_id`, `surface`, `day`
  (`YYYY-MM-DD`, UTC), `created_at`. That is the whole `demo_views` table — it
  carries no PII and cannot identify a visitor.
- Analytics is workspace-scoped and requires the API key; the numbers are not
  public. The counters are deliberately coarse (“this demo was opened N times”).

Because there are no identifiers, GDPR-style “data subject” requests cannot be
fulfilled for views — there is nothing to find or delete — which is the point.

## 8. Limits and troubleshooting

| Symptom | Cause |
|---|---|
| Iframe stays empty / “refused to connect” | The embedding site’s CSP lacks this origin in `frame-src`; or you are embedding a *local* `127.0.0.1` URL from another machine. |
| Video shows but no captions button | No completed VTT export for that demo — run the export request above. |
| Autoplay does not start | Browser autoplay policy; the player already forces `muted` for `autoplay=1`, but some browsers still require a user gesture on first visit. |
| Embed says “link is invalid or has expired” | The 90-day token expired, or `data/.secret` was rotated. Re-fetch `GET /api/demos/:id/embed`. |
| Analytics stay at zero | Views are recorded on the **embed page** load, not on API calls; check you’re loading `/embed/<token>`, not `/api/demos/...`. |

The player intentionally has no JavaScript, so it cannot phone home, resize
itself beyond CSS, or block your page’s load: the iframe snippet uses
`loading="lazy"`.
