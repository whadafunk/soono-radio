# Operations

## Running Locally

```bash
# 1. Install dependencies (once)
pnpm install

# 2. Start Icecast (separate terminal, keep running)
./start-icecast.sh

# 3. Start API + Web dev servers
pnpm dev
# API: http://localhost:3000
# Web: http://localhost:5173 (hot-reload)

# 4. Type-check (run anytime)
pnpm type-check

# 5. Production build (to verify build passes)
pnpm build
```

## Ports

| Service | Port | Notes |
|---------|------|-------|
| Web UI (dev) | 5173 | Vite hot-reload |
| API | 3000 | Fastify |
| Icecast HTTP | 8000 | Stream + admin |
| LiquidSoap telnet | 1234 | Internal control |
| LiquidSoap Harbor | 8005 | DJ source input |

## Environment Variables

Set in `.env` (not committed to git):

| Var | Default | Purpose |
|-----|---------|---------|
| `VITE_API_URL` | `http://localhost:3000` | Frontend API base URL |
| `DATABASE_URL` | `./data/radio.db` | SQLite file path |
| `MEDIA_DIR` | `./data/media` | Audio file storage |
| `ICECAST_CONFIG` | `./icecast/icecast.xml` | Config file path |
| `LIQUIDSOAP_SCRIPT` | `./data/radio.liq` | Generated LS script |

## Config Files

### Supervisor Config
`data/supervisor-config.json` — tunable via `POST /supervisor/config` + `POST /supervisor/restart`.

```json
{
  "scheduler_tick_ms": 5000,
  "metadata_poll_ms": 5000,
  "queue_depth_threshold": 1,
  "separation_minutes": 30,
  "mid_hour_handoff": "finish_clock"
}
```

### Icecast Config
`icecast/icecast.xml` — managed via the Icecast Settings page. Can also be edited via `POST /icecast/config/raw`.

### LiquidSoap Script
`data/radio.liq` — generated from LiquidSoap Settings page config. Can be edited raw via `POST /liquidsoap/script/raw`. Manual raw edits are overwritten if structured config is saved.

## Icecast Container

```bash
./start-icecast.sh          # Start (detached)
docker logs radio-icecast   # Check logs
docker stop radio-icecast   # Stop
```

The container mounts `./icecast/icecast.xml` — the API writes to this file and restarts the container when config is saved.

**Package naming (easy to get wrong):** The package is `icecast2` (not `icecast`). Binary is `icecast2`. Config path is `/etc/icecast2/icecast.xml`. System user is `icecast2`. Using `icecast` anywhere silently fails.

**ARM64 Mac note:** The official Icecast Docker image doesn't support ARM64. The container uses Ubuntu 24.04 + `apt-get install icecast2`. It runs with `--user $(id -u):$(id -g)` to avoid uid/gid mismatches with mounted log volumes.

## Database

SQLite file at `data/radio.db`. Drizzle handles migrations.

```bash
# Run migrations
pnpm --filter api drizzle-kit migrate

# Inspect DB (optional)
sqlite3 data/radio.db ".tables"
sqlite3 data/radio.db "SELECT * FROM media LIMIT 5;"
```

## Common Issues

### LiquidSoap not reachable
- Check if LiquidSoap is running: `pgrep liquidsoap`
- Check telnet works: `telnet localhost 1234`
- Check `data/radio.liq` exists and is valid
- Restart via `POST /liquidsoap/restart` or the Settings page

### Icecast source stuck (SSL bug)
When an SSL source disconnects uncleanly, Icecast holds the mount. Use the Dashboard "Kick Source" button or `POST /icecast/mounts/kick`.

### Ingest job stuck at "analyzing"
- Check ffprobe is installed: `which ffprobe`
- Check `data/staging/` for orphaned temp files
- Check API logs: `pnpm dev` output in Terminal 2

### Play history gaps / aborted tracks
Expected behavior during development or when restarting the supervisor mid-track. Boot recovery handles stale rows. If rows accumulate, check MetadataWatcher logs for telnet connection errors.

### TypeScript errors
```bash
pnpm type-check
# Fix all errors before committing — the build will fail otherwise
```

## Debugging LiquidSoap

Telnet directly to LiquidSoap for inspection:
```bash
telnet localhost 1234
# Then type commands:
help
auto.queue
request.on_air
request.metadata <id>
live.status
```

## Logs

- **API**: stdout/stderr from `pnpm dev` (Fastify logger, JSON format in production)
- **Icecast**: `docker logs radio-icecast`
- **LiquidSoap**: check the LS log file (path in radio.liq config)
- **Browser**: DevTools Network tab for API call inspection
