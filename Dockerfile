# syntax=docker/dockerfile:1
#
# Reelforge — one image, everything included.
#
#   docker build -t reelforge .
#   docker run -d --name reelforge -p 4400:4400 -v reelforge-data:/data reelforge
#
# Two stages:
#   build    node:22-bookworm-slim    installs the workspace, builds the React
#                                     dashboard (vite) and the embeddable guide
#                                     widget (esbuild), then prunes dev deps.
#   runtime  playwright:<version>-noble Chromium + every OS library Playwright
#                                     needs, pre-installed — that is the whole
#                                     reason for this base image.
#
# IMPORTANT: the runtime base image version must match the `playwright` version
# locked in package-lock.json (currently 1.65.x), because each Playwright
# release pins an exact Chromium build number (chromium-1254). A mismatch
# produces "Executable doesn't exist at /ms-playwright/chromium-####" at run
# time; the guard in the runtime stage below fails the build instead, so this
# is caught at `docker build`, not during a demo.
#
# The container runs as the image's non-root `pwuser`: Chromium refuses to
# start its sandbox as root, so `--user root` would break recording unless you
# also add --no-sandbox. The data volume is owned by pwuser, and /ms-playwright
# (the browser binaries) is readable by it out of the box.

ARG NODE_VERSION=22
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.65.0-noble

# ---------------------------------------------------------------------------
# Stage 1 — build the dashboard + guide widget
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build

WORKDIR /app

# Browsers are downloaded in the runtime image (they are already there); do not
# spend 200 MB and two minutes re-downloading Chromium during `npm ci`.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false

# Copy only the manifests first so the dependency layer is cached across source
# edits. Every directory under packages/ or apps/ that has a package.json must
# be listed here (workspaces are resolved from package-lock.json).
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/agent/package.json packages/agent/
COPY packages/render/package.json packages/render/
COPY packages/cli/package.json packages/cli/
RUN npm ci

# Source (node_modules, data/, .git, .env and prebuilt dist/ are .dockerignore'd).
COPY . .

# Dashboard -> packages/web/dist, served by the API at /app/
# Guide widget -> packages/guide/dist, served at /g/ (fails the build if the
# bundle exceeds its 6 KB gzip budget, which is the point of the budget).
RUN npx vite build --config packages/web/vite.config.ts \
 && node packages/guide/build.mjs \
 && npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 2 — runtime: browsers + OS libs + Node
# ---------------------------------------------------------------------------
FROM ${PLAYWRIGHT_IMAGE} AS runtime

# The image already ships a modern Node.js (26.x in the v1.65.0 tag; Reelforge
# only needs >= 22.18, where running .ts files needs no flag) plus Chromium and
# its shared libraries.
ENV NODE_ENV=production \
    REELFORGE_HOST=0.0.0.0 \
    REELFORGE_API_PORT=4400 \
    REELFORGE_DATA_DIR=/data \
    REELFORGE_TTS_PROVIDER=none \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/home/pwuser

WORKDIR /app

COPY --from=build --chown=pwuser:pwuser /app /app

# Fail the build if the base image does not carry the exact browser revision
# that this repo's playwright-core expects. (See the header comment.)
RUN node -e "const fs=require('node:fs');const b=require('/app/node_modules/playwright-core/browsers.json');const rev=b.browsers.find(x=>x.name==='chromium').revision;const v=require('/app/node_modules/playwright-core/package.json').version;if(!fs.existsSync('/ms-playwright/chromium-'+rev)){console.error('Playwright browser mismatch: image has ['+fs.readdirSync('/ms-playwright').join(', ')+'] but playwright-core@'+v+' needs chromium-'+rev+'. Set ARG PLAYWRIGHT_IMAGE to mcr.microsoft.com/playwright:v'+v+'-noble (or the matching tag) and rebuild.');process.exit(1);}console.log('browser ok: chromium-'+rev+' for playwright-core '+v);"

# The named volume is created with this ownership on first use.
RUN mkdir -p /data && chown -R pwuser:pwuser /data

USER pwuser

VOLUME ["/data"]
EXPOSE 4400

# /api/health is public (no API key) and reads the SQLite database, so it is a
# real readiness check, not just "the process is alive".
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.REELFORGE_API_PORT||4400)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# API + REST + MCP + dashboard + in-process worker, all in one process.
CMD ["node", "packages/api/src/server.ts"]
