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
COPY analysis/requirements.txt analysis/requirements.txt
COPY analysis/download_models.sh analysis/download_models.sh

RUN python3.11 -m venv analysis/venv \
    && analysis/venv/bin/pip install --no-cache-dir --upgrade pip \
    && analysis/venv/bin/pip install --no-cache-dir -r analysis/requirements.txt \
    && analysis/venv/bin/pip install --no-cache-dir essentia-tensorflow \
       --extra-index-url https://essentia.upf.edu/python-extras/ \
    || echo "WARNING: essentia-tensorflow not available for this platform — mood analysis disabled"

RUN chmod +x analysis/download_models.sh && analysis/download_models.sh

COPY analysis/analyse.py analysis/analyse.py

# ── Node dependencies ─────────────────────────────────────────────────────────
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/

RUN npm install -g pnpm --quiet && pnpm install --frozen-lockfile

# ── Build ─────────────────────────────────────────────────────────────────────
COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @radio/shared build \
    && pnpm --filter @radio/api build

EXPOSE 3000

CMD ["node", "apps/api/dist/index.js"]
