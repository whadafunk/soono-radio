# Plan: Supervisor — MVP-B

**Status:** MVP-B shipped (Steps 1–4 complete). Plus follow-ups: now-playing fix, telnet command corrections + serialization, smart boot recovery, settings tab + in-place restart. Two items pinned for future sessions — see "Pinned follow-ups" below.
**Last reviewed:** 2026-04-29
**Depends on:** Library Phases 1–5 (the picker reads from `media`),
Mix Engine "boring forever" script (commit `b2d31a9`, queue is in place).
**Unblocks:** clocks + schedules, ad rotation, reports, Live Assist.

---

## Goal of MVP-B

The smallest version of the Supervisor that **actually plays music**.
Operator drops files into Library → music, restarts the API, the
Streaming Engine starts broadcasting random music forever. Live takeover
via harbor still works (Mix Engine fallback handles it; Supervisor
doesn't have to know).

What's deliberately **out** of MVP-B:
- Clocks (time-of-day rules)
- Schedules (morning vs night programming)
- Ad rotation, contracts, ad insertion
- Category mixing — only `music` plays; jingles/ads/voice IDs sit in the
  library unused
- DJ overrides ("skip", "go live now")

All of those layer on top of MVP-B in subsequent phases without
re-doing this work.

---

## Locked decisions

- **Lifecycle**: in-process module inside `apps/api/src/services/supervisor/`.
  Public interface kept narrow (`start`/`stop`/`getStatus`/`enqueue`/`onPlayed`)
  so a future split into `apps/supervisor/` is mechanical.
- **Mix Engine script shape**: already shipped (`b2d31a9`). The `queue` is in
  place; the Supervisor just pushes to it via telnet. No further `.liq` changes
  for MVP-B.
- **Picker policy (V1)**: random pick from `media` where `category='music'`,
  excluding tracks played within the last 30 minutes (separation, configurable).
- **Play-history row written at play-start** (not at push time). Includes
  `ended_at`, `aborted`, `live_listener_count`, `pick_reason`.
- **No automatic pruning** of `play_history`.
- **Dashboard**: replace today's "On Air" widget with a "Now Playing" card
  that shows the active row + queue depth + listener count.

---

## Architecture

```
                   Supervisor module (in apps/api/)
                ┌───────────────────────────────────┐
                │                                    │
   start() ──►  │  scheduler tick (every 5 s)        │
                │    │                               │
                │    ├──► telnet: queue.depth        │  (telnet 1234)
                │    │                               │  ◄─── Mix Engine
                │    ├──► picker.next() (DB read)    │
                │    │                               │
                │    └──► telnet: request.queue.push │
                │                                    │
                │  metadata watcher (background)     │
                │    │ ◄── Mix Engine fires "track   │
                │    │     started" via `on_track`   │
                │    │     hook in mix-engine.liq    │
                │    └──► play_history insert        │
                │                                    │
                │  exposes: getStatus(), onPlayed()  │
                └─────────┬─────────────────────────┘
                          │
                          ▼
                  /supervisor/status        ◄── React Dashboard
                  /supervisor/recent-plays
```

Two concurrent loops, both inside the same process:

1. **Scheduler tick (every ~5 s)** — checks queue depth via telnet, calls
   the picker if depth is below 1, pushes the chosen track. Fast, infrequent.
2. **Metadata watcher (continuous)** — listens for "now-playing changed"
   signals from Mix Engine; when a new track goes live, writes the
   `play_history` row and closes out the previous one (`ended_at` set,
   `aborted` calculated from whether `started_at + duration_seconds`
   matches `now()`).

Both loops share the telnet connection (one socket, line-multiplexed).

---

## DB schema (added in Phase 1 of this plan)

```ts
play_history = sqliteTable('play_history', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  media_id:  integer('media_id').references(() => media.id, { onDelete: 'set null' }),
  source:    text('source', { enum: ['auto', 'live', 'manual'] }).notNull(),
  started_at: integer('started_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  ended_at:  integer('ended_at', { mode: 'timestamp' }),
  aborted:   integer('aborted', { mode: 'boolean' }).notNull().default(false),
  live_listener_count: integer('live_listener_count'),
  pick_reason: text('pick_reason'),
}, (t) => ({
  startedAtIdx: index('play_history_started_at_idx').on(t.started_at),
  mediaIdx:     index('play_history_media_id_idx').on(t.media_id),
  sourceIdx:    index('play_history_source_idx').on(t.source),
}));
```

8 columns + 3 indexes + 1 FK. `media_id` nullable + `set null` so plays
survive media deletion. New Drizzle migration: `0001_play_history.sql`.

---

## Files to create

All under `apps/api/src/services/supervisor/`.

| File | Purpose |
|---|---|
| `telnet.ts` | Long-lived connection class. Reconnect with exponential backoff (1 s → 30 s cap). Line-buffered. Exposes `command(cmd)` (one-shot), `pushQueue(uri)`, `subscribe(eventType, handler)` for metadata events, `disconnect()`. |
| `picker.ts` | Pure function `pickNext(now: Date, recentPlays: PlayRow[]): { mediaId; pickReason } \| null`. No I/O — takes inputs, returns choice. Easy to unit-test. Strategy: filter `media` by `category='music'`, drop ids where `last_played_at > now - 30min`, random choice. |
| `scheduler.ts` | The 5-second tick loop. `start()` schedules the interval, `stop()` clears it. On each tick: `queue.depth` via telnet; if `< 1`, query DB for candidates, call picker, push. Logs to fastify logger. |
| `metadataWatcher.ts` | Subscribes to telnet metadata events. On track start: insert `play_history` row, close out the previous row (`ended_at = now`, `aborted = ended_early?`). On harbor connect/disconnect: insert/close `live` rows. |
| `playHistory.ts` | DB helpers — `recordStart(mediaId, source, pickReason)`, `recordEnd(id, aborted)`, `getRecent(limit)`, `getCurrentlyPlaying()`. |
| `index.ts` | The module's public face. `start()` / `stop()` / `getStatus()` / `enqueueManual(mediaId)` / `onPlayed(handler)`. Wires telnet + scheduler + metadataWatcher together. |

**One Mix Engine script change** (template in `liquidsoapConfig.ts`):
add an `on_track` callback that emits a metadata line the Supervisor's
metadata watcher can parse. Concretely:

```liquidsoap
def supervisor_on_track(m) =
  # Emit a structured line we can grep on the telnet output.
  print("supervisor.track.started: " ^ json.stringify(m))
end
queue = on_track(supervisor_on_track, queue)
```

That `print()` lands in stdout, but more importantly the metadata is
available via telnet `var.get queue.metadata`. Implementation detail —
the metadataWatcher's transport is "poll `output.icecast.remaining` and
`queue.metadata` every tick" rather than push notifications, since
Liquidsoap's telnet doesn't have a clean event-stream interface.

## Files to modify

| File | Change |
|---|---|
| `apps/api/src/db/schema.ts` | Add `play_history` table |
| `apps/api/drizzle/0001_*.sql` | Generated migration |
| `apps/api/src/index.ts` | Wire `supervisor.start()` into boot, after `runMigrations()` and before `listen()`. `stop()` on `SIGTERM` |
| `apps/api/src/routes/` (new file `supervisor.ts`) | `GET /supervisor/status`, `GET /supervisor/recent-plays?limit=20`, `POST /supervisor/skip` (Phase 1 stub returning 501 — comes later) |
| `apps/api/src/services/liquidsoapConfig.ts` | Add the `on_track` callback to the generated script template |
| `apps/web/src/api.ts` | `fetchSupervisorStatus`, `fetchRecentPlays` |
| `apps/web/src/pages/Dashboard.tsx` | Replace the existing "On Air" card with a "Now Playing" card showing active row + queue depth + listener count. Keep the rest of the dashboard. |
| `packages/shared/src/schemas/supervisor.ts` (new) | Zod schemas: `PlayHistorySchema`, `SupervisorStatusSchema`, `RecentPlaysResponseSchema` |
| `packages/shared/src/index.ts` | Re-export |

---

## Public interface (`apps/api/src/services/supervisor/index.ts`)

```ts
export interface SupervisorStatus {
  running: boolean;
  reachable: boolean;        // is the Mix Engine telnet alive?
  queue_depth: number;       // 0 / 1 / 2 …
  on_air_source: 'live' | 'auto' | 'none';
  current_play_id: number | null;  // FK into play_history
}

export function start(): Promise<void>;
export function stop(): Promise<void>;
export function getStatus(): SupervisorStatus;
export function enqueueManual(mediaId: number): Promise<void>;  // for Phase 5+ Live Assist
export function onPlayed(handler: (play: PlayHistoryRow) => void): () => void;  // unsubscribe
```

That's the entire surface. When we split this into a separate process
later, this becomes the HTTP API contract.

---

## Picker logic (V1, no clocks yet)

```ts
function pickNext(
  now: Date,
  candidates: Media[],          // pre-filtered: category='music', has audio file
  recentPlays: PlayHistoryRow[],
  separationMinutes = 30,
): { mediaId: number; pickReason: string } | null {
  const cutoff = new Date(now.getTime() - separationMinutes * 60_000);
  const recentlyPlayedIds = new Set(
    recentPlays.filter((p) => p.started_at > cutoff).map((p) => p.media_id)
  );
  const eligible = candidates.filter((c) => !recentlyPlayedIds.has(c.id));
  if (eligible.length === 0) return null;  // empty library or all blocked
  const choice = eligible[Math.floor(Math.random() * eligible.length)];
  return {
    mediaId: choice.id,
    pickReason: `random pick category=music separation=${separationMinutes}min`,
  };
}
```

Pure, deterministic given inputs (well, except `Math.random()` — easy to
inject for tests). When the picker returns null (empty library or all
recently played) the scheduler logs and the Mix Engine plays silence
until the situation resolves.

---

## Step order (each step = one merge unit)

### Step 1 — schema + skeleton + telnet client
- New migration adding `play_history`
- `telnet.ts` with reconnect logic + tests against a mock telnet server
- `index.ts` with `start()`/`stop()`/`getStatus()` stubs (no scheduling
  yet — just opens telnet and exposes status)
- Wire into `apps/api/src/index.ts` boot
- New routes file (`/supervisor/status` returning the bare status)
- No Liquidsoap script change yet

**End state:** API boots, opens telnet to Mix Engine, `/supervisor/status`
returns `{ running: true, reachable: true, queue_depth: 0, on_air_source: 'auto', current_play_id: null }`. Mix Engine still plays silence — Supervisor isn't pushing yet.

### Step 2 — picker + scheduler tick
- `picker.ts` with the function above
- `scheduler.ts` — 5 s tick, calls picker, pushes via telnet
- Unit tests for picker (separation logic)

**End state:** Music actually plays. No play history yet.

### Step 3 — play history + metadata watcher
- `playHistory.ts` DB helpers
- `metadataWatcher.ts` subscribes to track-start/end events
- Mix Engine script gets the `on_track` callback in the generator
- `getStatus()` includes `current_play_id`

**End state:** Every track that airs writes a `play_history` row.
`/supervisor/recent-plays` returns the last 20.

### Step 4 — Dashboard widget
- `GET /supervisor/recent-plays` route
- Replace the on-air widget with a Now Playing card
- Live listener count column

**End state:** Operator opens the Dashboard, sees what's playing now and
what's coming up. Looks like a real radio app for the first time.

---

## Verification

1. Start Streaming Engine, Mix Engine, API.
2. Upload 3+ music tracks via Library → Upload.
3. Within ~5 s of API boot: `/supervisor/status` → `queue_depth=0` → picker
   runs → first track is pushed → Mix Engine starts playing.
4. Listeners hear continuous music. Tracks transition with the configured
   crossfade.
5. Dashboard "Now Playing" card shows current track + queue (1 track ahead).
6. After each track ends, `play_history` has a new row with `ended_at`
   set, `aborted=false`, `live_listener_count` populated.
7. Connect BUTT (live takeover). Expected:
   - Mix Engine `fallback` switches to live source (audible crossfade)
   - Current `play_history` row gets `ended_at = now`, `aborted = true`
   - A new `play_history` row with `source='live'`, `media_id=null` is
     opened
   - `/supervisor/status` reports `on_air_source='live'`
8. Disconnect BUTT. Expected:
   - Live row gets `ended_at = now`, `aborted = false`
   - Scheduler resumes auto-picking
9. Restart API mid-track. Expected: tick resumes; whatever Mix Engine was
   playing continues uninterrupted (because Mix Engine itself is alive);
   the metadata watcher reattaches and the next track picked logs
   correctly.
10. `sqlite3 data/radio.db "SELECT count(*), source FROM play_history GROUP BY source"`
    after a 30-min run shows several `auto` rows and (if BUTT was tested)
    `live` rows.

---

## Out of scope for MVP-B (pinned for later)

- Clocks (time-of-day source selection)
- Schedules (day-of-week / show-based programming)
- Ad rotation + contract counters
- Voice tracking (DJ pre-recorded links between tracks)
- DJ skip / go-live overrides via UI
- Playing categories other than `music`
- Custom rotation rules per track (dayparting, separation overrides)
- Crossfade tweak per source (auto-vs-auto vs auto-vs-live)
- "Force play" / "stop" / "kill the music" big-red-button
- Force-pick a specific track from the Library UI (Phase 5+ of supervisor work)

These all sit on top of the same play_history table and the same
telnet connection, so MVP-B's foundations remain valid as we layer them in.

---

## Pinned follow-ups (revisit in future sessions)

### 1. LS → API webhooks (Option C)

Replace metadata polling with a push channel. In `mix-engine.liq`, register
an `on_track` callback that POSTs to a new
`/supervisor/internal/track-start` endpoint. Sub-second updates, event-
driven semantics, no polling load. Detailed pros/cons discussed in the
prior session — main drawback is the .liq script gains real logic that
has to know the API's URL, plus a new HTTP endpoint to keep healthy
with auth (localhost-only or shared secret). Polling stays as the
fallback when the webhook is unreachable.

Approach when picking this up:
- Add `webhook_url` and a generated secret to the Supervisor config
- Generator injects them into `mix-engine.liq` via `http.post` from the
  `on_track` callback
- New POST endpoint validates the secret, applies the same logic as the
  metadata watcher (close previous row, refresh started_at on new one)
- Heartbeat endpoint at 30 s for "is LS still alive" without grepping logs

### 2. Crossfade revisit

LS 2.2's `crossfade` requires `source('a)` (infallible by type), and
our `request.queue → fallback → ...` chain produces `source(?'a)`.
`mksafe()` is just sugar for `fallback([s, blank()])` and has the same
type, so it doesn't help. Generator currently emits a comment
documenting the operator's choice and skips the actual crossfade line.

Three approaches worth iterating against the running container:
- (a) Use `playlist()` instead of `request.queue()` — playlists are
  infallible, so `crossfade(playlist(...))` type-checks. Cost: lose
  telnet-driven queue control; supervisor would need to write a
  playlist file every push instead of using `auto.push`. Ugly.
- (b) Use `cross()` (lower level) with explicit transition function.
  May type-check on fallible sources because the function handles them.
  Earlier attempts got a different error; worth retrying with the
  full LS 2.2 stdlib reference open.
- (c) Apply crossfade to the queue ONLY (after a `mksafe`-then-cast
  trick if there is one), accept that live↔queue transitions hard-cut
  (which is normal for radio anyway).

Best path: pick (b) first, iterate against `docker exec radio-liquidsoap nc localhost 1234` until a `cross(...)` invocation type-checks; fall back to (a) or (c) if (b) refuses.

---

## Open questions for later

- **Picker policy when library is empty or all blocked**: today returns
  null → silence. Should we surface a Dashboard banner ("automation
  starved — add tracks or reduce separation")? Probably yes; trivial.
- **Separation override per-track**: do we want some tracks to bypass
  separation (e.g., a station ID that *should* be repeatable)? Pin until
  categories beyond `music` enter the picker.
- **Time-zone**: does the picker need timezone awareness for "morning
  drive"-type rules? Not for V1 (no clocks). Pin for the clocks phase.
- **Concurrent station support**: when we go multi-station, each Mix
  Engine instance needs its own Supervisor instance pushing to its own
  telnet port. Trivial extension — just parameterise `start()` with a
  station id and connection details.
