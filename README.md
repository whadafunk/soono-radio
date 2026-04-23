# Radio Automation & Streaming Server

A modern, containerized radio automation and streaming server with a responsive web control panel. Manage Icecast, LiquidSoap, playlists, and jingles all from one dashboard.

## Tech Stack

- **Frontend**: React + TypeScript, Vite, Tailwind CSS, React Router
- **Backend**: Node.js + TypeScript, Fastify, Zod
- **Infrastructure**: Docker Compose
- **Streaming**: Icecast, LiquidSoap (coming soon)

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm (or npm)
- Docker & Docker Compose

### Development

Install dependencies:
```bash
pnpm install
```

Start all services (API, web dev server, Icecast):
```bash
docker compose up -d
pnpm dev
```

The app will be available at `http://localhost:5173` and the API at `http://localhost:3000`.

### Building for Production

```bash
docker compose build
docker compose up -d
```

Or with Docker only:
```bash
pnpm build
docker compose -f docker-compose.yml up --build
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
└── docker-compose.yml
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
