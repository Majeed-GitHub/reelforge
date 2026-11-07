# Reelforge — marketing site

A single static page, no build step, no framework, no CDN. Fonts and screenshots are
self-hosted so the page is fast and works offline.

```
site/
├── index.html          the page
├── styles.css          all styling (design tokens at the top)
├── app.js              ~120 lines of progressive enhancement
├── assets/
│   ├── fonts/          Instrument Serif + Manrope (both OFL, self-hosted)
│   └── img/            screenshots from docs/images, copied in
├── media/              promo video + poster (produced by docs/media/promo)
└── test/
    ├── site-smoke.mjs  browser checks: overflow, console errors, copy, reveal, a11y basics
    └── find-overflow.mjs  diagnostic that names the element widening the page
```

## Design notes

The brief was "quiet luxury", so the page is deliberately restrained rather than loud:

- **Type** — Instrument Serif for display, Manrope for body. No Inter, no system-ui headline.
- **Colour** — near-black canvas, one ember accent (`#FF5C38`), warm greys. The only light
  surface is the licence section, which is what makes it feel like a printed insert.
- **Space** — 8pt rhythm, hairline rules instead of boxes, generous section padding that
  scales with `clamp()`.
- **Motion** — one orchestrated thing: a staggered scroll reveal. Everything else is a
  200 ms hover. `prefers-reduced-motion` turns it all off.
- **Texture** — a 3.5% SVG noise overlay so the black has grain instead of reading flat.

## Run it locally

```bash
npx serve site          # or: python -m http.server -d site 8080
```

Opening `index.html` from the filesystem also works, except the font preload and the video
(preloads are ignored over `file://` on some browsers).

## Verify

```bash
node site/test/site-smoke.mjs      # 18 checks: overflow at 390/1440, console errors, copy, reveal, reduced motion
node site/test/find-overflow.mjs   # names any element that widens the page
```

## Deploy to GitHub Pages

The repo ships `.github/workflows/pages.yml`, which publishes this folder as-is.

One-time setup, in the repository:

1. **Settings → Pages → Build and deployment → Source: `GitHub Actions`**
2. Push anything under `site/`, or run the *Deploy site* workflow manually.

The site then lives at `https://<owner>.github.io/reelforge/`. If you use a custom domain,
add a `CNAME` file in this folder and set the domain under Settings → Pages.

Any static host works identically (Vercel, Netlify, Cloudflare Pages, S3): the folder is
the artifact, there is nothing to compile.

## Editing rules

- Keep it build-less. If a change needs a bundler, it probably belongs in the product, not here.
- Keep `index.html` semantic: one `h1`, real landmarks, no `div` soup for text.
- Any new animation must respect `prefers-reduced-motion` (the media query at the bottom of
  `styles.css` handles it globally, but check interactive pieces individually).
- Run the smoke test before committing; the overflow check is the one that catches the
  classic "one long `<pre>` line widens the whole page on a phone" bug.
