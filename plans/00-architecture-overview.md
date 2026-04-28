# Architecture Overview & Long-Range Roadmap

**Status:** living reference document. Open questions in §"Open questions to revisit" — we'll come back here as those become urgent.

**Last reviewed:** 2026-04-28

---

## Mental model: a professional radio station

The system serves a station that has to broadcast on a contract:
playlist + jingles + ads + live shows, with reportable airtime to authorities
and clients. The architecture is shaped around that — every component below
exists because some real station workflow demands it.

---

## Components

### 1. Administration Frontend ✅ (in progress)
Operator-facing React app: Icecast settings, Liquidsoap settings, certificates,
later library, schedule, customers, reports.

### 2. Backend (config + control API) ✅ (in progress)
Fastify, owns:
- Icecast XML config read/write
- Liquidsoap config + script generation
- Certificate management
- Restart orchestration
- (Later) library, schedule, ad rotation, reports

### 3. Streaming server ✅ (Icecast running)
Volumes mounted today: certs, logs, config-file. Volumes to add later:
recordings (legal archive), intro-sounds, station-IDs.

### 4. Playout engine ✅ (Liquidsoap running, automation = silence today)
Liquidsoap + ffmpeg (for ingest). Today: silence + harbor. Future: queue-driven
playback (see §"Supervisor model").

### 5. Live Assist console (future)
**Not a separate app.** Just another React route in the existing frontend.
DJ-facing UI: timeline, "go live", "skip", "queue jingle now", "drop ad now".
Talks to the playout API namespace.

### 6. API for Liquidsoap — separate or shared with main backend?

**Decision: one Fastify app, route-namespaced.** `/icecast/*`, `/liquidsoap/*`,
later `/playout/*`, `/library/*`, `/reports/*`, `/portal/*`.

**Supervisor placement (decided 2026-04-28):** lives as a service module
inside `apps/api/` (not a separate Node process). Public interface kept
narrow (`start()`, `stop()`, `enqueue()`, `getStatus()`, `onPlayed()`) so a
future split into `apps/supervisor/` is mechanical — wrap the same
interface in HTTP, change callers to forward instead of call. Triggers for
that split: separate-host deploy, measurable latency impact on API
requests, or independent restart cycles.

Why one backend:
- One deploy, one auth surface, one log stream
- Code reuse: same Zod schemas, same React Query setup
- Live Assist can ship without service-to-service auth
- Realistic load shape doesn't need split

When to split (revisit):
- Playout box must run on different hardware than admin box (remote-station
  deployment: DJ at home, station automation in colo)
- Realtime traffic shape diverges (10k+ WebSocket connections vs CRUD)
- Telnet-hung endpoints starve config endpoints (mitigated for now via
  isolated service modules + timeouts)

### 7. Reporting engine
Same backend, route namespace `/reports/*`. New pages in existing frontend.
Heavy report generation (PDF, large CSV) goes to a job queue when it slows
down API requests — not before.

### 8. Customer Care Portal
**This one we DO split** — but for non-technical reasons:
- Auth boundary: customers should not share the admin auth surface
- Public exposure: admin behind VPN/IP allowlist; portal on open internet

Same backend (route namespace `/portal/*`), **different React app**, different
domain (`portal.station.com` vs `admin.station.com`). Customer auth = email
+ 2FA, separate from staff auth.

### 9. Database — SQLite vs MariaDB vs Redis?

**Decision: SQLite + nothing else, until a specific bottleneck.**

SQLite handles ~50k writes/sec WAL mode. Radio station logs ~6 plays/hour.
Bottleneck will never be SQLite.

Migrate to Postgres/MariaDB when:
- Multiple servers reading/writing same DB (multi-station, HA pair)
- Complex concurrent writes from many DJ consoles editing the same playlist
- Reports get slow → ClickHouse or read replica

Add Redis when:
- Pub/sub for "now playing" events to many DJ consoles (alternative: in-process
  EventEmitter is fine until multiple backend processes)
- Job queue for transcoding/reports (alternative: BullMQ on Redis, or simpler
  `node-cron` for scheduled work)
- Session storage with multiple backend instances

Storage tip: schema portably (avoid SQLite-only types), Drizzle abstracts the
migration to Postgres later — mostly mechanical.

---

## Cross-cutting concerns

### Multi-instance Liquidsoap (planned)

**Multiple containers, not multiple processes per container.** Reasons:
- Crash isolation (one dies, others survive)
- Per-container CPU/memory limits
- Rolling restarts
- Cleaner port management

Implications for current code:
- `liquidsoap/config.json` becomes per-instance: `liquidsoap/{stationId}/config.json`
  *or* moves into the database
- Routes: `/liquidsoap/:stationId/config` etc., default `:stationId` = `default`
- UI: station selector at top of LiquidSoap settings page

### Supervisor model — playout logic decoupled from Liquidsoap

**This is the single biggest architectural commit on the roadmap.**

```
                ┌─────────────────────┐
                │  Scheduler / Brain  │   our supervisor (Node module in backend)
                │  - reads DB         │
                │  - applies clocks   │
                │  - solves contracts │
                └──────────┬──────────┘
                           │ telnet: "queue.push /audio/track-1234.mp3"
                           ▼
                ┌─────────────────────┐
                │  Liquidsoap         │   signal flow only
                │  - request.queue    │
                │  - crossfade        │
                │  - harbor input     │
                │  - icecast output   │
                └─────────────────────┘
```

