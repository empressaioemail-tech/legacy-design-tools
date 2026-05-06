# syntax=docker/dockerfile:1.7
#
# legacy-design-tools api-server — Cloud Run image (Phase 1A scaffold)
#
# Build context = monorepo root. The pnpm workspace requires the root
# package.json + pnpm-lock.yaml + pnpm-workspace.yaml to be present at
# install time, so a per-artifact context will not work.
#
# CMD path is verbatim from artifacts/api-server/.replit-artifact/artifact.toml
# [services.production.run] to preserve parity with current Replit prod.

ARG NODE_IMAGE=node:20-slim

# ---------- build stage ----------
FROM ${NODE_IMAGE} AS build

# Pin puppeteer's Chrome cache inside /app so it survives the
# COPY --from=build into the runtime stage. Default location is
# $HOME/.cache/puppeteer, which lives outside the WORKDIR and would be
# dropped.
ENV PUPPETEER_CACHE_DIR=/app/.puppeteer-cache

WORKDIR /app

# Build essentials cover any native module compile path (node-gyp,
# pnpm rebuild fallbacks). Most native deps in this workspace ship
# prebuilts (web-ifc, ffmpeg-static, puppeteer's chrome download) so
# this set is small.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      git \
      python3 \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10 --activate

COPY . .

RUN pnpm install --frozen-lockfile

# pnpm v10 with --frozen-lockfile does NOT execute puppeteer's
# pure-JS postinstall (install.mjs), so Chrome never auto-downloads.
# Same workaround as .github/workflows/pr-checks.yml — run the
# installer explicitly. The cache lands in PUPPETEER_CACHE_DIR.
RUN cd artifacts/api-server \
 && node node_modules/puppeteer/install.mjs

RUN pnpm --filter @workspace/api-server run build


# ---------- runtime stage ----------
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    PUPPETEER_CACHE_DIR=/app/.puppeteer-cache \
    PORT=8080

WORKDIR /app

# Chrome runtime libraries for puppeteer headless. Mirrors the X11/
# cairo/freetype set that replit.nix provides today plus the
# upstream-recommended deps from the puppeteer troubleshooting docs.
# Trim once puppeteer moves to a separate service (see
# docs/deploy.md follow-ups).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libc6 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libexpat1 \
      libfontconfig1 \
      libgbm1 \
      libgcc-s1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libstdc++6 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxcursor1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxi6 \
      libxkbcommon0 \
      libxrandr2 \
      libxrender1 \
      libxss1 \
      libxtst6 \
      lsb-release \
      wget \
      xdg-utils \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# node:20-slim ships a built-in `node` user (uid/gid 1000). Use it
# rather than running as root.
COPY --from=build --chown=node:node /app /app

USER node

EXPOSE 8080

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
