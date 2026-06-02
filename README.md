# Soono

A self-hosted radio automation and streaming server with a web-based control panel. Manage Icecast, LiquidSoap, playlists, scheduling, jingles, and ad campaigns from one dashboard.

## Features

- **Live streaming** via Icecast with configurable mounts, TLS, and listener limits
- **Audio engine** powered by LiquidSoap — crossfades, ducking, live harbor input for DJs
- **Playlist & rotation management** with category-based scheduling
- **Clock scheduling** — define time segments, sources, and rotation rules per hour
- **Jingle & sweeper automation** inserted between tracks on configurable triggers
- **Campaign management** — ad spots with duration brackets, play quotas, and show associations
- **Audio analysis** — BPM, key, energy, danceability, and mood detection on ingest (via Essentia)
- **AcoustID fingerprinting** — automatic metadata lookup on upload
- **Live dashboard** — listener count, stream status, bitrate, uptime
- **Ingest pipeline** — upload, transcode to MP3, fingerprint, analyze, tag

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, React Query |
| Backend | Node.js 20, Fastify, TypeScript, Drizzle ORM (SQLite) |
| Streaming | Icecast, LiquidSoap |
| Audio analysis | Python 3.11, Essentia, essentia-tensorflow |
| Infrastructure | Docker Compose |

## Monorepo Structure

```
apps/api/        → Fastify backend (Node.js + Python analysis)
apps/web/        → React frontend (Vite, Tailwind)
packages/shared/ → Zod schemas shared between API and UI
icecast/         → Icecast Dockerfile and config
liquidsoap/      → LiquidSoap Dockerfile and script template
docs/            → Deployment and architecture docs
```

---

## Development

### Prerequisites

| Tool | Mac | Ubuntu |
|------|-----|--------|
| Node.js 20 | `brew install node` | `nvm install 20` |
| pnpm | `npm install -g pnpm` | `npm install -g pnpm` |
| Docker | Docker Desktop | `apt install docker.io` |
| ffmpeg | `brew install ffmpeg` | `apt install ffmpeg` |
| fpcalc | `brew install chromaprint` | `apt install libchromaprint-tools` |
| Python 3.11 | `brew install python@3.11` | `apt install python3.11 python3.11-venv` |

Python and Essentia are optional — the app runs without them, audio analysis is skipped gracefully.

### Setup (one time)

```bash
pnpm install
./apps/api/analysis/setup.sh          # Python venv + essentia
./apps/api/analysis/download_models.sh # mood models (~200MB)
```

### Start dev services

```bash
# Terminal 1 — Icecast
./start-icecast.sh

# Terminal 2 — LiquidSoap (also updates .env with dev-mode URLs)
./start-liquidsoap.sh

# Terminal 3 — Socket proxy (enables Restart buttons in the UI)
./start-socket-proxy.sh

# Terminal 4 — API + Web (hot-reload)
pnpm dev
```

| Service | URL |
|---------|-----|
| Web UI | http://localhost:5173 |
| API | http://localhost:3000 |
| Icecast | http://localhost:8000 |
| LiquidSoap harbor | http://localhost:8005 |

### Type checking

```bash
pnpm type-check
```

---

## Production

Production runs entirely via Docker Compose. See **[docs/deployment.md](docs/deployment.md)** for the full guide, including:

- Port layout and published services
- Reverse proxy setup for TLS
- `.env` configuration
- Volume and data directory reference
- Upgrade procedure

Quick start:

```bash
git clone https://github.com/whadafunk/soono-radio.git
cd soono-radio
# optionally edit .env to add your domain to CORS_ORIGINS
docker compose up --build -d
```

The web UI will be at `http://your-host:8080`. Put a reverse proxy (Caddy, nginx) in front for TLS on port 443.

---

## Scripts

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Start API + Web dev servers with hot-reload |
| `pnpm build` | Build all packages |
| `pnpm type-check` | TypeScript type checking across all packages |
| `./start-icecast.sh` | Start Icecast container for dev |
| `./start-liquidsoap.sh` | Start LiquidSoap container for dev |
| `./start-socket-proxy.sh` | Start Docker socket proxy for dev |

## License

MIT
