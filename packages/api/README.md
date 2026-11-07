# @reelforge/api — REST surface, MCP server, and the demo worker

Fastify 5 + `node:sqlite`. No build step: Node ≥22.6 runs the TypeScript directly.

```bash
node --env-file-if-exists=.env packages/api/src/server.ts   # API + in-process worker
node --env-file-if-exists=.env packages/api/src/worker/main.ts   # worker only
node packages/api/src/seed.ts                                # idempotent first-run seed
```

Everything is under `http://127.0.0.1:4400/api` (`REELFORGE_API_PORT`), except the
static mounts: dashboard at `/app` (`packages/web/dist`), embed widget at
`/g/demo.html` (`packages/guide/dist`).

## Auth

`X-API-Key: rg_<32 hex>` or `Authorization: Bearer rg_…`. Only `sha256(key)` is
stored; the plaintext is returned once by `POST /api/api-keys` (and written to
`data/dev-api-key.txt` by the seed). Public routes: `/api/health`,
`/api/guides/embed/:embedKey`, `/api/guides/:id/report`,
`/api/environments/by-code/:code(/session)`, `/api/files/:token`, the static
mounts, and the MCP `initialize`/`tools/list` handshake when called with a key
(the endpoint itself is keyed like everything else).

Envelopes: success `{ message, data }`, failure `{ code, message, remediation }`.
`/api/health` additionally carries the bare `{ version, service, features }`
shape Director's CLI reads at the top level.

## Endpoints

| Area | Routes |
|---|---|
| health | `GET /api/health`, `GET /health`, `GET /api/status` |
| demos | `POST /api/demos`, `GET /api/demos`, `GET /api/demos/:id`, `GET /api/demos/:id/transcript`, `POST /api/demos/:id/question/answer`, `POST /api/demos/:id/cancel` |
| environments | `POST/GET /api/environments`, `GET/PATCH /api/environments/:id`, `POST /api/environments/:id/session`, `POST /api/environments/:id/verify`, `POST /api/environments/:id/login-code`, `POST /api/environments/by-code/:code`, `POST /api/environments/by-code/:code/session` (last two public = Director CLI flow) |
| domains | `GET /api/domains`, `POST /api/domains/attest`, `POST /api/domains/verification`, `POST /api/domains/verification/check` |
| graph | `GET /api/environments/:id/graph/flows`, `GET …/flows/:flowId`, `POST …/flows/:flowId/reverify`, `GET /api/flows` |
| articles | `GET /api/articles`, `GET/PATCH /api/articles/:id`, `POST /api/articles/from-flow`, `POST /api/articles/:id/publish`, `POST /api/articles/:id/unpublish` |
| guides | `GET /api/guides`, `GET/PATCH /api/guides/:id`, `POST /api/guides/:id/publish`, `POST /api/guides/:id/unpublish`, `GET /api/guides/embed/:embedKey` (public), `POST /api/guides/:id/report` (public) |
| presets | `GET /api/presets`, `GET /api/presets/default`, `GET /api/presets/voices`, `POST /api/presets` |
| settings | `GET /api/workspace`, `GET/POST /api/api-keys`, `DELETE /api/api-keys/:id`, `GET /api/integrations` |
| media | `GET /api/files/:token` (public, HMAC-SHA256, 1 h, Range supported) |
| MCP | `POST /api/mcp` (streamable HTTP, stateless) |

## Behaviour worth knowing

- **Target policy** (`src/targets.ts`): loopback is allowed (the recorder runs
  locally) unless `REELFORGE_BLOCK_LOCAL=true`; RFC1918/link-local/ULA targets
  are rejected with `TARGET_UNREACHABLE` + `remediation.action='use_tunnel'`;
  a host must be attested once (`authorized:true` → `DOMAIN_AUTHORIZATION_REQUIRED`).
- **Implicit product**: a demo with only `target.url` gets an environment
  find-or-created for that origin, so the Product Graph always has a product to
  file the flow/article/guide on.
- **Queue** (`src/queue.ts`): the DB is the queue. `demos.status` is the truth,
  the claim is an atomic `UPDATE … WHERE status='queued'`, concurrency is
  `PLAN.concurrency`. Restart-safe; stranded runs older than 30 min are closed
  out at boot.
- **Pipeline** (`src/worker/pipeline.ts`): dynamic-imports
  `packages/agent/src/index.ts` (`runCapture`) and
  `packages/render/src/index.ts` (`renderDemo`) by file URL — never at module
  load, so the API boots and every non-execution route works even without them.
  `demo_steps` keeps recorded `box`/timings verbatim for the zoom timeline.
  On completion it writes the ledger, then `src/graph.ts` upserts exactly one
  flow (signature = `flowSignature(steps)`), replaces `flow_steps`, upserts
  `screens` per distinct `url_path`, and keeps **one** `help_center` draft
  article plus **one** draft guide (`embed_key` generated) per flow.
- **Reverify** (`src/reverify.ts`): lazily calls the agent's `reverifyFlow`
  (headless selector replay); marks the flow `stale` with a reason and prepends a
  visible banner to dependent articles (and exposes a derived `stale` flag).
- **Guide telemetry**: reports append to `data/guide-reports.jsonl` (no schema
  change, inspectable, durable).
- **Signed media**: `GET /api/files/:token`, base64url claims `{p,e}` + HMAC
  with `data/.secret`, path-contained to `data/`, 1 h TTL, Range → 206.

## Env

`REELFORGE_API_PORT` (4400) · `REELFORGE_HOST` (127.0.0.1) ·
`REELFORGE_WORKER=off` (API without a worker) · `REELFORGE_CONCURRENCY` (3) ·
`REELFORGE_ENFORCE_CREDITS` · `REELFORGE_FREE_MINUTES` · `REELFORGE_BLOCK_LOCAL` ·
`REELFORGE_BLOCKED_HOSTS` · `REELFORGE_LOG_LEVEL`.
