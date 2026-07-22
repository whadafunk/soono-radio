FROM node:20-bookworm-slim

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

# Strip devDependencies (vitest, drizzle-kit, typescript, etc.) now that the
# build output exists — the running container only needs `dist/` + prod deps.
RUN pnpm prune --prod

EXPOSE 3000

CMD ["node", "apps/api/dist/index.js"]
