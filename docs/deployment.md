# Deployment

## Overview

The application has two runtime dependency stacks that must both be present:

| Stack | Components | Used for |
|-------|-----------|---------|
| **Node.js** | Node 20, pnpm, ffmpeg, fpcalc | API server, ingest pipeline, transcoding, fingerprinting |
| **Python 3.11** | essentia, essentia-tensorflow, mood model files | Audio analysis (BPM, key, energy, danceability, mood) |

The Python stack is the harder one to provision — it requires a specific Python version, packages from a non-PyPI index, and ~200MB of downloaded model files.

**RAM:** mood analysis loads TensorFlow plus the MusiCNN embedding model and 7 per-mood classifier models per track. On hosts with under ~2GB free RAM, this can get OOM-killed by the kernel mid-analysis — the API reports this as `analyse.py was killed by signal SIGKILL`. If you see that error, either free up RAM on the host or skip mood analysis (delete/rename `apps/api/analysis/models/msd-musicnn-1.pb` — the script skips mood analysis and returns a warning instead of loading the embedding model).

---

## Recommended: Docker Compose

The cleanest production deployment. All dependencies — Node, Python, essentia, mood models, Icecast, LiquidSoap — are baked into container images. One command starts the station.

### Container layout

```
docker-compose.yml
├── socket-proxy  ← Narrow Docker API slice (restart only) — no socket in app containers
├── icecast       ← Icecast streaming server
├── api           ← Node + Python + essentia + mood models; runs DB migrations on start
├── web           ← React SPA served by nginx; proxies /api/ to api:3000 internally
└── liquidsoap    ← LiquidSoap audio engine; waits for api healthcheck before starting
```

### Published ports

| Container | Port | Accessible from |
|-----------|------|----------------|
| `web` | `8080` | Browser (put a reverse proxy in front for TLS) |
| `icecast` | `8000` | Stream listeners (HTTP / HTTPS if TLS configured) |
| `icecast` | `8001` | LiquidSoap audio push (plain HTTP, internal) |
| `liquidsoap` | `8005` | Live DJ harbor connections |

The API (port 3000) is **not published** — the nginx inside the `web` container proxies
all `/api/` calls to `api:3000` on the internal `soono-net` bridge. Browsers never
need a direct route to port 3000.

### Reverse proxy (recommended for production)

Put a host-level reverse proxy (nginx, Caddy, Traefik, etc.) in front of the stack to
handle TLS and serve on standard ports without burning 80/443 on the Docker host:

```
client → :443 (host proxy, TLS termination) → :8080 (web container)
```

Minimal Caddy example:
```
soono.example.com {
    reverse_proxy localhost:8080
}
```

Minimal nginx example:
```nginx
server {
    listen 443 ssl;
    server_name soono.example.com;
    # ... ssl_certificate / ssl_certificate_key ...
    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Environment configuration

`.env` is committed to the repo — no setup step needed. It contains only two non-sensitive values operators may want to adjust:

| Variable | Purpose |
|----------|---------|
| `CORS_ORIGINS` | Comma-separated list of origins the browser may call the API from. Add your production domain. |
| `LS_MEDIA_DIR` | Mount point for the audio library inside containers. Default `/media` matches the volume config — only change if you remap the volume. |

Everything else — Icecast admin credentials, LiquidSoap harbor password, AcoustID API key —
is read at runtime from the config files managed through the settings UI
(`icecast.xml`, `liquidsoap/supervisor.json`, `data/integrations-config.json`).
Internal service URLs are hardcoded as literals in `docker-compose.yml` and
never need to go in `.env`.

### Data directories

These host directories are created automatically on first run and persist across upgrades:

| Host path | Container path | Contents |
|-----------|---------------|---------|
| `./data` | `/data` | SQLite database (`radio.db`), ingest queue, config JSON files |
| `./media` | `/media` | Audio library (transcoded MP3s, indexed by SHA-256) |
| `./logs` | `/app/logs` | Structured API and supervisor log files |
| `./liquidsoap` | `/liquidsoap` (api), `/etc/liquidsoap` (ls) | Generated `mix-engine.liq` and `supervisor.json` |
| `./icecast` | `/icecast` (api), `/etc/icecast2` (icecast) | `icecast.xml` config |
| `./data/certs` | `/etc/icecast2/certs`, `/etc/liquidsoap/certs` | TLS certificates |

### First start

```bash
git clone https://github.com/whadafunk/soono-radio.git
cd soono-radio
docker compose up --build -d
```

That's it. No setup steps — `.env` is committed with working defaults.

If your production domain isn't already in `CORS_ORIGINS`, add it to `.env` before starting:

```
CORS_ORIGINS=http://localhost,...,https://radio.example.com
```

Follow logs:
```bash
docker compose logs -f
```

On first start the `api` container runs all database migrations, generates the initial
`mix-engine.liq`, and only then signals healthy — LiquidSoap waits for that signal before
starting, so startup order is guaranteed.

First build takes ~5 minutes — essentia and mood models are downloaded during `docker build`
and cached in subsequent builds.

### Upgrading

```bash
docker compose pull          # pull new images
docker compose up -d         # recreate containers; api runs new migrations on startup
```

Database migrations are applied automatically at startup via Drizzle's migrator. They are
additive-only — no manual SQL needed for routine upgrades.

> **Rollback note:** Drizzle has no down-migrations. Rolling back to an older image after
> a schema-changing upgrade requires restoring a database backup, not just swapping the image.
> Back up `./data/radio.db` before major upgrades.

### Restarting individual services

The **Restart Icecast** and **Restart LiquidSoap** buttons in the UI go through the
`socket-proxy` service, which exposes only `POST /containers/*/restart` on the internal
network. The Docker socket is never mounted directly into application containers.

You can also restart from the host:
```bash
docker compose restart icecast
docker compose restart liquidsoap
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

This path works but the operator is responsible for Python version management and model
updates. Docker is strongly preferred.

---

## Dependency Reference

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

**Python 3.11 or 3.12 only.** essentia and essentia-tensorflow publish binary wheels for
3.11 and 3.12. Python 3.13+ is not yet supported — pip will attempt to compile from source
and fail. This constraint applies to both dev and production.

### essentia-tensorflow platform support

essentia-tensorflow is hosted on Essentia's own pip index (`https://essentia.upf.edu/python-extras/`),
not PyPI. It ships wheels for:
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

The `audio_analysis_enabled` flag in Settings → Integrations can be set to `false` to
suppress the failed-analysis noise entirely until the environment is ready.
