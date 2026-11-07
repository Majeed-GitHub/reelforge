# @reelforge/agent — the browser agent

Give it a URL and one sentence; it drives a real Chromium page with an injected
cursor, records 1280×720 video, and returns a `CaptureResult` (steps + timings +
boxes + screenshots + `.webm`) that `packages/render` can turn into a narrated demo.

Everything is offline-first: with no `REELFORGE_LLM_API_KEY` the deterministic
**scripted planner** runs the whole flow (`sign in → create project → invite
teammate → upgrade plan` on `apps/demo-site`). Set one env var and the **LLM
planner** takes over; if that endpoint fails, the run degrades back to scripted
instead of dying.

## Public API

```ts
import { runCapture, reverifyFlow, createPlanner } from '../agent/src/index.ts';

const capture = await runCapture({
  request: {
    instruction: 'Sign in, create a project called Q4 Launch, invite sam@example.com to the team, then upgrade to the Team plan.',
    target: { type: 'url', url: 'http://127.0.0.1:4402/' },
    credentials: { username: 'ada@example.com', password: 'northwind' }, // optional (prefilled forms work without)
    confirmDestructive: false,
    options: { headless: true, maxSteps: 40, language: 'en' }
  },
  // Saved product with a captured Playwright session: sign-in is skipped.
  environment: { baseUrl: 'https://app.example.test', storageState: savedState }
});

const health = await reverifyFlow({ baseUrl: 'https://app.example.test', steps: capture.steps, storageState: savedState });
// { status: 'fresh' | 'stale', staleSteps: [{ idx, selector, reason }], checkedAt, checkedSteps, error? }
```

`CaptureResult` (see `packages/core/src/types.ts`) contains, per step:
`index, kind, narration, startedAtMs/endedAtMs (ms from recording start),
selector, role, accessibleName, box (CSS px, viewport-relative), point, url,
value (secrets redacted), screenshotPath, reason, error`.

Artifacts written under `REELFORGE_DATA_DIR` (`data/` by default):

| Path | Contents |
|---|---|
| `data/raw/<demoId>/demo.webm` | the recording (Playwright's raw video, renamed) |
| `data/raw/<demoId>/session.json` | captured `storageState` for environment reuse |
| `data/raw/<demoId>/capture.json` | the full `CaptureResult` (steps, redactions, log) |
| `data/screenshots/<demoId>/<idx>.png` | one viewport PNG per step (sensitive fields already masked) |
| `data/tmp/redaction-fixture.html` | generated fixture used by `verify-redaction.ts` |

## Pieces

| File | Responsibility |
|---|---|
| `src/injected.ts` | `CURSOR_INIT_SCRIPT` — pointer dot, click ripple, focus ring; installed with `context.addInitScript` so it survives every navigation. Idempotent. |
| `src/observer.ts` | `observe(page)` → `Observation`: interactive elements, stable selectors (`data-testid` > `id` > `aria-label` > `name` > `nth-of-type` path), accessible names, boxes, destructive flags, one-line-per-element `domDigest`, optional screenshot. |
| `src/planner/scripted.ts` | Offline deterministic planner: instruction → ordered intents → one action per turn from the live inventory. **Default.** |
| `src/planner/llm.ts` | OpenAI-compatible `/chat/completions` planner: one JSON `PlannedAction` per turn, fenced/JSON repair, hand validation, typed `PlannerError`. |
| `src/planner/index.ts` | `createPlanner(config)` — picks LLM when configured, wraps it with a scripted fallback. |
| `src/narration.ts` | Per-step line: planner-provided, LLM, or template. House style enforced (present tense, no "I", no selectors). |
| `src/runner.ts` | `runCapture`: launch → context (video, storageState) → observe/plan/act loop → video/session/capture artifacts. Bounded by `maxSteps` (default 40, hard cap 60). Destructive gate. |
| `src/reverify.ts` | `reverifyFlow`: re-open each step's page, prove the selector is visible. Never throws. |
| `src/index.ts` | Public exports. |

Node runs TypeScript natively, so local imports carry the `.ts` extension.

## Privacy redaction (v0.3)

Demos record real screens, so secrets are removed in three places:

1. **Screenshots** — Playwright's native `page.screenshot({ mask, maskColor: '#000000' })`
   paints the element's box black *before the PNG is encoded*, so the value never
   reaches disk. Targets are found once per observation (`src/redaction.ts`) and
   reused for that step's screenshot, including the screenshot handed to a
   vision-capable planner.
2. **Video** — can't be masked in the page (the app needs the real value, and
   painting on the page would be recorded). Instead each step contributes
   viewport-relative boxes to `CaptureResult.redactions` (with `stepIndex`) so the
   renderer blurs that region during that step's time window.
