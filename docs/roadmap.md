# Roadmap

## What's Built

### Infrastructure & Core
- [x] Monorepo: apps/api, apps/web, packages/shared
- [x] Fastify API with Drizzle ORM + SQLite
- [x] React + Vite frontend with TanStack Query
- [x] Docker Compose for Icecast
- [x] Icecast XML config management (parse, edit, write, restart)
- [x] LiquidSoap script generation + telnet control
- [x] SSL/TLS certificate management

### Supervisor (Real-Time Engine)
- [x] Scheduler loop: queue depth polling + push to LiquidSoap
- [x] MetadataWatcher: live/auto source detection + play history tracking
- [x] Boot recovery: close stale open play_history rows on restart
- [x] Play history: tracks every push, actual airtime, aborted flag, listener count
- [x] Supervisor config: tunable via API + UI

### Content Management
- [x] Media library: upload, analyze (ffprobe), transcode (ffmpeg), loudness normalization
- [x] Library browse: search, filter, sort, bulk actions, cue point editing
- [x] Playlists: CRUD, add/remove media, sort_order, weight
- [x] Rotations: CRUD with type-specific params (all 5 algorithms defined)
- [x] Shows: CRUD, colors, host/producer, duration, show playlists + tiers
- [x] Clocks: CRUD + full segment editor (drag reorder, delay policy, recovery tactics)

### Scheduling UI
- [x] Weekly template entries (day_of_week + time range → show/clock)
- [x] Template clock entries (per-hour clock overrides)
- [x] Calendar entries (one-off date overrides)
- [x] Schedule page: drag-to-create blocks, color-coded, edit modal

### Ad Management
- [x] Customers: CRUD with account manager assignment
- [x] Campaigns: CRUD with full constraint fields (time windows, day restrictions, exclusions, pacing targets)
- [x] Campaign media: assign spots/sweeps, spot/sweep flags
- [x] Campaign pacing endpoint

### Dashboard
- [x] Live Icecast stats (listeners, bitrate, uptime)
- [x] Now playing with progress bar
- [x] Recent plays table
- [x] Kick source button (SSL stale-source workaround)

---

## What's Not Done

### Picker: Clock Integration (Next Major Phase)
The Supervisor's picker currently does **random pick with separation only**. It does not yet:

- [ ] Resolve the current clock segment (what type of content should play right now)
- [ ] Select content based on segment source type (show_playlist, rotation, campaign, live_input)
- [ ] Apply rotation algorithms from `rotations` table
- [ ] Apply tier-based fallback (hot → medium → cold → emergency)
- [ ] Apply delay policy: measure drift, trigger recovery only when threshold exceeded
- [ ] Execute recovery tactics: trim_outro, skip_song, drop_queued
- [ ] Enforce campaign delivery constraints (time windows, day restrictions, exclusions, advertiser separation)
- [ ] Apply campaign pacing boosts/penalties

This is the largest remaining piece. The schema is complete; the logic needs to be written in `picker.ts` and `scheduler.ts`.

### Schema Migration Needed
- [ ] Split `clock_segments.delay_policy` into `start_policy` (JSON: hard/soft) and `end_policy` (enum: fixed/flexible) — agreed design change, not yet reflected in schema or UI

### Other Gaps
- [ ] Playlist management UI (page exists but is a placeholder)
- [ ] Live assist controls (skip button returns 501)
- [ ] Show detail page: show playlists / tier association UI
- [ ] Mid-hour clock handoff strategies (currently only `finish_clock` conceptually)
- [ ] Authentication / login (users table exists, no auth middleware yet)
- [ ] `plays_per_day` enforcement in campaign picker
- [ ] Ingest: re-transcode on demand fully wired
- [ ] Dashboard: LiquidSoap health card (currently just Icecast)

---

## Design Intent & Priorities

### Why clocks are the core abstraction
The scheduling model is deliberately clock-centric (not playlist-centric). A clock segment can be anything — music, ads, live, silence — which makes it flexible enough to model any radio format. The delay policy and recovery tactics on each segment are what allow the system to maintain precision timing (e.g. hitting a news segment exactly on the hour) while still being flexible for music blocks.

### Why the picker is separate from the scheduler
The scheduler only knows about timing and queue depth. The picker knows about content selection. Keeping them separate means the clock integration (picker changes) doesn't affect the queue management loop (scheduler). It also makes the picker testable in isolation.

### Why campaign constraints are complex
Radio ad contracts have hard legal/contractual requirements: competing brands can't air back-to-back, ads can only run in certain dayparts, guaranteed campaigns must hit their targets. The constraint model in the database captures all of these. The enforcement logic (not yet written) will implement them in the picker.

### Authentication is deferred deliberately
The system is designed for a trusted internal network (single station). Auth adds complexity and the operator UX suffers. The users table exists for future use (multi-user, role-based access), but shipping without auth first is intentional.

### What to work on next
The natural next step is implementing the clock-aware picker. That unlocks:
1. Actual scheduled programming (right content at the right time)
2. Campaign delivery (ads air when scheduled)
3. Delay/drift management (precision timing)

Everything else (UI polish, playlist page, auth) is lower priority than making the scheduler actually follow the clock.
