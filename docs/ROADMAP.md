# Roadmap: what is missing, honestly

Audited against a full product, not against a demo. Status as of this commit.

Legend: **●** shipped · **◐** partial · **○** not started · **—** deliberately out of scope.

## A. Real gaps, closeable quickly

| # | Gap | Why it matters | Status |
|---|---|---|---|
| 1 | **Embeddable player** — a demo can only be watched on our share page | Nobody can put a demo in their docs, blog or landing page | ◐ in progress |
| 2 | **View analytics** — no idea if a shared demo was watched | The first question every user asks after sharing | ◐ in progress |
| 3 | **Marketing website + promo video** | The repo has no front door | ◐ in progress |
| 4 | **Help-centre export** — articles exist, but only as API rows | A help centre needs static HTML with SEO and a custom domain | ○ |
| 5 | **Search** across demos, flows and articles | The dashboard grows past the point of scrolling | ○ |
| 6 | **Branding** — the watermark text is hard-coded to "Reelforge" | Anyone self-hosting wants their own name and colour | ○ |
| 7 | **Light editing** — trim to a step range, drop a step, reorder | Today the only fix for a bad step is re-recording the whole flow | ○ |
| 8 | **Notifications** — webhooks exist, but no first-class Slack/Discord/email | "Tell me when the nightly demo is ready" | ○ |
| 9 | **Scheduling / deploy trigger** — `record after every deploy` is a recipe, not a feature | This is the whole reason to automate a demo | ○ |
| 10 | **Release demos** — record the same flow per branch/version and diff | Director sells this; we can build it on the Product Graph | ○ |
| 11 | **Rate limiting + API key scopes** | A public self-hosted instance is currently open to loop-back | ○ |
| 12 | **Backup/restore CLI** for `data/` (SQLite + media) | Self-hosters lose their workspace on a bad `rm` | ○ |

## B. Bigger, needs a design not just code

| # | Gap | Why it is bigger | Status |
|---|---|---|---|
| 13 | **Accounts, teams, roles** — today: one workspace + API keys | Needs OIDC/session auth, per-user isolation, and a migration path for existing installs | ○ |
| 14 | **Credits UI** — metering is modelled but invisible | It exists in the ledger; exposing it means a billing mental model in the dashboard | ○ |
| 15 | **Dashboard i18n** — narration speaks many languages, the UI speaks English | Needs a message catalogue and RTL handling | ○ |
| 16 | **Observability** — structured logs, no metrics | A Prometheus endpoint and a few counters would do it | ○ |
| 17 | **Prompt-injection hardening** — a recorded page can contain text aimed at the planner | Needs a content-trust boundary around the DOM digest that goes to the model | ◐ partial |

## C. Deliberately out of scope (and why)

| Not doing | Reason |
|---|---|
| **Webcam / microphone capture** | Requires a human in the loop; that is [Screenforge](https://github.com/screenforgeai/screenforge)'s job and it is free. |
| **Human timeline editor** | A different product surface. Our timeline is the step list: change the instruction, re-record in 90 seconds. |
| **Person segmentation / virtual backgrounds** | Per-frame ML on the encoder path; only meaningful with webcam capture. |
| **Recording a whole desktop** | We drive a browser by design; desktop capture needs OS-level permissions and a native shell. |
| **Proprietary model lock-in** | The opposite of the project's thesis. |

## D. Quality gates that still need to be green

| # | Gate | Status |
|---|---|---|
| 18 | CI green on ubuntu / macos / windows | ◐ first runs in flight |
| 19 | macOS `say` and Windows SAPI exercised in CI (not just locally) | ○ CI forces `TTS=none` for determinism; needs a per-OS TTS job |
| 20 | End-to-end test for aspect ratios + redaction through the API (not just the renderer) | ◐ renderer verified; API path verified by unit-level wiring |
| 21 | Load/abuse test: many concurrent demos on one worker | ○ |
| 22 | Accessibility audit of the dashboard (axe) | ○ |

## Order I would do them in

1. **Embed + analytics** (in flight) — they make sharing real.
2. **Website + promo** (in flight) — they make the project legible.
3. **Branding + search + help-centre export** — the three things that turn a demo tool into something a team adopts.
4. **Deploy trigger + release demos** — the features that only this architecture can offer.
5. **Accounts/roles** — last, because it is the one change that cannot be undone cheaply, and self-hosters with one workspace are perfectly happy today.

## What "done" looks like for v1.0

- A stranger can go from a GitHub URL to a published demo, a help-centre site and an embedded player in under ten minutes, on any of the three OSes, with no account and no key.
- Every output is reachable from an agent over MCP without reading our docs.
- The Product Graph survives a product redesign: re-check tells you exactly which flows broke.
- Nothing in the product nags, limits, or phones home.
