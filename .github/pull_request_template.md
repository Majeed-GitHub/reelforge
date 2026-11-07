## What changed

<!-- One paragraph. What was broken or missing, and what does this PR do about it? -->

## Why

<!-- The motivation: a user-visible problem, a contract requirement, or a bug report link. -->

Closes #

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run smoke` passes (required if this touches the agent, renderer, pipeline, API contract or database schema)
- [ ] `node packages/render/test/render-selftest.ts` passes (required if this touches ffmpeg/captions/zoom)
- [ ] `docker build -t reelforge:dev .` succeeds (required if this touches the Dockerfile, dependencies or build scripts)
- [ ] Docs updated where I invalidated them (README / ARCHITECTURE / API / DEPLOY / CHANGELOG)
- [ ] No `.env`, `data/`, captured `storageState`, API keys or personal data in the diff
- [ ] No build output committed (`packages/web/dist`, `packages/guide/dist`)
- [ ] Commit messages follow Conventional Commits

## Verification

<!-- Paste the exact commands and their result. "It works" is not verifiable. -->

```text
$ npm run typecheck
...

$ npm run smoke
23/23 checks passed.
```

## Contract / compatibility notes

<!-- Does this change the REST envelope, an error code, an MCP tool name, a database
     column, or an env var? Additive changes are fine; breaking ones need a note
     here and a CHANGELOG entry. -->

- [ ] No change to the documented REST/MCP contract
- [ ] Additive contract change (documented in docs/API.md + CHANGELOG)
- [ ] Breaking change (explained below)