`radio.liq` stays simple and stable: `q = request.queue()`, harbor + automation
fall through, push to Icecast. The scheduler decides *what* and *when*, by
writing to the queue via telnet.

DB stores everything: ad contracts, library, clocks, schedules, play history.
Scheduler runs every ~5 s, looks at "what's playing now, what's queued, what's
missing", pushes the next track when the queue is short. Liquidsoap plays
whatever's in the queue, smoothly.

Live Assist commands flow through the scheduler — DJ console can't bypass
constraint logic.

**Build it this way from the start. Keep `radio.liq` boring forever.**

### Settings split: signal-flow vs content vs schedule

| Setting type | Where it lives | Examples |
|---|---|---|
| Property of the box | Liquidsoap settings | Harbor buffer, output bitrate, master compression |
| Property of content | Library (per file) | Per-track gain trim, cue points, fade in/out |
| Property of a moment | Clock / show config | Crossfade duration for a show, ducking depth for talk-over |

**Default rule:** if it's the same regardless of what's playing → Liquidsoap
settings. If it depends on the file → library. If it depends on the time/show →
clock.

### Mountpoint fallback (Icecast feature)

Icecast `<fallback-mount>` is for **source disconnect**, not listener-side
redirect:

1. Listener connects to `/stream`
2. Source (Liquidsoap) goes away
3. Without fallback: listener disconnected
4. With `<fallback-mount>/silence</fallback-mount>`: Icecast keeps the listener
   connection open and pipes from `/silence`

In our setup mostly redundant (Liquidsoap's own `fallback(live, automation)`
handles source switching internally), but worth adding as belt-and-suspenders
against Liquidsoap process death once the supervisor is in place.

---

## Things to add to the roadmap (not in user's original list)

1. **Audit log / play history** — every track that aired, with timestamps,
   source (automation/live/manual), DJ identity. Foundation for ad reports.
   Day-one of supervisor.
2. **Auth + RBAC** — admin / DJ / sales / customer roles. Becomes urgent when
   Live Assist exists.
3. **Backup of `liquidsoap/audio/` and the DB** — radio stations lose all
   their music if the disk dies. Hourly snapshot to S3-compatible storage.
4. **Stream recording / archive** — required by law in many jurisdictions
   (broadcast archivable for ~30 days). Liquidsoap can write rolling MP3
   files of its own output. One line of `radio.liq`.
5. **Metrics & observability** — listener count over time, dead-air events,
   source disconnects. Prometheus + Grafana, or local dashboards over
   the SQLite tables.
6. **Failover** — for serious deployments, two playout boxes with a heartbeat.
   Out of scope for V1; architecture should not preclude it.
7. **NTP** — host-level (`chrony` or `systemd-timesyncd`), containers inherit.
   Becomes load-bearing once reports need precise play timestamps for legal
   compliance.

---

## Suggested phase ordering (~10 weeks)

Given Phase 1+2 (Liquidsoap integration) is done:

1. **Library + ingest pipeline** (in progress — see `01-library-ingest.md`).
   DB schema, upload, ffmpeg transcode, ReplayGain measurement, basic browse UI.
   Unblocks everything content-related.
2. **Supervisor scaffold** — Node module in backend that owns telnet, exposes
   "queue this", "what's playing", emits events. Replaces today's "Liquidsoap
   reads its own config" with "scheduler drives Liquidsoap".
3. **Clocks + schedules** — DB models, clock editor UI, daily schedule editor.
4. **Customer + contract management** — CRUD on advertisers, ads, contracts.
5. **Rotation engine** — constraint-aware ad picker, fed by the supervisor.
   Greedy heuristic, not a SAT solver.
6. **Reports** — play history → ad reports → customer-visible summaries.
7. **Multi-instance support** — refactor LS routes to take stationId;
   per-station config storage.
8. **Live Assist v1** — timeline view, skip, queue jingle, go live, drop ad now.
9. **Customer Care Portal** — separate React app, customer auth, scoped reports.

---

## Open questions to revisit

These were raised but deferred:

1. **Mix-engine settings (transitions, ducking speed, compression, normalization
   placement)** — partially answered above (signal-flow vs content vs schedule
   rule), but specific defaults TBD per setting.
2. **NTP sync** — when does it become load-bearing? (Probably: when ad reports
   become legally binding for clients.)
3. **Stream recording** — confirm legal requirement for the operator's
   jurisdiction; configure rolling-archive duration.
4. **Multi-station deployment topology** — single host with multiple LS
   containers, or N hosts? Drives the supervisor's transport choice (in-process
   vs HTTP-to-remote-LS-API).
5. **Failover specifics** — active-active or active-passive? Heartbeat
   mechanism? DB replication?

When any of these blocks a feature, surface it back here, decide, then act.

---

## Living document policy

- This file changes when **architecture** changes — not when individual
  features ship.
- Phase plans (`01-library-ingest.md`, `02-supervisor.md`, etc.) live alongside.
- After each phase ships, this overview should be reviewed for "did the
  architecture diverge from what we planned?"
