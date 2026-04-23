# Radio Automation & Streaming Server

A modern, containerized radio automation and streaming server with a responsive web control panel. Manage Icecast, LiquidSoap, playlists, and jingles all from one dashboard.

## Tech Stack

- **Frontend**: React + TypeScript, Vite, Tailwind CSS, React Router
- **Backend**: Node.js + TypeScript, Fastify, Zod
- **Package Manager**: pnpm (monorepo with workspaces)
- **Streaming**: Icecast, LiquidSoap (coming soon)

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- Docker (for running Icecast)

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
