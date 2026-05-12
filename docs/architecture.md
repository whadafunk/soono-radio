# Architecture

## System Overview

```
┌──────────────────────────────────────────────────────┐
│  Web UI  (React 18 + Vite + Tailwind)                │
│  Port 5173                                           │
│  Schedule / Shows / Clocks / Library / Settings      │
└──────────────────┬───────────────────────────────────┘
                   │ HTTP/JSON (React Query)
┌──────────────────▼───────────────────────────────────┐
│  API Server  (Fastify + Node.js 20)                  │
│  Port 3000                                           │
│  ┌───────────┐  ┌────────────┐  ┌──────────────────┐│
│  │  Routes   │  │  Services  │  │   Supervisor     ││
│  │  (CRUD)   │  │  (ingest,  │  │  scheduler.ts    ││
│  │           │  │   icecast, │  │  picker.ts       ││
│  │           │  │   liquids) │  │  metadataWatcher ││
│  └───────────┘  └────────────┘  └──────────────────┘│
│       │                                  │           │
│  ┌────▼────┐                    ┌────────▼─────────┐ │
│  │ SQLite  │                    │  LiquidSoap      │ │
│  │ (Drizzle│                    │  Telnet :1234    │ │
│  │  ORM)   │                    └────────┬─────────┘ │
│  └─────────┘                             │           │
└─────────────────────────────────────────┼───────────┘
                                          │
                                 ┌────────▼─────────┐
                                 │     Icecast       │
                                 │     Port 8000     │
                                 └───────────────────┘
```

## Component Responsibilities

### Web UI
- All operator interaction (scheduling, library management, settings)
- No business logic — purely a view/control layer
- Talks only to the API server; never directly to LiquidSoap or Icecast

### API Server
Three concerns live here:

**Route handlers** — thin CRUD over the database. Validate input (Zod), call service or query DB, return JSON.

**Services** — stateful or I/O-heavy operations:
- `ingest/` — file upload, ffprobe analysis, ffmpeg transcoding
- `icecast/` — parse/write Icecast XML config, restart daemon
- `liquidsoap/` — generate/write radio.liq script, telnet commands

**Supervisor** — the real-time playback engine (see [scheduling.md](./scheduling.md)):
- Polls LiquidSoap every N ms
- Decides what to push to the queue next
- Tracks what's actually playing via telnet metadata

### SQLite + Drizzle ORM
- Single file database, zero config
- Schema in `apps/api/src/db/schema.ts` — source of truth
- Drizzle handles migrations
- Zod schemas in `packages/shared/` mirror the DB for API validation

### LiquidSoap
- Audio engine: crossfading, normalization, mixing live + auto sources
- Controlled via telnet on port 1234
- `auto` source: queue-based, API pushes tracks via `auto.push`
- `live` source: Harbor input (DJ connects via Icecast source protocol)
- Script generated from `LiquidsoapConfig` and written to `radio.liq`

### Icecast
- Receives LiquidSoap output, distributes to listeners
- Config written as XML by the API
- Admin API polled for listener counts and mount stats
- Runs in Docker container (start with `./start-icecast.sh`)

## Data Flow: Automated Playback

```
1. Supervisor.scheduler wakes (every 5s)
2. Queries LS: auto.queue depth
3. If depth < threshold:
   a. Supervisor.picker selects next track from DB
   b. Inserts play_history row (started_at = push time)
   c. Pushes to LS: auto.push annotate:play_history_id="42":/media/<sha>.mp3
4. Supervisor.metadataWatcher (every 5s):
   a. Checks request.on_air — which request is playing
   b. Extracts play_history_id annotation
   c. Updates play_history row: actual started_at, listener_count
   d. Closes previous row: ended_at, aborted flag
```

## Data Flow: Live Override

```
1. DJ connects to Harbor (LS source protocol)
2. MetadataWatcher detects live.status = connected
3. Marks current auto play_history row as aborted=true
4. Opens new play_history row: source='live', no media_id
5. DJ disconnects → auto source takes over
6. MetadataWatcher detects live.status = disconnected
7. Closes live row, resumes tracking auto
```

## Monorepo Structure

```
apps/api/src/
  db/schema.ts          Database schema (Drizzle + SQLite)
  routes/               One file per domain (shows, clocks, schedule, ...)
  services/
    supervisor/
      index.ts          Supervisor bootstrap + restart logic
      scheduler.ts      Queue depth polling + push
      picker.ts         Track selection algorithm
      metadataWatcher.ts Live/auto detection + play history tracking
    ingest/             Upload pipeline (see ingest.md)
    icecast.ts          XML config + admin API
    liquidsoap.ts       Script generation + telnet client

apps/web/src/
  pages/                One directory/file per route
  components/           Shared UI (modals, tables, forms)
  hooks/                React Query wrappers
  lib/                  API client, utils

packages/shared/src/
  schemas/              Zod schemas (API + UI share these)
```
