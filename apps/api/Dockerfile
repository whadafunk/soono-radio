FROM node:20-bookworm-slim AS builder

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libchromaprint-tools \
    python3.11 \
    python3.11-venv \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Python analysis environment ───────────────────────────────────────────────
# Copy only what's needed for the Python layer so Docker can cache it
# independently of app code changes.
COPY apps/api/analysis/requirements.txt apps/api/analysis/requirements.txt
COPY apps/api/analysis/download_models.sh apps/api/analysis/download_models.sh

RUN python3.11 -m venv apps/api/analysis/venv \
    && apps/api/analysis/venv/bin/pip install --no-cache-dir --upgrade pip \
    && apps/api/analysis/venv/bin/pip install --no-cache-dir -r apps/api/analysis/requirements.txt \
    && apps/api/analysis/venv/bin/pip install --no-cache-dir essentia-tensorflow \
       --extra-index-url https://essentia.upf.edu/python-extras/ \
    || echo "WARNING: essentia-tensorflow not available for this platform — mood analysis disabled"

RUN chmod +x apps/api/analysis/download_models.sh && apps/api/analysis/download_models.sh

COPY apps/api/analysis/analyse.py apps/api/analysis/analyse.py

# ── Node dependencies ─────────────────────────────────────────────────────────
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/shared/package.json apps/shared/

RUN npm install -g pnpm --quiet && pnpm install --frozen-lockfile

# ── Build ─────────────────────────────────────────────────────────────────────
COPY apps/shared apps/shared
COPY apps/api apps/api

RUN pnpm --filter @soono/shared build \
    && pnpm --filter @soono/api build

# Assemble a self-contained, correctly-scoped production directory for
# @soono/api — dist/ + only the dependencies that package actually declares,
# resolved through the workspace (so its @soono/shared dependency is included
# too). This replaces an earlier `pnpm prune --prod` attempt (reverted
# 2026-07-22, see backlog memory): prune has no --filter support and only
# understands the CURRENT project's own dependencies — run unscoped at this
# repo's root (whose package.json has zero real `dependencies`), it treated
# `fastify` itself as extraneous and removed it, crashing the container on
# boot. `pnpm deploy` is the tool actually designed for "one package's
# production closure out of a workspace." --legacy avoids requiring
# dependenciesMeta.injected config for the workspace:* dependency on
# @soono/shared; confirmed via a standalone `docker build` + `docker run`
# against this Dockerfile (fastify present, dist present, boots past all
# module resolution — see backlog memory for the full verification trail).
RUN pnpm --filter @soono/api deploy --legacy --prod /prod/api

# ── Runtime image ──────────────────────────────────────────────────────────────
# Fresh stage — deliberately does NOT inherit the builder's node_modules (that
# was the whole bug). Only what's copied in below exists here.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libchromaprint-tools \
    python3.11 \
    python3.11-venv \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# `pnpm deploy` copies the tracked analysis/ files (analyse.py, requirements.txt,
# etc.) but not the generated venv (not a node concept) — that's copied
# separately from the builder stage onto the same path.
COPY --from=builder /prod/api ./apps/api
COPY --from=builder /app/apps/api/analysis/venv ./apps/api/analysis/venv

EXPOSE 3000

CMD ["node", "apps/api/dist/index.js"]
