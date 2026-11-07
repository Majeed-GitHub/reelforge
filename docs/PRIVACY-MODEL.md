# Privacy model

Reelforge records products, not people. This page states exactly what is captured,
what is stored, what leaves the machine — and the two limits worth knowing before
you demo someone else's account.

## What a recording can see

| | |
|---|---|
| **Captured** | The page the headless browser is driving: its pixels, its DOM (for the planner and for selectors), and the screenshots taken at each step. |
| **Never captured** | Your desktop, other applications, other browser windows, your microphone, your camera, or your clipboard. There is no OS-level capture path in this project — the browser is the whole recording surface. |
| **Stored where** | `<data>/videos`, `<data>/raw`, `<data>/screenshots` on the machine running the API. Nothing is uploaded. |

This is a different threat model from a desktop screen recorder (Loom, Screen Studio,
Screenforge's own desktop app): those capture whatever is on your display, so a
notification can end up in a customer's video. A demo agent cannot capture anything it
was not pointed at.

## Sensitive data inside the page

Two layers, both on by default, both controllable per request.

1. **Screenshots are masked at capture** (`options.redactSensitive`, default on).
   Playwright's native screenshot mask paints over `input[type=password]`,
   `autocomplete="cc-*"`/`one-time-code`, and any field whose name/id/test-id looks like
   `card|cvv|ssn|secret|token|api-key|password`. Add your own with
   `options.redactSelectors`. Typed values are stored as `••••` and log lines are
   scrubbed of bearer tokens and API keys.
2. **The video is blurred while the field is on screen** — the same boxes come back with
   a step index, and the renderer blurs them only inside that step's time window
   (merging contiguous steps, never bridging a gap). A field that leaves the screen
   stops being blurred because it is no longer visible.

Fail-closed: if masking throws, no unmasked screenshot is written.

Known gaps, stated rather than hidden: closed shadow roots, iframes, values painted into
`<canvas>` or images, and a secret sitting in prose unless you name a selector around it.

## The privacy screen (dashboard)

When you share your screen on a call, the *dashboard* is the leak — it lists demo
instructions, customer URLs and thumbnails.

**Shift+P** (or the eye toggle in the top bar) masks instructions, hosts, thumbnails,
posters, article titles, guide names and environment URLs behind a blur plus a
placeholder. Click one item to reveal it for a few seconds. Hover never reveals, because
a hover fires on the shared screen too when the presenter's mouse moves.

## Viewer-side privacy

- **View counts** are a row per view: `id`, `demo_id`, `surface`, `day`, `created_at`.
  No IP address, no user-agent string, no cookies, no third-party script. User agents are
  classified in memory only, so crawlers do not inflate the numbers.
- **Share, embed and walkthrough links** are HMAC-signed tokens with an expiry
  (30–90 days). Rotating `<data>/.secret` revokes every outstanding link.
- **Embedded players** are framed with `frame-ancestors *` on that route only; nothing
  else in the app can be framed.

## Credentials and keys

| Secret | At rest | In transit |
|---|---|---|
| Captured browser sessions (`storageState`, incl. IndexedDB) | AES-256-GCM, `<data>/.secret` keyfile | never leaves the API process except to launch the browser |
| Model provider API keys (pasted in the dashboard) | AES-256-GCM, scoped to the workspace | sent only to the provider you chose |
| Workspace API keys (`rg_…`) | SHA-256 hash only; the plaintext is shown once | `X-API-Key` header |
| Webhook signing secret | AES-256-GCM | used to HMAC the delivery body |

There is **no telemetry and no analytics endpoint** in this codebase. The only outbound
traffic is: to the product you asked it to record, to the model provider you configured,
and to webhook URLs you set.

## Limits worth knowing

- **Passkeys cannot be replayed** — WebAuthn credentials are bound to origin *and*
  device. Use a password or SSO test account.
- **Native window exclusion is not a thing here.** "Hide this window from screen
  capture" (Windows `SetWindowDisplayAffinity`, macOS `NSWindow.sharingType`) applies to
  desktop applications. Reelforge is a web app plus a headless browser, so the relevant
  controls are the privacy screen above and the fact that only the driven page is ever
  recorded.
- **Self-hosted means self-governed**: if you expose the API to the internet, put it
  behind TLS and a reverse proxy, and treat `data/` as the sensitive directory it is.
  See [DEPLOY.md](DEPLOY.md) and [SECURITY.md](../SECURITY.md).
