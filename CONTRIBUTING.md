# Contributing to Reelforge

Thanks for wanting to make this better. Reelforge is MIT-licensed and
self-hosted by design: no CLA, no company gatekeeping, just code review.

- **Bug reports / feature ideas:** open an issue (templates are provided).
- **Security problems:** do **not** open an issue — see [SECURITY.md](SECURITY.md).
- **Architecture / internals tour:** [docs/CONTRIBUTING-DEV.md](docs/CONTRIBUTING-DEV.md)
  explains how a demo flows through the pipeline and where to hook in a planner,
  a render filter or an MCP tool.
- **Deployment:** [docs/DEPLOY.md](docs/DEPLOY.md).

## Quickstart

Everything below runs with **Node 22.6+** (Node 22 or 24; `.nvmrc` says 22) and no
API keys. TypeScript is executed directly by Node's type stripping — there is no
build step for the server, the agent, the renderer or the CLI.

```bash
git clone https://github.com/YOUR_GITHUB_USER/reelforge.git
cd reelforge
npm install                       # root workspaces
npx playwright install chromium   # once, ~150 MB
npm run seed                      # workspace + API key -> data/dev-api-key.txt
npm run dev                       # demo product :4402 · API+worker :4400 · dashboard :4401
```

Open <http://127.0.0.1:4401>, paste the key printed by `npm run seed`, and record
a demo of the bundled product at <http://127.0.0.1:4402>.

Or run the whole image instead: `docker compose up -d` (see [docs/DEPLOY.md](docs/DEPLOY.md)).

## Where things live

| Path | What it is |
|---|---|
| `packages/core` | Domain contract (`types.ts`), SQLite schema (`db.ts`), config, credits, flow signatures, crypto |
| `packages/agent` | Playwright runner, injected cursor overlay, observer, LLM + scripted planners, re-check |
| `packages/render` | TTS providers, captions/SRT, auto-zoom timeline, single-pass ffmpeg render |
| `packages/api` | Fastify REST surface, MCP server, in-process worker, Product Graph, signed file URLs |
| `packages/web` | React dashboard (Vite, hash routing) |
| `packages/guide` | Embeddable in-app guide widget (esbuild, shadow DOM, < 6 KB gzip budget) |
| `packages/cli` | `reelforge session \| mcp \| init \| doctor` (Director CLI parity) |
| `apps/demo-site` | A small real SaaS used by the smoke test |
| `scripts/` | `dev.mjs` dev runner, `seed.ts`, `smoke.ts` end-to-end test |
| `docs/` | ARCHITECTURE, API, VERIFICATION, DEPLOY, CONTRIBUTING-DEV |

## Before opening a PR

Run these locally; they are the same commands CI runs:

```bash
npm run typecheck                                  # whole monorepo, zero errors
node packages/render/test/render-selftest.ts       # ffmpeg pipeline, no browser needed
npm run smoke                                      # records → renders → graph → article → guide
```

`npm run smoke` takes 1–3 minutes: it boots the demo product and the API, records
a real 11-step demo with Chromium, renders an MP4 with ffmpeg, then asserts 23
things about the result. **Run it before opening a PR that touches the agent,
the renderer, the pipeline, the API contract or the database schema.** If your
change is docs/CI/Docker-only, `npm run typecheck` plus a `docker build` is enough.

Optional deeper checks (slower, and some need a display):

```bash
node packages/agent/scripts/verify-overlay.ts      # cursor/ripple/focus visible in the pixels
node packages/agent/scripts/verify-guards.ts       # destructive-action gate, redaction, guards
node packages/web/test/dashboard-smoke.mjs         # every dashboard screen against a live API
node packages/guide/test/widget-smoke.mjs          # shadow-DOM isolation, spotlight geometry
```

## PR rules

1. **One concern per PR.** Small diffs get reviewed. Refactors and behaviour
   changes go in separate PRs.
2. **Keep the contract.** `docs/API.md` and `docs/ARCHITECTURE.md` describe a
   reverse-engineered contract (envelope, error codes, MCP tools, `/health`
   features). Additive is fine; renaming or removing is a discussion first.
3. **Do not overclaim.** The product's credibility is its honesty about what is
   verified. If you add a feature, add the test or the verification note with it;
   if something is a stub, say so in the docs.
4. **No new runtime dependencies** without an issue first. The "runs on node +
   SQLite + Playwright + ffmpeg" property is a feature. Dev dependencies are
   cheaper, but still argue for them.
5. **No secrets, no personal data.** `.env`, `data/` and captured `storageState`
   files must never be committed. `.gitignore` already excludes them — check
   `git status` before committing.
6. **Do not commit build output**: `packages/web/dist` and `packages/guide/dist`
   are generated and git-ignored.
7. **Tests must be deterministic offline.** No network calls to real third-party
   services in tests; use `REELFORGE_TTS_PROVIDER=none` and
   `REELFORGE_LLM_PROVIDER=none` when a silent/scripted fallback is what you mean.
8. **Update the docs you invalidated.** README/ARCHITECTURE/API/DEPLOY/CHANGELOG
   mention specifics on purpose; keep them true.

### Code style

- TypeScript, ESM, `.ts` extensions **in imports** (Node runs the files
  directly). No build step, so: **no `enum`, no `namespace`, no parameter
  properties, no decorators** — type stripping does not transform those.
- Types are checked only by `npm run typecheck`; Node erases them at run time.
- Keep formatting consistent with the file you are editing; `.editorconfig`
  (2 spaces, LF) is the baseline. Do not reformat unrelated code.
- Error paths use the product's error envelope (`ApiError`, `err()`), not bare
  `throw new Error` in routes.

### Commit messages — Conventional Commits

`<type>(<scope>): <summary>` in the imperative mood, ≤ 72 chars.

| Type | Use for |
|---|---|
| `feat` | A new capability |
| `fix` | A bug fix |
| `perf` | Faster/cheaper with the same behaviour |
| `refactor` | Code change that is not a feature or a fix |
| `docs` | Documentation only |
| `test` | Tests only |
| `build` / `ci` | Build system, Docker, GitHub Actions |
| `chore` | Everything else that does not touch `src` |

Scopes are the package or area: `agent`, `render`, `api`, `web`, `guide`, `core`,
`cli`, `docker`, `ci`, `docs`.

```
feat(render): ease the zoom between steps instead of cutting
fix(agent): keep the cursor overlay after a client-side navigation
ci: cache npm and skip browser install in the typecheck job
```

Breaking changes: add `!` after the type/scope and a `BREAKING CHANGE:` footer.

## Review and release

- `main` is protected by CI: typecheck, dashboard build, guide build, render
  self-test and the full smoke test on Node 22 and 24.
- Releases are cut by pushing a `v*` tag; `.github/workflows/release.yml` builds
  and pushes `ghcr.io/YOUR_GITHUB_USER/reelforge` and the CHANGELOG is updated in
  the same PR that bumps `package.json` version.

## Licence

By contributing you agree your work is licensed under the MIT licence in
[LICENSE](LICENSE).
