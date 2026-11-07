# Reelforge — client guide

One page, no jargon. Forward this to whoever is evaluating it.

---

## What it is, in one paragraph

Reelforge is a self-hosted tool that records product demos **by driving the product itself**.
You give it your app's URL and one sentence ("Sign in, create a project, invite a teammate"),
and it does exactly that in a real browser, records the run, and publishes four things from
that one recording: a **narrated video**, a **help-centre article**, a **clickable
walkthrough**, and an **in-app guide**. No screen recording, no editing, no one sitting
there clicking. It is open source (MIT) and runs on your own machine or your own cloud.

## Three ways to try it

### 1. Look at it (10 seconds, no install)

- Website: **<https://majeed-github.github.io/reelforge/>**
- 30-second video: **<https://github.com/Majeed-GitHub/reelforge/releases/tag/v0.3.2>**
- Source: **<https://github.com/Majeed-GitHub/reelforge>**

### 2. Run it yourself (5 minutes, Docker)

```bash
docker run -d --name reelforge -p 4400:4400 -v reelforge-data:/data \
  ghcr.io/majeed-github/reelforge:latest
# then open http://localhost:4400/app/
```

Or from source, if you prefer:

```bash
git clone https://github.com/Majeed-GitHub/reelforge.git && cd reelforge
npm install && npx playwright install chromium
npm run seed     # prints an rg_… key, paste it into the dashboard
npm run dev      # dashboard :4401 · API :4400 · sample product :4402
```

No account, no API key for your model, no cloud. It ships with a small sample product so
you can record something immediately.

### 3. Have us record your demos for you

Send us a staging URL and a test login. You get the video, the help article and the guide
back. No install on your side at all.

## The workflow, once it is running

1. **Open the dashboard** and paste your workspace key (printed by `npm run seed`).
2. **Add your product**: name, base URL, and how to sign in — a test username/password, or
   a captured browser session for SSO/MFA products (your password never leaves the browser;
   only the resulting session is stored, encrypted).
3. **New demo**: your product's URL plus one plain-language sentence describing the flow.
4. **Wait 1–3 minutes.** It drives the product, narrates, and renders.
5. **Publish**: download the MP4, copy the help article, or embed the guide with one script tag.

## What you get out of it

| Output | Where it goes |
|---|---|
| Narrated video (MP4, 16:9 / 9:16 / 1:1) | your site, YouTube, social, sales decks |
| Public share page | a link you can send to a prospect; they need no account |
| Embeddable player | paste an `<iframe>` into your docs or landing page |
| Help-centre article | Markdown with screenshots; sync to Zendesk |
| Clickable walkthrough | one self-contained HTML file — email it, host it anywhere |
| In-app guide | a 4 KB script tag inside your product |
| Webhooks | Slack message or any endpoint when a demo finishes |

Change your product and re-run it: the same flow is updated, and Reelforge tells you which
flows and articles drifted out of date.

## Security questions clients actually ask

| Question | Answer |
|---|---|
| Does it record my screen? | No. It records only the page it drives in its own browser — never your desktop, other windows, your camera or your mic. |
| Where does the data go? | Your machine. There is no telemetry, no analytics endpoint, no cloud account. Recordings live in the `data/` folder you choose. |
| What about passwords and customer data? | Passwords, card numbers and API keys are masked in screenshots and blurred in the video, only while they are on screen. All typed secrets are stored as `••••`. |
| Can I record a product behind SSO/MFA? | Yes — capture a session once, and it replays it. (Passkeys cannot be replayed; use a password or SSO test account.) |
| Who can see the demos? | Only whoever has your links. Share links are signed and expire; embed and walkthrough links can be revoked by rotating one key. |
| Is there a paid tier? | No. MIT licence, every feature free, no watermark requirement, no export limits. |

## Common questions

**Do I need an AI key?** No. It works offline with a built-in planner and your computer's
speech synthesis. If you have a key for OpenAI/GMI Cloud/Anthropic/Gemini/Ollama, you can
plug it in and it handles open-ended instructions far better.

**How long does one demo take?** A simple flow is 1–3 minutes including rendering.

**Will it work on my app?** If a human can click through it in a browser, yes — including
behind a login. It is a browser, not a screenshot tool.

**What does it cost to run?** Your own machine or server. If you use a hosted model, you pay
that provider directly for tokens (pennies per demo); nothing goes to this project.

**Can I white-label it?** Yes — MIT licence. Replace the dashboard branding and the
watermark text.

---

*Questions about running it in your environment: see [DEPLOY.md](DEPLOY.md), [API.md](API.md)
and [MCP.md](MCP.md) in the same folder.*