3. **Text** — `StepRecord.value` becomes `••••` for sensitive fields, and
   `log[]` lines are scrubbed of bearer tokens / API keys before reaching the
   dashboard.

Automatic targets (`options.redactSensitive`, default **true**): `input[type=password]`,
`autocomplete` starting `cc-` or `one-time-code`, and any `input`/`textarea` whose
`name` / `id` / `data-testid` matches `card`, `cc-`, `cvv`, `cvc`, `ssn`, `secret`,
`token`, `api[-_]?key` or `passw`. Add `options.redactSelectors: ['.sensitive']` for
anything else (any CSS selector; invalid ones are logged and ignored, never fatal).

`redactions` are **one entry per on-screen box per step**, deduped within a step and
**never collapsed across steps**: a renderer that blurs each entry only inside its
step's window would silently un-blur a field that is still visible in later steps —
the exact failure mode this feature exists to prevent. Contiguous steps sharing a
box can be merged into one continuous blur interval by the renderer, and a step
with no entry ends the interval. Boxes are clamped to the 1280×720 viewport
(half-visible fields still get masked) and stored in the same CSS-px space as
`StepRecord.box`.

`input[type=password]` is redacted from `StepRecord.value` even when
`redactSensitive: false` — that switch turns off masking, not credential hygiene.

Known gaps: closed shadow roots (no API can see inside), cross-origin iframes, and
values painted into `<canvas>` are not observable by the DOM scan. Open shadow
roots are traversed.

## Verification

```powershell
# 1. full capture against the demo site (starts it if needed, resets state)
node packages/agent/scripts/e2e.ts

# 2. cursor/ripple/focus-ring proof (DOM + pixels), incl. navigation survival
node packages/agent/scripts/verify-overlay.ts

# 3. destructive gate, step budget, TARGET_UNREACHABLE, LLM parse/validate/fallback
node packages/agent/scripts/verify-guards.ts

# 4. privacy redaction: masked PNGs (pixel-checked), redaction boxes, values, logs
node packages/agent/scripts/verify-redaction.ts

# 5. credentials typed on camera + password masked in the signed-in flow
node packages/agent/scripts/verify-credentials.ts

# typecheck just this package
node node_modules/typescript/bin/tsc -p packages/agent/tsconfig.json --noEmit
```

`e2e.ts` asserts: >= 6 steps, a viewport box on every click/type, a PNG per
step, a `.webm` with a real duration and 1280×720 stream (ffprobe), and that
`reverifyFlow` is `fresh` on the recorded selectors and `stale` on one
deliberately corrupted selector.

## Known limitations

- The scripted planner understands a fixed grammar: sign in / create project /
  invite teammate / upgrade plan / open a page. Anything else degrades to a
  short "the page is ready" wait. Set an LLM key for open-ended instructions.
- Sign-in is only performed on camera when the instruction asks for it, or when
  the page blocks the app; there is no off-camera password step. Pass
  `environment.storageState` (or `request.credentials`) for logged-in products.
- Download / file-input / multi-tab flows are not modelled.
- Passkey/WebAuthn sign-in cannot be replayed (origin + device bound), same
  limitation Director documents.
