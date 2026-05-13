# Deployment

## Overview

The application has two runtime dependency stacks that must both be present:

| Stack | Components | Used for |
|-------|-----------|---------|
| **Node.js** | Node 20, pnpm, ffmpeg, fpcalc | API server, ingest pipeline, transcoding, fingerprinting |
| **Python 3.11** | essentia, essentia-tensorflow, mood model files | Audio analysis (BPM, key, energy, danceability, mood) |

The Python stack is the harder one to provision — it requires a specific Python version, packages from a non-PyPI index, and ~200MB of downloaded model files.

---

## Recommended: Docker Compose

The cleanest production deployment. The API container includes Node, Python, essentia, and the mood models baked in at image build time. The operator runs one command and the station is live.

### Container layout

```
docker-compose.yml
├── api          ← Node + Python + essentia + mood models
├── web          ← Vite static build served by nginx (or served by api in prod)
├── icecast      ← Icecast streaming server
└── liquidsoap   ← LiquidSoap audio engine
```

### API Dockerfile (apps/api/Dockerfile)

The Dockerfile is in `apps/api/Dockerfile`. Key decisions:

- **Base image**: `node:20-bookworm-slim` — Debian Bookworm has Python 3.11 in apt
- **Models baked in**: mood models are downloaded during `docker build`, not at runtime — the container is self-contained
- **venv inside container**: `/app/analysis/venv/` — same path as dev, so `audioAnalysis.ts` resolves the Python binary identically in both environments

```
docker compose up --build
```

First build takes ~5 minutes (downloads essentia + mood models). Subsequent builds are cached unless `requirements.txt` or `download_models.sh` change.

### Updating mood models

Models are baked into the image. To update:
```bash
docker compose build api
docker compose up -d api
```

---

## Alternative: Linux Install Script

For stations that prefer a direct install on Ubuntu 22.04 / 24.04 (no Docker).

An install script at `scripts/install-linux.sh` (not yet written) would:

1. Install system packages:
   ```bash
   apt install -y nodejs npm ffmpeg libchromaprint-tools python3.11 python3.11-venv
   npm install -g pnpm
   ```

2. Install Node dependencies:
   ```bash
   pnpm install --frozen-lockfile
   pnpm build
   ```

3. Set up Python analysis environment:
   ```bash
   ./analysis/setup.sh
   ./analysis/download_models.sh
   ```

4. Install systemd service unit for the API.

This path works but the operator is responsible for Python version management and model updates. Docker is strongly preferred.

---

## Dependency Reference

Complete list of all runtime dependencies and why each is needed:

| Dependency | Type | Purpose | Install |
|-----------|------|---------|---------|
| Node.js 20 | Runtime | API server + build | `apt install nodejs` / Docker base image |
| pnpm | Package manager | Monorepo dependency management | `npm i -g pnpm` |
| ffmpeg + ffprobe | Binary | Audio format probe, transcode, loudness measurement | `apt install ffmpeg` |
| fpcalc (Chromaprint) | Binary | AcoustID audio fingerprinting | `apt install libchromaprint-tools` |
| Python 3.11 | Runtime | Audio analysis script host | `apt install python3.11` |
| essentia ≥ 2.1b5 | Python pkg | BPM, key, energy, danceability algorithms | `pip install essentia>=2.1b5` |
| essentia-tensorflow | Python pkg | TFLite inference for mood classification | `pip install essentia-tensorflow --extra-index-url https://essentia.upf.edu/python-extras/` |
| MusiCNN embedding model | File (~25MB) | Converts raw audio to feature embeddings for mood classifiers | `analysis/download_models.sh` |
| 7× mood classifier models | Files (~15MB each) | Classify audio embeddings into happy/sad/aggressive/relaxed/party/acoustic/electronic | `analysis/download_models.sh` |
| Docker | Container runtime | Runs Icecast + LiquidSoap (required); API in production | Docker Desktop / `apt install docker.io` |

### Python version requirement

**Python 3.11 or 3.12 only.** essentia and essentia-tensorflow publish binary wheels for 3.11 and 3.12. Python 3.13+ is not yet supported — pip will attempt to compile from source and fail. This constraint applies to both dev and production.

### essentia-tensorflow platform support

essentia-tensorflow is hosted on Essentia's own pip index (`https://essentia.upf.edu/python-extras/`), not PyPI. It ships wheels for:
- Linux x86_64 ✓ (production target)
- macOS x86_64 ✓
- macOS ARM64 ✓ (Apple Silicon — confirmed working)
- Linux ARM64 — not guaranteed; check before deploying on ARM servers

---

## What breaks if Python/essentia is missing

The API starts and operates normally. Audio analysis is skipped gracefully:
- Newly ingested music tracks will have `analysis_status = 'failed'` with an error explaining the missing venv
- All other ingest steps (transcode, loudness, AcoustID identification) are unaffected
- `POST /library/:id/analyse` can be called later once the environment is set up, to backfill missing analysis
- BPM/key/mood columns remain `null` until analysis runs

The `audio_analysis_enabled` flag in Settings → Integrations can be set to `false` to suppress the failed-analysis noise entirely until the environment is ready.
