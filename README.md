# Radio Automation & Streaming Server

A modern, containerized radio automation and streaming server with a responsive web control panel. Manage Icecast, LiquidSoap, playlists, and jingles all from one dashboard.

## Tech Stack

- **Frontend**: React + TypeScript, Vite, Tailwind CSS, React Router
- **Backend**: Node.js + TypeScript, Fastify, Zod
- **Package Manager**: pnpm (monorepo with workspaces)
- **Streaming**: Icecast, LiquidSoap (coming soon)

## Getting Started

### Prerequisites

| Tool | Purpose | Install (Mac) | Install (Ubuntu) |
|------|---------|--------------|-----------------|
| Node.js 20+ | API + frontend runtime | `brew install node` | `nvm install 20` |
| pnpm | Package manager | `npm install -g pnpm` | `npm install -g pnpm` |
| Docker | Icecast + LiquidSoap containers | Docker Desktop | `apt install docker.io` |
| ffmpeg / ffprobe | Audio probe, transcode, loudness | `brew install ffmpeg` | `apt install ffmpeg` |
| fpcalc (Chromaprint) | AcoustID audio fingerprinting | `brew install chromaprint` | `apt install libchromaprint-tools` |
| Python 3.11+ | Audio analysis runtime | `brew install python@3.11` | `apt install python3.11 python3-venv` |
| aubio + essentia | BPM, key, mood analysis | `./analysis/setup.sh` | same |
| Essentia mood models | ML mood classifiers | `./analysis/download_models.sh` | same |

> **Note:** Python and Essentia are only required for the audio analysis pipeline (BPM/key/mood detection on ingested music). The app runs without them — analysis will be skipped with a warning. `setup.sh` creates an isolated virtual environment so it won't conflict with system Python.

### Development

**Terminal 1 — Start Icecast:**
```bash
./start-icecast.sh
```

**Terminal 2 — Start API + Web (both with hot-reload):**
```bash
pnpm install  # one time only
pnpm dev
```

The app will be available at `http://localhost:5173` (with instant Vite hot-reload)  
API at `http://localhost:3000`  
Icecast at `http://localhost:8000`

### Building for Production

```bash
pnpm build
# Creates dist/ in both apps/web and apps/api, ready to deploy
```

## Features

### Dashboard
- Live listener count
- Stream status
- Mount point information
- Bitrate monitoring

### Icecast Settings Panel
Configure server identity, network, authentication, limits, mount points, and logging directly from the web UI.

### Coming Soon
- LiquidSoap automation
- Playlist management
- Jingle organization

## Architecture

This is a **monorepo** using pnpm workspaces:

```
radio/
├── apps/
│   ├── web/      # React frontend (Vite)
│   └── api/      # Fastify backend
├── packages/
│   └── shared/   # Zod schemas (shared types)
├── icecast/      # Icecast config
└── start-icecast.sh  # Start Icecast container for dev
```

Shared Zod schemas (`packages/shared`) ensure type safety between frontend and backend.

## Scripts

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Run frontend dev server + backend in parallel |
| `pnpm build` | Build all packages |
| `pnpm type-check` | TypeScript type checking |

## API Endpoints

- `GET /icecast/config` — Fetch current Icecast configuration
- `POST /icecast/config` — Update Icecast configuration

## License

MIT
