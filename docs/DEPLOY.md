# Deploying Reelforge

Reelforge is one Node process: REST API + MCP server + dashboard + guide widget
+ the in-process demo worker. It needs `node`, a browser (Playwright's Chromium)
and `ffmpeg`; it stores everything in one directory (`data/`, or `/data` in the
container) with SQLite. There is no Redis, no Postgres, no object store, no
external service required.

This guide covers, in order:

1. [Docker in one command](#1-docker-in-one-command)
2. [Docker Compose](#2-docker-compose)
3. [Bare metal](#3-bare-metal)
4. [Reverse proxy (Caddy, nginx) and HTTPS](#4-reverse-proxy-and-https)
5. [Environment matrix](#5-environment-matrix)
6. [Data, backup and restore](#6-data-backup-and-restore)
7. [Resource sizing](#7-resource-sizing)
8. [Security checklist before you expose it](#8-security-checklist-before-you-expose-it)
9. [Operations: upgrades, logs, health](#9-operations)
10. [Known deployment limitations](#10-known-deployment-limitations)
11. [Platforms: what is verified where](#11-platforms-what-is-verified-where)

Running it on a Mac or a Windows machine rather than a Linux server? Read
[§11](#11-platforms-what-is-verified-where) first: it says exactly which halves of
the pipeline CI proves on which OS, and what you need installed for narration.

> Placeholder reminder: `YOUR_GITHUB_USER` in clone URLs and `your-github-user`
> in image names are replaced when the project is published. Docker image
> references **must be lowercase**, which is why the compose file uses
> `ghcr.io/your-github-user/…` — `YOUR_GITHUB_USER` there is rejected by the
> Docker daemon (`invalid reference format`). Building from source works
> identically without either replacement.

---

## 1. Docker in one command

The image is multi-stage: the dashboard and the guide widget are built at image
build time, and the runtime is the official
`mcr.microsoft.com/playwright:v1.65.0-noble` image, which already contains
Chromium and every OS library Playwright needs. You do not install browsers,
fonts, ffmpeg or system libraries yourself.

> The Playwright base tag must match the `playwright` version in
> `package-lock.json`: each release pins an exact Chromium build
> (`chromium-1254`). The Dockerfile verifies this and fails the build with a
> clear message if they drift, so a broken image never reaches `docker run`.

```bash
# build it (or: docker pull ghcr.io/your-github-user/reelforge:latest)
docker build -t reelforge:dev .

# create the data volume and seed the workspace + API key
docker run --rm -v reelforge-data:/data reelforge:dev node scripts/seed.ts

# run it
docker run -d --name reelforge \
  -p 4400:4400 \
  -v reelforge-data:/data \
  --restart unless-stopped \
  reelforge:dev

# the key is printed by seed; grab the one already on disk:
docker exec reelforge cat /data/dev-api-key.txt
```

Open <http://127.0.0.1:4400/app/>, paste the key, and record a demo of a URL the
container can reach.

What the image already sets for you:

| Setting | Value | Why |
|---|---|---|
| `REELFORGE_HOST` | `0.0.0.0` | The API binds `127.0.0.1` by default, which is unreachable from outside the container — this is the one override the image must make. |
| `REELFORGE_DATA_DIR` | `/data` | Everything the app writes lives on the volume. |
| `REELFORGE_TTS_PROVIDER` | `none` | A Linux container has no Windows SAPI voices. `none` = silent video with burned captions, deterministically. |
| `PLAYWRIGHT_BROWSERS_PATH` | `/ms-playwright` | Browsers baked into the base image. |

Runtime user is the image's non-root **`pwuser` (uid 1001)**: Chromium will not
start its sandbox as root, so recording would fail. The volume is created with
that ownership. If you bind-mount a host directory instead of using a named
volume, `chown 1001:1001` it first.

### Sanity checks

```bash
curl -s http://127.0.0.1:4400/api/health
# {"version":"0.2.0","service":"reelforge","features":["environments","login-codes",
#  "graph","guides","mcp","providers","webhooks","exports","share"],"message":"OK",
#  "data":{...same...}}          <- public, reads the DB, used by the healthcheck

curl -I http://127.0.0.1:4400/app/          # 200, the dashboard bundle
curl -s -H "X-API-Key: $KEY" http://127.0.0.1:4400/api/status
# {"data":{"worker":{"running":true,"concurrency":3,"active":0},...}}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4400/g/guide.js   # 200
docker inspect --format '{{.State.Health.Status}}' reelforge                 # healthy
```

---

## 2. Docker Compose

`docker-compose.yml` in the repository root is the recommended deployment. It
wires the volume, the healthcheck, a restart policy, an **optional** `.env` and
the seed step so the stack is usable on first boot.

```bash
cp .env.example .env        # optional — every setting has a working default
docker compose up -d
docker compose logs reelforge | grep rg_      # the API key
# open http://127.0.0.1:4400/app/
```

- Published image? Change `image:` to `ghcr.io/your-github-user/reelforge:latest`
  (it is already the default) and remove the `build:` block, or keep both so
  `docker compose up --build` always uses local source.
- The compose file runs `node scripts/seed.ts && node packages/api/src/server.ts`
  so the workspace exists on first boot; seed is idempotent and prints the same
  key on later starts. Delete the seed half of `command:` if you manage keys
  yourself.
- Because seed runs on every start, **the API key is printed into the container
  logs on every start**. On a host where logs are shipped to a shared aggregator,
  remove the seed half of `command:` once the key is stored, or treat the log
  stream as sensitive (see SECURITY.md).
- `env_file` uses `required: false`, which needs Docker Compose ≥ 2.24 (Docker
  Desktop 4.30+). On older Compose, create `.env` first (`cp .env.example .env`)
  and use the short `env_file: [.env]` form.
- The commented **Ollama** service at the bottom of the file is a complete,
  fully-local BYOK setup: uncomment it, pull a model
  (`docker compose exec ollama ollama pull qwen2.5:7b-instruct`), and set
  `REELFORGE_LLM_BASE_URL=http://ollama:11434/v1` in `.env`. Nothing leaves the
  host — including the planner's observations of the pages you record.

Upgrade:

```bash
docker compose pull && docker compose up -d          # published image
docker compose up -d --build                          # from source
```

---

## 3. Bare metal

Requires **Node 22.18+ or 24** (`node:sqlite` and unflagged TypeScript
type-stripping are what the server relies on; `package.json` says `>=22.6` but
22.18 is where the flags stopped being necessary), and **Chromium** via
Playwright. `ffmpeg` and `ffprobe` are bundled by `ffmpeg-static` /
`ffprobe-static` during `npm ci` — do not install system ffmpeg unless you want
to (`REELFORGE_FFMPEG_PATH` overrides the bundled binary).

```bash
git clone https://github.com/YOUR_GITHUB_USER/reelforge.git
cd reelforge
npm ci
npx playwright install --with-deps chromium     # --with-deps needs sudo on Linux
npx vite build --config packages/web/vite.config.ts
node packages/guide/build.mjs
npm run seed
```

Run it:

```bash
REELFORGE_HOST=0.0.0.0 node packages/api/src/server.ts
```

`REELFORGE_HOST=0.0.0.0` is only needed if something other than this machine must
reach it — behind a reverse proxy on the same host, the default `127.0.0.1` is
better. The process serves the API, the dashboard (`/app/`), the guide widget
(`/g/`), and runs the demo worker in-process. Set `REELFORGE_WORKER=off` and run
`node packages/api/src/worker/main.ts` separately if you want the API and the
recorder to scale apart (they share the same SQLite database, same host).

### systemd unit (Linux, bare metal)

```ini
[Unit]
Description=Reelforge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=reelforge
WorkingDirectory=/opt/reelforge
Environment=NODE_ENV=production
Environment=REELFORGE_DATA_DIR=/var/lib/reelforge
EnvironmentFile=-/opt/reelforge/.env
ExecStart=/usr/bin/node /opt/reelforge/packages/api/src/server.ts
Restart=on-failure
RestartSec=5
# Chromium + ffmpeg want more than node's defaults
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

Give the service user ownership of the data dir (`install -d -o reelforge
/var/lib/reelforge`). If you run as a dedicated user, make sure that user can
execute the Playwright browsers in `~/.cache/ms-playwright`.

---

## 4. Reverse proxy and HTTPS

Reelforge serves `/api` (REST + MCP), `/app` (dashboard) and `/g` (guide widget)
from one port, so the proxy only has to forward everything to `127.0.0.1:4400`.

**Set `REELFORGE_PUBLIC_URL` to the public origin.** It is used to build signed
video URLs and share links; leave it at the default and those URLs will point at
`http://127.0.0.1:4400` and break for users.

```bash
REELFORGE_PUBLIC_URL=https://reelforge.example.com
```

No WebSocket support is required. The MCP endpoint is *streamable HTTP* (SSE
responses), so do not buffer the `/api` responses.

### Caddy (automatic HTTPS)

```caddyfile
reelforge.example.com {
    encode zstd gzip
    request_body {
        max_size 16MB
    }
    # the API serves a JSON 404 at /; send humans to the dashboard
    redir / /app/ 302
    reverse_proxy 127.0.0.1:4400
}
```

That is the whole config: Caddy gets a certificate, terminates TLS, and streams
SSE without buffering.

If the instance is going to be shared, add an authenticating layer in front (the
dashboard has no login of its own). Caddy basic auth is the shortest route:

```caddyfile
reelforge.example.com {
    basicauth {
        demo $2a$14$<bcrypt-hash-from-`caddy hash-password`>
    }
    request_body { max_size 16MB }
    redir / /app/ 302
    reverse_proxy 127.0.0.1:4400
}
```

### nginx

```nginx
# /etc/nginx/sites-available/reelforge
server {
    listen 443 ssl;
    http2 on;
    server_name reelforge.example.com;

    ssl_certificate     /etc/letsencrypt/live/reelforge.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/reelforge.example.com/privkey.pem;

    # A captured storageState can be a couple of megabytes; the API's own body
    # limit is 8 MB, so leave headroom rather than silently truncating.
    client_max_body_size 16m;

    location = / {
        return 302 /app/;
    }

    location / {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization     $http_authorization;
        proxy_set_header X-API-Key         $http_x_api_key;
    }

    # MCP is streamable HTTP (SSE): never buffer it, and give a recording
    # workflow longer than nginx's default 60 s read timeout.
    location /api/mcp {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-API-Key $http_x_api_key;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

`nginx -t && systemctl reload nginx` after editing. Certificates: use
certbot, or front nginx with Caddy/Cloudflare; Reelforge itself does not do TLS.

---

## 5. Environment matrix

Every value is optional; the defaults are meant to work with no configuration at
all. `(container)` marks the value the Docker image/compose sets for you.

| Variable | Default | Purpose |
|---|---|---|
| `REELFORGE_API_PORT` | `4400` | Port for API + dashboard + guide widget. |
| `REELFORGE_HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` to accept external connections. `(container: 0.0.0.0)` |
| `REELFORGE_DATA_DIR` | `./data` | SQLite DB, keyfile, videos, screenshots, audio, exports. `(container: /data)` |
| `REELFORGE_PUBLIC_URL` | `http://127.0.0.1:4400` | Public origin used in signed media URLs and share links. **Set it when proxying.** |
| `REELFORGE_WEB_PORT` / `REELFORGE_WEB_URL` | `4401` / `http://127.0.0.1:4401` | Only used by `npm run dev` (Vite) and by links to the dev dashboard. |
| `REELFORGE_DEMO_PORT` | `4402` | The bundled demo product (smoke test / local demos). |
| `REELFORGE_WORKER` | `on` | `off` runs the API without the in-process recorder. |
| `REELFORGE_CONCURRENCY` | `3` | Concurrent recordings. This is the main RAM knob (≈1 GB each). |
| `REELFORGE_LLM_PROVIDER` | `auto` | `auto`, or a named provider (`openai`, `gmi`, `ollama`, `lmstudio`, …), or `none` for the offline scripted planner. |
| `REELFORGE_LLM_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint. |
| `REELFORGE_LLM_API_KEY` | unset | Falls back to `OPENAI_API_KEY`. |
| `REELFORGE_LLM_MODEL` | `gpt-4.1-mini` | Model name for the configured endpoint. |
| `REELFORGE_LLM_TIMEOUT_MS` | `60000` | Per-call timeout for the planner. |
| `REELFORGE_TTS_PROVIDER` | `auto` | `auto` tries OpenAI → ElevenLabs → edge-tts → macOS `say` → Linux `espeak-ng`/`espeak`/`pico2wave`/`festival` → Windows SAPI → silent. Force any of those ids, or `none`. Per-OS requirements: [§11.3](#113-prerequisites-per-platform). `(container: none)` |
| `REELFORGE_TTS_VOICE` | system default | Voice id/name for the chosen provider. |
| `REELFORGE_TTS_MODEL` | `gpt-4o-mini-tts` | OpenAI TTS model. |
| `OPENAI_API_KEY` | unset | Used by both the planner fallback and OpenAI TTS. |
| `REELFORGE_BLOCK_LOCAL` | `false` | `true` rejects loopback targets (the hosted-provider rule). **Set `true` for shared installs.** |
| `REELFORGE_BLOCKED_HOSTS` | unset | Comma-separated hostnames (subdomains included) that may never be recorded. |
| `REELFORGE_ENFORCE_CREDITS` | `false` | `true` enforces the credit ledger and returns `402 INSUFFICIENT_CREDITS`. |
| `REELFORGE_FREE_MINUTES` | `5` | Monthly free minutes when credits are enforced. |
| `REELFORGE_TUNNEL_PER_DAY` | `30` | Daily tunnel-demo cap (Director parity). |
| `REELFORGE_LOG_LEVEL` | `info` | Fastify/pino log level (`warn` is a good production choice). |
| `REELFORGE_FFMPEG_PATH` | bundled | Override the ffmpeg binary (system ffmpeg, hardware encoder, …). |
| `PLAYWRIGHT_BROWSERS_PATH` | Playwright default | Chromium location. `(container: /ms-playwright)` |

`.env` is read automatically by `npm run api|worker|seed|smoke|cli` and by the
compose file. In a container, pass settings with `-e` / `env_file:` — the image
does not bake a `.env`.

### Narration on Linux

`auto` silently produces a **silent video with burned captions** on a Linux
container: Windows SAPI does not exist there and `edge-tts` is not installed in
the base image. Options:

```bash
# Cloud TTS (best quality, one env var each)
-e REELFORGE_TTS_PROVIDER=openai -e OPENAI_API_KEY=sk-...
-e REELFORGE_TTS_PROVIDER=elevenlabs -e ELEVENLABS_API_KEY=...

# Local neural TTS: derive an image with edge-tts installed
#   FROM ghcr.io/your-github-user/reelforge:latest
#   USER root
#   RUN apt-get update && apt-get install -y --no-install-recommends python3-pip \
#    && pip install --break-system-packages edge-tts && apt-get clean
#   USER pwuser
```

`REELFORGE_TTS_PROVIDER=none` is also the deterministic choice for CI.

---

## 6. Data, backup and restore

Everything lives under the data dir:

```
data/
  reelforge.db          # SQLite (WAL) — workspaces, environments, demos, graph, articles, guides
  reelforge.db-wal      # write-ahead log (commit it to backups too, or checkpoint first)
  reelforge.db-shm
  .secret               # AES-256-GCM key for stored sign-ins AND the HMAC key for signed URLs
  dev-api-key.txt       # plaintext key written by `npm run seed` (delete after setup)
  videos/               # finished MP4s, posters, captions.srt, tts clips
  raw/                  # raw Playwright .webm + capture.json
  screenshots/          # per-step PNGs
  audio/                # narration clips
  posters/
  exports/              # GIF / WebVTT exports produced by the API
```

> **`.secret` is not optional.** Without it the database's encrypted
> `environment_secrets` are unreadable, and every signed media/share URL breaks.
> Back it up with the database, and protect it like a password store. Rotating it
> is a destructive operation (sessions and open share links die).

### Consistent backup (recommended: stop, copy, start)

SQLite in WAL mode is safe to copy while the process is running *if you take
`reelforge.db`, `-wal` and `-shm` together*, but the simplest guaranteed-correct
backup is to stop the writer for a moment:

```bash
docker compose stop reelforge
docker run --rm -v reelforge-data:/data -v "$PWD/backups:/backup" alpine \
  sh -c 'tar czf /backup/reelforge-$(date +%F-%H%M).tgz -C /data .'
docker compose start reelforge
```

### Online backup with SQLite's backup API

`sqlite3 .backup` checkpoints WAL and writes a consistent copy without stopping
the app:

```bash
mkdir -p backups
docker run --rm -v reelforge-data:/data -v "$PWD/backups:/backup" keinos/sqlite3 \
  sqlite3 /data/reelforge.db ".backup '/backup/reelforge-$(date +%F).db'"
# media files are not in the DB — copy them with a second, media-only pass:
docker run --rm -v reelforge-data:/data -v "$PWD/backups:/backup" alpine \
  tar czf /backup/reelforge-media-$(date +%F).tgz -C /data videos raw screenshots audio posters exports .secret
```

Bare metal equivalent: `sqlite3 "$REELFORGE_DATA_DIR/reelforge.db" ".backup '/backups/reelforge.db'"`
(needs the `sqlite3` CLI) — or stop the service and `cp -a` the directory.

### Restore

```bash
docker compose down                     # stop, keep the volume
docker volume rm reelforge-data         # or keep it and restore in place
docker volume create reelforge-data
docker run --rm -v reelforge-data:/data -v "$PWD/backups:/backup" alpine \
  sh -c 'tar xzf /backup/reelforge-2026-11-07.tgz -C /data && chown -R 1001:1001 /data'
docker compose up -d
```

Restoring into an existing volume instead of a fresh one: stop the service,
delete `reelforge.db*` first, then extract, then `chown -R 1001:1001 /data` —
mixing a restored database with a stale WAL is how you get a corrupt one.

### Retention

Nothing is pruned automatically. A 30-second demo is a few MB of media; over
months `videos/`, `raw/` and `screenshots/` dominate. Delete finished demos
through the API/UI where possible (that removes the database rows *and* asks the
app to clean up), and prune orphaned files in a cron job you own.

---

## 7. Resource sizing

Measured on this project's reference machine — Windows 11, Docker Desktop 29.9,
8 logical CPUs (Intel i5-1035G1, 4 cores / 8 threads) and 7.7 GB RAM — by running
the published image and reading `docker stats` before and during a real 11-step
recording. A Linux server behaves similarly; treat these as a starting point,
not a benchmark:

| Component | RAM | CPU | Notes |
|---|---|---|---|
| Idle (API + dashboard + worker, no recording) | **~81 MB** | ~0% | Measured (`docker stats`) on the image with the worker idle. |
| During a recording | **~727 MB** | **up to ~4 threads** | Peak observed for one 11-step silent demo: Chromium + Playwright's video encoder while driving, then the ffmpeg render pass. |
| Disk: image | **4.32 GB** | | The Playwright base image (Chromium + OS libraries) dominates; the app's own code and built bundles are only ~3.7 MB, `node_modules` is 493 MB. |
| Disk: data per demo | **~2–10 MB** | | An 11-step, 14.5 s silent demo used 2.3 MB (MP4 360 KB, raw webm 736 KB, screenshots 348 KB); narrated runs add TTS clips. Grows with length and step count. |
| Disk: bare metal | ~250–500 MB | | `node_modules` (playwright, ffmpeg-static, ffprobe-static); the browser cache is separate. |

Rules of thumb:

- **CPU is usually the bottleneck, not RAM**, because Chromium's video encode and
  the single ffmpeg pass both want multiple threads. One recording can saturate
  ~4 threads on a laptop-class CPU; give a server 4 vCPU for comfortable
  single-digit concurrency.
- **Default concurrency is 3** → plan for **4 GB RAM minimum, 4 vCPU**, and
  remember that three recordings finishing together means three ffmpeg passes.
  On a 2 GB box set `REELFORGE_CONCURRENCY=1` (recordings queue instead of
  OOM-killing each other).
- Put the data volume on a normal SSD; avoid networked file systems for SQLite
  WAL.
- `--shm-size` is not needed: the agent launches Chromium with
  `--disable-dev-shm-usage`.
- Cap the container (`mem_limit`, `cpus`) so a runaway Chromium cannot take the
  host down; recordings fail with an internal error instead and can be retried.

---

## 8. Security checklist before you expose it

Reelforge is single-tenant and has **no user login**. Read
[SECURITY.md](../SECURITY.md) for the threat model; this is the deployment
checklist:

- [ ] **TLS everywhere.** Reelforge does not terminate TLS; use Caddy/nginx. Never
      expose port 4400 directly to the internet.
- [ ] **Authenticate in front** if anyone but you can reach it (`basicauth`,
      OAuth2 proxy, VPN). The dashboard is a static SPA that asks for an API key;
      it is not an auth boundary.
- [ ] **Set `REELFORGE_PUBLIC_URL`** to the HTTPS origin so signed URLs and share
      links are correct.
- [ ] **`REELFORGE_BLOCK_LOCAL=true`** for shared installs, so a key-holder cannot
      make the browser hit `127.0.0.1`, private ranges or cloud metadata
      endpoints. Add `REELFORGE_BLOCKED_HOSTS` for anything else.
- [ ] **Isolate the network**: the browser can reach whatever the container can
      reach. Do not attach it to a network with your database or admin plane.
- [ ] **Protect `data/`**: it contains encrypted sessions, the `.secret` keyfile,
      plaintext recordings, screenshots and `dev-api-key.txt`. `chown 1001:1001` +
      `chmod 700`, encrypted disk, no world-readable backups.
- [ ] **Delete `data/dev-api-key.txt`** after setup and store the key in your
      client/secret manager. Revoke keys you no longer use.
- [ ] **Know what you record**: sessions, customer data and personal information
      end up in videos and screenshots. Choose a dedicated demo account, not your
      production admin.
- [ ] **Prompt injection is real**: pages are read by the planner. Only record
      sites you control or trust, keep the destructive-action confirmation on,
      and keep `options.maxSteps` sane.
- [ ] **Pin and update the image**: `REELFORGE_VERSION`/tag in compose, rebuild on
      releases; watch the repository security advisories.
- [ ] **Do not mount the Docker socket** into the container.
- [ ] **Rate-limit/limit concurrency** (`REELFORGE_CONCURRENCY`, proxy limits) —
      each recording is a browser and an ffmpeg pass.

---

## 9. Operations

```bash
# is it up?  (public, no key, reads the DB)
curl -s http://127.0.0.1:4400/api/health

# is the worker alive, how busy?
curl -s -H "X-API-Key: $KEY" http://127.0.0.1:4400/api/status

# logs
docker compose logs -f --tail=200 reelforge

# restart / stop
docker compose restart reelforge
docker compose down            # keeps the volume
```

The image healthcheck and the compose healthcheck both call `/api/health` every
30 s. A container that is `unhealthy` is a container whose database or event loop
is stuck — restart it (`restart: unless-stopped` will, after it stays unhealthy).

Upgrades are: back up first (§6), then `docker compose pull && docker compose up
-d` (or `--build`). There are no migrations to run manually — missing tables are
created on boot — but **back up before a minor version bump**; a schema change
that needs a rewrite is not something you want to discover mid-rollback.

---

## 10. Known deployment limitations

Honest list — these are real today, not hypotheticals:

1. **Single tenant.** One workspace, API keys are workspace capabilities, no
   users/roles, no per-user isolation. Run one instance per team/customer if you
   need separation.
2. **No built-in TLS or auth.** By design; use a proxy (§4) and, for shared
   installs, an authenticating layer.
3. **No Windows SAPI narration in the Linux image.** `none` (silent + captions),
   OpenAI/ElevenLabs, or a derived image with `edge-tts` (§5).
4. **Chromium must run as non-root**, hence `pwuser`. Do not set
   `user: root` unless you know why (and then the browser needs `--no-sandbox`,
   which the agent does not pass).
5. **Recording localhost products from inside the container** does not work out
   of the box: `127.0.0.1` inside the container is the container, not your laptop.
   Use a hostname reachable from the container (`host.docker.internal` on Docker
   Desktop, a shared compose network, or a tunnel URL) — and remember
   `REELFORGE_BLOCK_LOCAL` when you open that up.
6. **Signed URLs are tied to `.secret`.** Restoring a database without the
   original keyfile leaves encrypted sessions unreadable; changing the keyfile
   invalidates all existing media/share links.
7. **The worker is in-process.** One recording per concurrency slot, in the same
   process as the API. `REELFORGE_WORKER=off` + `packages/api/src/worker/main.ts`
   splits them, but they still share one SQLite file — plan one writer host.
8. **No GPU path.** ffmpeg uses the bundled CPU build; rendering is parallel to
   recording, not free.
9. **Zendesk sync is a stub**, and webhooks are best-effort delivery (one POST,
   5 s timeout, one retry, signed with `X-Reelforge-Signature: sha256=…`) rather
   than a durable queue. If you need guaranteed delivery, receive them in your
   own service and persist there. See `docs/VERIFICATION.md` for the current
   limitation list.

---

## 11. Platforms: what is verified where

Reelforge is plain Node plus Chromium and ffmpeg, so it runs on Linux, macOS and
Windows. Not every half of that claim is equally proven, so here is the actual
map rather than a marketing sentence. Everything in the "CI" columns is a job in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml); everything in the
"locally verified" column is evidence recorded in
[docs/VERIFICATION.md](VERIFICATION.md).

### 11.1 The CI matrix

| CI leg | Job | Steps that run |
|---|---|---|
| `ubuntu-latest` · Node **22** | `test` (`smoke: true`) | `npm ci` → typecheck (root + `packages/web` + `packages/agent` tsconfigs) → dashboard build → guide build → render self-test → provider self-test → Chromium install → `npm run test:mcp` → **`npm run smoke`** |
| `ubuntu-latest` · Node **24** | `test` (`smoke: true`) | identical to the Node 22 Ubuntu leg |
| `macos-latest` · Node **22** | `test` (`smoke: false`) | `npm ci` → typecheck → dashboard build → guide build → render self-test → provider self-test (no browser, no full smoke) |
| `windows-latest` · Node **22** | `test` (`smoke: false`) | identical to the macOS leg |
| `ubuntu-latest` (non-PR only) | `docker` | build the image, start it, assert `/api/health` and `/app/` from inside the container |

Node 24 is crossed with Ubuntu only; macOS and Windows run the oldest supported
Node (22). Adding the other three combinations would cost ~15 extra minutes of
install time per push to catch things those two legs already catch.

Every leg sets `REELFORGE_TTS_PROVIDER=none` and `REELFORGE_LLM_PROVIDER=none`:
CI must pass on the offline planner and silent render, never on a runner's API
key or a Windows voice that macOS does not have. The macOS and Windows legs exist
for the parts that genuinely differ across platforms:

- **ffmpeg/ffprobe resolution** — `ffmpeg-static` / `ffprobe-static` install a
  different binary per OS and arch (`.exe` on Windows, ELF on Linux, Mach-O on
  macOS). The render self-test calls the same `ffmpegPath()` / `ffprobePath()`
  the product uses, so a broken resolution fails that leg.
- **path handling** — separators, drive letters, and the `subtitles=` filter's
  `C\:` escaping on Windows.
- **macOS `say`** — a platform-only narration path. CI does *not* exercise it
  (every leg forces `REELFORGE_TTS_PROVIDER=none`); it is proven by running the
  render self-test locally with `REELFORGE_TTS_PROVIDER=auto` on a Mac. The
  self-test skips its audio assertions when no provider is available, so the
  macOS leg still fails loudly if the ffmpeg path is broken.
- **the Windows process-tree kill** in `scripts/smoke.ts` / `scripts/dev.mjs`
  (`taskkill /T /F` guarded by `process.platform === 'win32'`). Note: the Windows
  CI leg does **not** run the smoke test, so that guard is not exercised in CI —
  it is exercised by real Windows runs (see `docs/VERIFICATION.md`).

### 11.2 What is verified, per platform

| Platform | Build / typecheck / render pipeline | Full record → render → publish | Offline narration, no key |
|---|---|---|---|
| **Linux** (Ubuntu runner) | ✅ CI, every push | ✅ CI (`npm run smoke`, 23/23) and inside the Docker image | needs a system voice, see below |
| **macOS** | ✅ CI, every push | ⚠️ **not run in CI** — run `npm run smoke` locally after `npx playwright install chromium` | ✅ built-in `say` |
| **Windows** | ✅ CI, every push | ⚠️ **not run in CI**; verified on a real Windows 11 host (11-step demo, MP4, SAPI narration, 23/23 — `docs/VERIFICATION.md`) | ✅ built-in SAPI |
| **Docker** (Linux containers) | ✅ CI `docker` job + local build/run | ✅ verified locally inside the image: `npm run smoke` 23/23 | none in the image → silent + captions, or a cloud/derived TTS |

"Not run in CI" is not "unsupported": the browser pipeline is OS-independent
Playwright, and the Windows path has full local verification. It is simply not
part of the every-push contract — treat macOS/Windows recordings as
supported-but-not-CI-enforced, and open an issue with your platform details if
they fail.

### 11.3 Prerequisites per platform

Common to all: **Node 22.18+ or 24** (see [§3](#3-bare-metal)), `npm ci`, and a
Chromium for Playwright.

| Platform | Chromium | Offline narration (no API key) | Neural voices |
|---|---|---|---|
| **Windows 10/11** | `npx playwright install chromium` | **Windows SAPI** — already installed; Reelforge drives it through `powershell.exe` (Windows PowerShell 5.1 / `System.Speech`). `pwsh` 7 may not ship `System.Speech`, which is why the code pins `powershell.exe`. | `pip install edge-tts` (invoked as `python -m edge_tts`) or an OpenAI/ElevenLabs key |
| **macOS** | `npx playwright install chromium` | **`say`** — built in; Reelforge synthesises to AIFF and converts it with the bundled ffmpeg | `pip install edge-tts` or cloud keys |
| **Linux** | `npx playwright install --with-deps chromium` (the `--with-deps` installs the apt libraries Chromium needs) | install a system voice: `sudo apt install espeak-ng` (also probes `espeak`, `pico2wave`, `festival`) | `pip install edge-tts` or cloud keys |
| **Docker image** | baked into the image | none by default → **silent MP4 + burned captions** (`REELFORGE_TTS_PROVIDER=none`) | `-e OPENAI_API_KEY=…` / `-e ELEVENLABS_API_KEY=…`, or a derived image that installs `edge-tts` ([§5](#narration-on-linux)) |
| **Any** | — | `REELFORGE_TTS_PROVIDER=none` = deterministic silent video with captions (what CI uses) | — |

The `auto` narration chain tries providers in this order and picks the first
available one: **OpenAI → ElevenLabs → edge-tts → macOS `say` → Linux
`espeak-ng`/`espeak`/`pico2wave`/`festival` → Windows SAPI → `none`**. Forcing a
provider that is not installed does not fail the render: it logs a warning and
falls back to silent video with captions (`packages/render/src/tts.ts`). On a
Linux host without a system voice, `espeak-ng` is the smallest way to get offline
narration; `edge-tts` is the best free neural voice.

### 11.4 Docker is Linux-only

The image is based on `mcr.microsoft.com/playwright:v<n>-noble` (Ubuntu 24.04), so
it is a **Linux container**: on macOS and Windows, Docker Desktop runs it inside
its Linux VM, which is fine and is the recommended way to run Reelforge on a
server or a workstation. The release workflow publishes both
`linux/amd64` and `linux/arm64`, so an Apple Silicon Mac gets a native ARM image.
What you cannot do with the image is record a product that only exists on the
host's `localhost` — see [§10](#10-known-deployment-limitations) item 5.

### 11.5 Prove it on your own machine

The same commands CI runs, so you get the same answer on your OS:

```bash
npm ci
npx playwright install --with-deps chromium      # Linux; omit --with-deps on macOS/Windows
npm run typecheck
npx vite build --config packages/web/vite.config.ts
node packages/guide/build.mjs
node packages/render/test/render-selftest.ts     # ffmpeg path — the OS-sensitive one
node packages/providers/test/providers-selftest.ts
npm run seed && npm run smoke                    # full pipeline (a few minutes)

# Optional: prove the narration path on the OS you deploy to. CI always runs
# with TTS disabled, so this is the part CI cannot prove for you.
# Bash / zsh on macOS or Linux:
REELFORGE_TTS_PROVIDER=auto node packages/render/test/render-selftest.ts
# PowerShell on Windows (SAPI):
#   $env:REELFORGE_TTS_PROVIDER='auto'; node packages/render/test/render-selftest.ts
```

