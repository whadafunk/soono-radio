# Supervisor V2 — Design Document

This is a living document capturing decisions as they are made. The scope is a **complete redesign** — multiprocess architecture, new LiquidSoap interface, potentially new scheduling model. How much of V1 survives is an open question; sections will be deleted and rewritten as the design progresses. Do not treat anything here as a commitment to preserving existing code.

For what exists today, see [supervisor-rebuild.md](./supervisor-rebuild.md) and [scheduling.md](./scheduling.md).

---

## Why redesign

The V1 supervisor is a polling loop over a TCP telnet connection. It works, but has three structural problems that become more painful as the system grows:

**Serialization.** The telnet client has a single `pending` slot — one command at a time. Commands from the scheduler tick and the metadata watcher queue behind each other on the same socket. This isn't a performance bottleneck today (each round-trip on localhost is ~1–5ms), but it means two parts of the system that should be independent are coupled through a shared connection.

**Polling latency.** Track transitions are detected by polling `request.on_air` every 5 seconds. A track can start playing and the system won't know for up to 5 seconds. Scheduling decisions are also made on a 5-second tick, which means picks happen as early as possible after the previous track started — potentially 3 minutes before the next track is needed — on stale pacing data. Short content (jingles, station IDs, short spots) is genuinely at risk of creating queue gaps at the 5-second polling granularity.

**Stateful connection.** The telnet client is a 180-line class managing connection state, reconnect backoff, command queuing, and timeout handling. A LiquidSoap restart requires boot recovery logic (probing alive request IDs to avoid closing legitimately-in-flight play_history rows). This complexity exists entirely because the connection is persistent and stateful.

---

## Decisions made

### Decision 1 — Replace telnet with HTTP harbor for all control commands

**Status: decided**

LiquidSoap 2.2 (which we run at 2.2.5) has a fully reimplemented harbor HTTP server. Handlers registered via `harbor.http.register` run inside the LiquidSoap process and have full access to all script variables — including the `queue` and `live` source objects. Every current telnet command can be replaced with an HTTP endpoint.

**Current telnet commands and their HTTP replacements:**

| Telnet command | HTTP endpoint | Notes |
|---|---|---|
| `auto.push <annotated_uri>` | `POST /push` | Body = annotated URI string. Returns `{ok, request_id}`. |
| `auto.queue` | `GET /queue` | Returns `{depth, ids[]}`. Can be extended to return full metadata per item (one HTTP call vs. N+1 telnet calls). |
| `live.status` | `GET /live-status` | Returns `{connected: bool}`. |
| `request.on_air` | Eliminated | Replaced by `on_track` webhook — see Decision 2. |
| `request.metadata <rid>` | Eliminated | Metadata comes in the webhook payload. |
| `queue.skip` | `POST /skip` | Skips the currently playing track. |

**New capabilities HTTP enables that telnet cannot practically offer:**

- **Queue inspection with contents.** `GET /queue` can return the full metadata of each queued item in a single response, by calling `request.metadata(rid)` per item inside the handler. With telnet this required N+1 serialized commands.
- **Remove a specific item from the queue.** `DELETE /queue/:id` calls `queue.remove(rid)`. No equivalent standard telnet command exists. This unblocks drift correction — drop a queued track and replace it without pausing the station.
- **Interactive variable control.** LiquidSoap `interactive.float/bool/string` variables can be exposed over HTTP, allowing the API to change crossfade duration, enable/disable sources, or set custom flags at runtime without restarting LiquidSoap.
- **Atomic compound operations.** A "play now" endpoint can push a track and skip in one handler call with no risk of interleaving.
- **Authentication.** Harbor handlers can check a header (API key). Telnet has no auth beyond IP binding.
- **Richer push response.** The push endpoint can return what LiquidSoap resolved about the file (actual duration, etc.) in the same response.

**Benefits over telnet:**

*Stateless.* Each HTTP call is independent. No persistent connection to manage, no reconnect logic, no state that can go out of sync with LiquidSoap's reality. The entire `TelnetClient` class and the boot recovery logic in `index.ts` go away.

*No serialization on the Node side.* Multiple processes (see multiprocess design, to be documented) can independently call `fetch()` against the harbor endpoints without coordinating access to a shared socket. LiquidSoap's own internals handle thread safety; Node doesn't need to know about it.

*Simple error handling.* HTTP calls either succeed or return an error status. Failure is self-contained. No connection state to reset.

Port 8005 is already open in the Dockerfile (used for live `input.harbor`). The new control endpoints share that port — harbor multiplexes by path.

---

### Decision 2 — Use LiquidSoap webhooks for track events

**Status: decided**

LiquidSoap provides callback hooks that fire inside the LS process and can make outbound HTTP calls to our API. This eliminates the polling-based metadata detection entirely.

**Available hooks (all present in LiquidSoap 2.2.5):**

**`source.on_track(handler)`**

Fires the moment LiquidSoap transitions to a new audio item. The handler receives the full metadata list including our `play_history_id` annotation and LiquidSoap's own `on_air_timestamp` (Unix epoch float — the exact moment audio started flowing).

Replaces: the entire `request.on_air` → `request.metadata` polling chain in `metadataWatcher.ts`. Detection latency goes from up to 5 seconds to under 100ms. The `on_air_timestamp` precision is unchanged — LS provides it either way.

What our API does when it receives this webhook:
- Close the previous play_history row (mark ended, compute aborted flag)
- Stamp `started_at` on the new row using the `on_air_timestamp` from the payload

**`on_end(delay=N., handler, source)`**

Fires when the remaining time in the current track drops to N seconds. Handler receives `(remaining_seconds, metadata)`.

This changes the scheduler trigger model. Instead of the scheduler polling queue depth every 5 seconds and pushing when it finds depth=0, LiquidSoap tells us "this track has N seconds left" and we push the next track immediately. The queue never goes empty. Pick decisions are made closer to air time (fresher pacing data, fresher clock state).

What our API does when it receives this webhook:
- Run the picker for the current segment
- Push the resulting track via `POST /push`

The 5-second polling loop becomes a slow safety-net heartbeat rather than the primary trigger.

**`source.on_metadata(handler)`**

Fires on metadata changes including track boundaries and mid-track metadata injection (e.g., live DJ source updating title). Not the primary hook for track tracking — `on_track` is more specific — but useful for surfacing live source metadata without a full track transition.

**Implementation note — thread safety.**

All callbacks fire in LiquidSoap's audio streaming thread. Blocking calls (including HTTP) in that thread cause audio dropouts. All outbound HTTP calls must be wrapped in `thread.run`:

```liquidsoap
queue.on_track(fun (meta) ->
  thread.run(fun () ->
    ignore(http.post("http://host.docker.internal:3000/internal/ls/track-started",
      headers=[("Content-Type", "application/json")],
      data=json.stringify({...meta fields...})))
  )
)
```

The `thread.run` wrapper is non-negotiable.

---

## Architecture shift: polling → event-driven

V1 trigger model:
```
setInterval(5s):
  query LS queue depth
  if low: pick → push

setInterval(5s):
  query LS request.on_air
  if changed: close old row, stamp new row
```

V2 trigger model:
```
on_end fires (N seconds before track ends):
  pick next track
  POST /push to harbor

on_track fires (track starts):
  POST to our API → close prev row, stamp new row

setInterval(30s, safety net):
  GET /queue → if empty and not paused → log warning + push
```

The polling loops shrink from primary triggers to fault-detection heartbeats.

---

### Decision 3 — Build as Level 1 (single process), design for Level 3 (forked processes)

**Status: decided**

The multiprocess architecture will be built first as a proof of concept in a single Node.js process, then migrated to true forked processes. This is the right sequencing because:

- The scheduling logic can be designed, tested, and validated without the overhead of IPC plumbing
- Migration from Level 1 to Level 3 is mechanical if the interfaces are right from the start

**The one rule that makes migration mechanical:**

The difference between Level 1 and Level 3 is the transport between processes, not the logic inside them. Level 1 uses an in-process EventEmitter as the bus. Level 3 replaces the bus with `process.send` / IPC routing. If every process module communicates exclusively through the bus — never importing or calling other process modules directly — then migration is replacing the bus implementation, not rewriting the processes.

**What must be true from day one:**

- Each process owns its own in-memory state. No shared mutable objects between processes.
- All cross-process communication goes through the bus, even in Level 1 where it's just an EventEmitter.
- Message types are defined explicitly as TypeScript types with a `type` discriminant. These same types become the IPC message schema in Level 3.
- The only shared persistent state is SQLite, which is accessible from any process in both levels.

**The bus abstraction:**

```typescript
// Level 1: bus is an EventEmitter wrapper
// Level 3: bus is replaced by an IPC router — process modules unchanged

export const bus = {
  emit<T extends BusMessage>(msg: T): void,
  on<T extends BusMessage>(type: T['type'], handler: (msg: T) => void): void,
}
```

Every process module imports `bus` and communicates only through it. When migrating to Level 3, `bus.ts` is the only file that changes.

**What NOT to do:**

- Don't let processes import each other directly (e.g. `CampaignProcess.push(track)` called from `ContentScheduler`)
- Don't put cross-process state in a shared in-memory object
- Don't use callbacks or closures that cross process boundaries

---

### Decision 4 — PM2 as process manager

**Status: decided**

PM2 is the Node.js standard process manager. It handles starting, stopping, restarting on crash, and log aggregation for all processes. Processes are declared in `ecosystem.config.js`. No custom restart logic needed in application code.

PM2 works both standalone (development, Linux production) and inside Docker. It replaces what would otherwise be manual `child_process.fork()` lifecycle management.

### Decision 5 — IPC upgrade path: parent routing → Unix socket → Redis

**Status: decided**

The message bus between processes will be implemented in stages, each a drop-in replacement for the previous:

1. **Parent routing** (Level 1 / early Level 3): Parent process receives all messages and forwards to the correct child. Built into Node.js `child_process.fork()` IPC — no dependencies. Sufficient for low message volume (one pick every few minutes).

2. **Unix domain socket** (mid Level 3): When sibling-to-sibling communication is needed without routing through the parent, each process exposes a local socket. Faster than TCP, no network stack.

3. **Redis pub/sub** (full Level 3): Fully decoupled. Processes publish to named channels; subscribers receive without knowing who sent. Also handles shared ephemeral state (see Decision 6), so adding Redis upgrades both the bus and the state store in one step.

### Decision 6 — Shared state upgrade path: SQLite → Redis

**Status: decided**

Persistent state (play history, campaign counts, pacing) lives in SQLite throughout. Multiple processes can read simultaneously; writes serialize at the SQLite level, which is acceptable given write frequency.

Ephemeral state (current play_history_id, queue depth, live pacing ratios in memory) starts in the parent process and is passed to children via IPC messages on request. When Redis is added (Decision 5, stage 3), ephemeral state moves there — Redis serves as both bus and fast shared store in one dependency.

### Decision 7 — Segment-ahead planning with a two-pass model

**Status: decided**

The scheduler plans content one segment ahead, not one track at a time. A plan is an ordered sequence of tracks whose durations sum to (approximately) the segment's target duration. A correctly executed plan plays drift-free. Drift is introduced exclusively by deviations from the plan — operator actions or real-world playback differences — not by the algorithm itself.

**Planning horizon: one segment**

Planning one full clock (an hour) ahead is appealing but creates hard problems: pacing state used at planning time is stale by the time late picks air, and any operator schedule change invalidates a large plan. One segment is the natural unit — it has a known duration, type, and source constraints, and is a clean replan boundary.

**Two-pass model:**

Planning happens in two passes per segment:

- **Pass 1 — Draft plan**: built at the moment the current segment starts playing. Produces the full structural shape of the next segment — track sequence, interstitial positions, jingle cadences, gap-filling. This is what operators see in the UI immediately. They can inspect and modify it. Uses current pacing state, accepted as an approximation.

- **Pass 2 — Finalization**: built 30–60 seconds before the next segment starts. Walks the draft plan and validates each item against fresh pacing state. Items that are no longer valid (campaign hit its daily cap, artist separation violated by what actually played) are substituted. For most picks nothing changes. Picks up any operator schedule changes that happened during the current segment.

```
10:00  Segment N starts playing
10:00  Draft plan for segment N+1 built → visible to operator in UI
10:44  Finalization pass → fresh pacing, validate + substitute where needed
10:45  Segment N+1 starts → queue feeder executes finalized plan
```

### Decision 8 — Gap filling belongs to the planner; the drift monitor owns only runtime deviations

**Status: decided**

After assembling a track sequence, the planner computes the residual: `segment_duration − sum(planned_track_durations)`. This gap is known at plan time and the planner is responsible for handling it — it is not drift.

**Planner gap-filling rules:**

- If residual > configurable minimum (default: 5 seconds): the planner attempts to fill with short content — a filler jingle, station ID, or short promo from the segment's filler pool.
- If residual ≤ minimum: no filler fits cleanly. The plan ends, and the segment finishes slightly early. This is declared explicitly in the plan (not treated as drift).
- Hard-end segments (`start_policy.type = 'hard'`): the planner must stay **under** the boundary. Overrun is not acceptable. It is better to leave a 10-second gap and play a filler than to pick a track that risks overrunning a hard start. Soft-end segments are more forgiving.
- Hard-end segments — boundary behavior by content type: the generic rule is **only music is acceptable to cut at a hard boundary**. Everything else — spots, jingles, station IDs, voice tracks, promos, fillers — should be dropped rather than cut mid-play. The priority order when approaching a hard boundary with non-music content:
  1. **Drop the item** if it cannot complete before the boundary. Do not start it. This creates a gap.
  2. **Accept the gap if ≤ 5 seconds.** Short gaps are not fillable and silence of this duration is tolerable.
  3. **Handover early** if the gap is > 5 seconds and the next segment allows it (soft start policy). Starting the next segment a few seconds early is preferable to silence or a forced fill.
  4. **Attempt a shorter fill** only if the gap is > 5 seconds and early handover is not available.
  5. **Music only** may be faded or cut at the boundary as a last resort — it is the least damaging content type to interrupt.

  This rule applies both at plan time (planner avoids placing non-music items where they cannot complete) and at runtime (deviation monitor applies the same priority when replanning near a hard boundary). If a hard cut lands mid-item anyway due to unrecoverable drift, the deviation monitor sends `DROP_COMMITTED` to the relevant content processes so pacing credit is reversed.

**Running-early into a fixed successor — gap must be filled by the current segment:**

When a segment is running ahead of schedule (finishing before its planned end) and its immediate successor has `start_policy.early_seconds === 0` (fixed start, no early handover permitted), there is no escape valve: the gap between when the current segment ends and when the successor is allowed to start is guaranteed dead air unless the *current* segment fills it.

This is distinct from the standard planner residual (which is known at plan time) — it emerges at runtime when actual track durations come in shorter than estimated, or after a deviation event pushes the segment ahead.

The planner must look ahead at the successor's `start_policy` when building the current segment's plan:

- If successor allows early start (`early_seconds > 0` or `null`): a small gap is acceptable — the planner can let the successor absorb it.
- If successor is fixed (`early_seconds === 0`): the planner must be conservative and fill aggressively. The current segment is the last line of defence against silence before the fixed boundary. At plan time, this means biasing track selection toward shorter items that allow late-stage filler insertion, and reserving filler pool budget for near-boundary use.

At runtime, the deviation monitor must apply the same logic: if the current segment is running early *and* the successor is fixed, trigger a replan immediately rather than coasting. The replan adds filler from `coasting_order` to absorb the gap. The priority order mirrors Decision 8 — filler jingles, station IDs, short promos — and the same minimum-gap threshold (default 5 seconds) applies before attempting to fill.

The `coasting_order` field on the segment encodes exactly which content types are available for this purpose, so no new configuration is needed — this is purely a planning and deviation-monitor decision that depends on the successor's `start_policy`.

**Drift monitor scope:**

The drift monitor only handles deviations that happen at runtime — events that cause reality to diverge from the finalized plan:

- Skip: a track is cut short → segment runs short
- Manual inject: operator adds a track not in the plan → segment runs long
- Live takeover: segment is suspended while the DJ is on
- Hold: operator freezes the segment; wall clock advances without music
- Crossfade bleed: effective track duration differs slightly from file duration

When the deviation monitor detects a divergence, it signals the planner to replan the remaining portion of the current segment.

### Decision 9 — Three core processes emerge from the planning model

**Status: decided**

The planning model naturally separates into three distinct responsibilities, each a candidate process in the multiprocess architecture:

**Planner**
- Runs at segment start (draft) and ~30–60s before segment boundary (finalization)
- Inputs: current clock resolution, pacing state from DB, play history
- Output: an ordered plan — a sequence of `{media_id, duration, reason, position}` records
- Handles gap filling, filler selection, interstitial cadence
- On deviation signal: replans remaining segment from current position

**Queue feeder**
- Executes the finalized plan
- Triggered by the `on_end` webhook from LiquidSoap (N seconds before current track ends)
- Takes the next item from the plan, pushes it to LiquidSoap via `POST /push` (harbor HTTP)
- No decision logic — it reads the plan and executes it
- Falls back to a safety pick if the plan is exhausted or unavailable

**Deviation monitor**
- Listens to `on_track` webhook events from LiquidSoap
- Compares each transition against the active plan
- Detects: wrong track played, track played shorter than expected (skip/abort), unexpected track (manual inject)
- On deviation: signals the planner with deviation type + magnitude
- Also handles live takeover detection (was: `live.status` polling; now: `on_track` or a dedicated live webhook)

### Decision 10 — Process topology

**Status: decided (initial map)**

Two categories of processes: content processes and orchestration processes.

**Content processes** are candidate suppliers. They do not make placement decisions — they return pools of candidates with enough metadata for the planner to decide. They update their own state (rotation position, pacing counts) only when the planner confirms what was committed to the plan. They must not update state when providing candidates, only on confirmation.

| Process | Owns | Returns to planner |
|---|---|---|
| **Music** | Rotation state, hot-play streak, heavy rotation pacing | N rotation candidates, M hot-play candidates, K heavy rotation candidates, jingles, station IDs |
| **Campaign** | Spot campaign pacing (plays today/week/month, position-1 eligibility) | Eligible spot candidates marked as contract-bound, with pacing metadata |
| **Promo** | Promo pacing (plays today vs. min/max) | Eligible promo candidates |
| **Voice track** | Voice track pool and rotation | Candidates for voice-track segments |
| **Branding** | Jingle pool, station ID pool, clip/show envelopes | Short content for interstitials and envelope positions |

**No separate campaign tracker or promo tracker processes.** Pacing state is owned by the campaign and promo content processes respectively. The tracker concept is just the state management side of those processes — splitting it out would duplicate state or create unnecessary indirection. If pacing needs to be queried by other processes independently, those processes request it from the content process via bus message.

**Orchestration processes:**

**Planner**
- Plans one segment ahead (draft + finalization, see Decision 7)
- Works even when LiquidSoap is stopped — can build and validate plans offline
- On each planning pass: resolves segment type → sends content requests to relevant content processes → receives candidate pools → assembles sequence satisfying length, branding requirements, mandatory tracks → returns unused candidates to each content process for state update
- Handles gap filling (Decision 8)
- On replan signal from deviation monitor: notifies content processes of dropped items (so they are not marked as played), requests fresh candidates if needed, rebuilds remaining sequence

**Queue feeder**
- Executes the finalized plan, one item at a time
- Triggered by the `on_end` LiquidSoap webhook (default: 5 seconds before current track ends — sufficient; the HTTP push completes in <5ms on the local Docker network)
- Reads the next item from the active plan, calls `POST /push` on LiquidSoap harbor
- No decision logic — executes the plan as given
- Safety fallback: if the plan is exhausted or unavailable, picks a random music track to prevent silence

**Deviation monitor**
- Listens to `on_track` webhook events from LiquidSoap
- Compares each transition against the active plan: wrong track, track shorter than expected (skip/abort), unexpected track (manual inject), live takeover
- Computes deviation magnitude and classifies it
- Decides correction target using the following logic:

```
drift detected in current segment
  → is next segment hard-start?
      yes  → no correction attempt on current segment
              signal planner: adjust next segment plan to absorb drift
      no   → signal planner: replan remaining current segment
              if residual remains after correction: also adjust next segment plan
```

- The deviation monitor detects and measures. The planner corrects. The deviation monitor does not contain planning logic.

### Decision 11 — Planner ↔ content process interaction protocol

**Status: decided**

The interaction between the planner and each content process follows a request/confirm/return cycle:

```
1. Planner → content process:  REQUEST_CANDIDATES
     {segment_type, duration_needed, constraints}

2. Content process → planner:  CANDIDATES
     {mandatory: [...], optional: [...]}
     (state NOT updated yet)

3. Planner assembles the plan using a subset of candidates

4. Planner → content process:  CONFIRM_USED
     {used: [id, id, ...]}
     (content process updates rotation, pacing, etc. for used items only)

5. Planner → content process:  RETURN_UNUSED
     {unused: [id, id, ...]}
     (content process notes these items were not selected — no state change needed,
      but useful for rotation fairness tracking if wanted)
```

On replan (deviation correction):

```
6. Planner → content process:  DROP_COMMITTED
     {dropped: [id, id, ...]}
     (content process reverses the state update for these items — they were
      previously confirmed but are now being removed from the queue)

7. Planner → content process:  REQUEST_CANDIDATES (repeat from step 1)
```

---

### Decision 12 — Plan data structure: write to SQLite

**Status: decided**

Plans and plan items are written to SQLite, not kept only in-memory. The benefits outweigh the cost:

- **Multi-process access**: queue feeder, deviation monitor, and UI API all need to read the active plan. SQLite gives them direct access without IPC round-trips through the planner.
- **Crash recovery**: if the planner process crashes mid-segment, it restarts and resumes from the persisted plan. The queue feeder can continue executing the finalized plan even while the planner is restarting.
- **Operator modifications**: operator edits the draft plan in the UI → UI API writes to SQLite → planner reads the updated plan at finalization. The DB is the handoff point; no IPC needed.
- **Audit trail**: planned vs. actual is queryable. The `plan_item_id` → `play_history` link gives the full picture.

Write cost is negligible: ~15–30 rows per segment, written once at draft time and once at finalization. Queue feeder reads one row and writes one status update per track.

**Schema additions needed:**

```
plans
  id
  segment_id          FK → clock_segments
  clock_instance_started_at   identifies which instance of the segment
  status              draft | finalized | active | completed
  created_at
  finalized_at

plan_items
  id
  plan_id             FK → plans
  position            sort order within plan
  media_id            FK → media
  content_type        music | campaign | promo | jingle | station_id |
                      filler | voice_track | branding
  campaign_id         FK → campaigns (null unless spot)
  music_campaign_id   FK → music_campaigns (null unless heavy rotation)
  planned_duration_seconds   uses media.cue_out - media.cue_in when set,
                             else media.duration_seconds
  mandatory           bool — contract-bound (campaign or music campaign)
  status              pending | playing | played | dropped | skipped
  play_history_id     FK → play_history (set when actually played)
```

**`play_history` addition:**

```
play_history.plan_item_id   FK → plan_items (nullable — manual/live plays have none)
```

### Decision 13 — Schema reuse and cleanup assessment

**Status: assessed — no cleanup before implementation**

The existing schema is in good shape. Everything carries forward:

**Carry forward unchanged** (content and schedule structure):
`media`, `playlists`, `playlist_media`, `rotations`, `show_playlists`, `campaigns`, `campaign_media`, `music_campaigns`, `promos`, `promo_media`, `clocks`, `clock_segments`, `shows`, `template_entries`, `template_clock_entries`, `calendar_entries`, `broadcastIntervals`, `broadcastIntervalSlots`

**Carry forward with one addition**: `play_history` — add `plan_item_id` FK.

**Dead columns — leave as inert schema drift** (cannot drop via libsql without full table recreation; not worth the migration risk):
- `clocks.sweep_config` — superseded by `clock_segments.sweeper_config`
- `clock_segments.trailing_time`, `clock_segments.recovery_tactics` — superseded by `can_skip / can_fill / can_reschedule / catching_up_order / coasting_order`
- `clock_segments.accept_sweepers` — superseded by `sweeper_config`
- `shows.type`, `shows.active` — removed from application in May 2026, remain in DB with inert defaults

**Three columns now actionable in V2 that V1 never used:**
- `clock_segments.catching_up_order` / `coasting_order`: directly map onto the deviation monitor → planner replan signal. V2 will implement them.
- `media.cue_in_seconds` / `cue_out_seconds`: planner must use effective duration (`cue_out − cue_in` when set) for segment fill calculations, not raw file duration. V1 ignored these.

**New tables to add via migration**: `plans`, `plan_items`.

---

### Decision 14 — Stop-set space calculation and constraints

**Status: decided**

**Two distinct problems:**

*Eligibility* — binary per-campaign filters that determine which campaigns are candidates for a given break at all: date range, active flag, time window, days of week, show targeting, interval targeting, daily cap, spot pool non-empty with at least one spot fitting remaining time.

*Space allocation* — relational constraints that determine which eligible campaigns can coexist in the same break and in what positions.

**Placement constraints:**

- **First-in-slot** (`always` | `at_least_one` | `at_least_one_shared`): governs whether a campaign requires or prefers slot 1. Competition between multiple slot_1_required campaigns is resolved by the planner, not the campaign process. The campaign process returns all eligible first-in-slot candidates with their constraint type; the planner assigns slot 1 by pacing score and excludes the rest from the break.
- **Competing exclusions**: bidirectional — once campaign A is placed, its `competing_exclusions` set is removed from consideration for the remainder of the break. The campaign process includes each candidate's exclusion set in the metadata it returns; the planner applies them during slot-filling.
- **Advertiser separation** (`advertiser_separation_spots`): minimum spots between two spots from the same customer. Enforced by the planner during slot-filling using the `customer_id` on each candidate.

**Space estimate — computed by the campaign process, exposed to UI:**

The campaign process computes a break space summary alongside the candidate pool, since it already has all pacing data loaded:

```
break_duration_seconds      total available time in the break
hard_claimed_seconds        minimum time for overdue hard-priority campaigns
contested_seconds           expected time for best-effort campaigns at normal pacing
free_seconds                likely available for promos and fillers
occupation_ratio            (hard_claimed + contested) / break_duration
oversubscribed              occupation_ratio > 0.90
```

The estimate is acknowledged as approximate — spot duration varies, competing exclusions create winner-take-all situations, and first-in-slot competition is resolved at fill time. Its value is directional: is this break over-demanded or under-demanded?

**90% occupation cap as a UI-exposed inventory feature:**

`occupation_ratio > 0.90` is flagged as oversubscribed. The campaign process does not refuse to return candidates — it returns them with `oversubscribed: true` so both the planner and the UI know the break is over-sold. The UI surfaces this as an inventory warning, giving sales teams visibility before the break airs. Target: keep projected occupation ≤ 90% as a safe margin.

The space estimate is written to SQLite (on the `plans` or a separate `stop_set_estimates` table — to be decided at implementation) so the UI can query it without going through the campaign process.

**Interval capacity calculation (longer-horizon, separate from per-break):**

Answers the weekly question: across all stop-sets in a broadcast interval, how many total seconds of ad time exist vs. how many seconds interval-targeted campaigns need? Used for inventory planning and over-sell detection before individual breaks are filled. This is a background computation over the schedule template, not part of the real-time planning path.

**What the campaign process returns to the planner:**

```typescript
interface CampaignCandidate {
  campaign_id: number
  customer_id: number           // advertiser separation
  name: string
  priority: 'hard' | 'best_effort'
  pacing_score: number          // urgency — how far behind target
  position_constraint: 'any' | 'slot_1_required' | 'slot_1_preferred'
  competing_exclusions: number[] // campaign_ids excluded if this one placed
  spot_pool: SpotCandidate[]    // spots fitting remaining break time
  mandatory: boolean            // hard priority + significantly behind pacing
}

interface StopSetCandidateResponse {
  candidates: CampaignCandidate[]
  promos: PromoCandidate[]
  space_estimate: BreakSpaceEstimate
}
```

---

## Open questions / still to design

*(none — all resolved by Decisions 15–28 below)*

---

### Decision 15 — Updated process topology

**Status: decided**

Two categories of processes. Content processes are candidate suppliers. Orchestration processes drive the sequence.

#### Content processes

| Process | Owns | What it returns |
|---|---|---|
| **Music** | Rotation state, hot-play streak, heavy rotation pacing, music campaign pacing | N rotation candidates, M hot-play candidates, K heavy-rotation/music-campaign candidates — combined pool. Music campaign state is internal to this process. |
| **Campaign** | Spot pacing (global, per-show, per-interval), promo pacing, position-1 eligibility, slot-1-satisfied-today | `StopSetCandidateResponse` — eligible spots + promos + space estimate. Promo state is internal to this process. |
| **Branding** | Jingle pool, station ID pool, segment envelopes, show envelopes | Short content for interstitial positions and segment/show start-end. No branding rotations in V2; round-robin and random only. |
| **Rundown** | Calendar-assigned rundown content (news, bulletin) | Ordered list of assigned clips with total duration estimate; gap = segment_duration − total_duration, to be filled by planner using normal music/branding. |

**No separate processes for:**
- Music Campaign — internal to Music process (same segment type, same pool, same injection logic as hot-play/heavy-rotation)
- Promo — internal to Campaign process (same segment type, included in StopSetCandidateResponse)
- Tracking (recorded shows) — deferred to backlog
- Live — no content process; live is a Supervisor state event (see Decision 17)
- Beds — deferred to backlog (requires secondary LS audio layer)
- Voice Track — deferred to backlog

#### Orchestration processes

| Process | Owns |
|---|---|
| **Supervisor** | Outer event loop, drift accumulation, correction decisions, drives Planner and Queue Feeder, receives all LS webhooks |
| **Planner** | Segment plan assembly, gap filling, finalization substitutions, replan on correction signal |
| **Queue Feeder** | Executes finalized plan one item at a time, triggered by `on_end` webhook |

**Not separate processes (deferred/merged):**
- Sweeps Planner — backlog
- Overlay Content Feeder (for beds) — backlog
- Logging — not a process; structured pino logging inside every process
- Budget Compute — existing `spotBudget.ts` service called on-demand by API; no supervisor involvement

---

### Decision 16 — Subprocess embedding: music campaigns inside Music, promos inside Campaign

**Status: decided**

**Music campaigns** (heavy rotation, contractual plays-per-day) are embedded in the Music process rather than running as a separate process. Reasons:
- Music campaigns fill music segments — the same pool and segment type as rotation music and hot-play
- The Music process already owns all the injection-pattern logic (hot-play streak, heavy rotation pacing check)
- Returning a combined music pool from one process avoids any need for two processes to negotiate over the same segment time budget
- Internal pacing state for music campaigns lives inside the Music process and is updated via the same CONFIRM_USED / RETURN_UNUSED cycle

**Promos** are embedded in the Campaign process for the same reasons:
- Promos fill stop-set segments alongside spot campaigns
- The Campaign process already computes break space and return `StopSetCandidateResponse`
- Promo pacing (min/max target, not contract-bound) is simpler than spot pacing; it does not warrant separate process overhead
- Decision 14 already includes `promos: PromoCandidate[]` in the response struct

---

### Decision 17 — Supervisor as central hub; Deviation Monitor is a module inside it

**Status: decided**

The Supervisor is the central process around which all orchestration is built. Every LS webhook reaches the API endpoint layer, which relays it to the Supervisor. The Supervisor drives all other orchestration:

```
LS webhooks
    ↓
API /internal/ls/* endpoints
    ↓
Supervisor
  ├── drives Planner (request draft, request finalization, request replan)
  ├── drives Queue Feeder (plan ready signal, skip signal)
  ├── queries LS harbor (GET /queue, POST /skip for correction)
  └── accumulates drift, makes correction decisions
```

Content processes do not communicate with each other. They respond to requests from the Planner only. The Planner is a module driven by the Supervisor, not an independently-scheduled process at Level 1. At Level 3, Planner becomes a forked process that still communicates only via the bus (Supervisor as initiator).

The previous "Deviation Monitor" design (Decision 9, 10) is folded into the Supervisor. Logically it remains a distinct module (`deviationMonitor.ts`), but it lives in the Supervisor process and communicates with the Planner through the Supervisor, not independently.

**Supervisor responsibilities:**

1. **Event loop** — receive `on_track` and `on_end` webhooks; dispatch to internal modules
2. **Drift accounting** — maintain running `drift_seconds` (positive = behind, negative = ahead); update on each `on_track` event using `planned_start_at` vs. `actual_started_at`
3. **Correction decision** — after each `on_track`, evaluate whether drift warrants action using the next segment's `start_policy` and the correction thresholds (see Decision 20)
4. **Segment planning drive** — on each new segment start: request draft plan from Planner; 30–60s before next boundary: request finalization
5. **Replan drive** — when deviation exceeds threshold: signal Planner with `{correction_type, magnitude_seconds, remaining_plan_items}`
6. **Safety net** — 30s heartbeat: `GET /queue` from LS; if queue empty and not in live-takeover → log warning, emergency push
7. **Live takeover handling** — when live input webhook fires: suspend queue feeding, record takeover start time; when live ends: replan remaining segment from current position

---

### Decision 18 — Rundown process design and gap filling

**Status: decided**

The Rundown process handles news and bulletin segments. Content for these segments is pre-assigned to specific calendar instances by an operator (the rundown editor feature). At planning time, the Rundown process:

1. Queries the calendar instance for the upcoming news/bulletin segment
2. Returns the ordered list of assigned clips with their estimated total duration
3. Includes a `gap_estimate_seconds = segment_target_duration − estimated_content_duration`

The Planner receives this pool and:
1. Places the rundown items first (they are mandatory, not subject to reorder)
2. Fills the residual gap using the segment's normal `coasting_order` (typically music track, then short filler)
3. The gap fill follows the same rules as any other segment gap fill (Decision 8)

The Rundown process never fills its own gap — it has no access to the music or branding pools.

**Boundary behavior:** Rundown content is `mandatory = true` and `not_subject_to_skip = true`. If the rundown content runs over the segment boundary (operator assigned too much), the Planner drops the last item(s) and reports a `RUNDOWN_OVERFLOW` event to the Supervisor.

**Gap fill content for rundown segments** is the same pool the segment's clock would normally supply: a music track from the associated show/rotation, or a station ID if the gap is short (<60s), or a jingle. The specific priority is encoded in the segment's `coasting_order`.

---

### Decision 19 — Live handling: Supervisor state event, not a content process

**Status: decided**

Live is not automated content. There is no "live content process" because there is no content to supply — the audio comes from the live harbor input, not from the file system or a playlist.

**What we need:**

- LS fires a webhook when the live harbor input becomes active (stream connected) and when it disconnects
- The Supervisor receives this webhook, sets `state = LIVE_TAKEOVER`, and suspends normal queue feeding
- When live ends, the Supervisor evaluates remaining segment time:
  - If residual > threshold: request replan for remaining segment
  - If residual < threshold: let the segment end and plan the next one normally
- The Supervisor records live-takeover start and end times in a new `live_events` table for logging and reporting

**Beds (background audio for live segments):** Deferred. Beds require a secondary audio layer in LiquidSoap (a background mixer track separate from the main queue). Designing the overlay content feeder and the LS script changes for bed mixing is a standalone feature that should land when live/news segments are being built. Until then, beds are backlog. The LS script must reserve a mixer input for bed audio — plan for it in the LS topology even if the control side is not built yet.

---

### Decision 20 — Drift correction framework

**Status: decided**

Drift is measured as `drift_seconds = actual_position − planned_position` at each `on_track` event. Positive = behind plan (segment running long). Negative = ahead of plan (segment running short).

**Drift sources:**
- **Organic** — accumulated from planner rounding (intentional; plan fills segment approximately). Predictable, small.
- **Operator** — skip, inject, extend show, cut-short show. Can be substantial and sudden.

**Correction framework — next segment start_policy drives the decision:**

```
drift detected
  → is next segment start_policy = 'hard'?
      yes → correction required in current segment
              or absorbed via shorter next segment plan
      no  → soft tolerance window applies; no action until |drift| > tolerance
```

**Correction actions by drift direction:**

| Direction | Magnitude | Next segment | Action |
|---|---|---|---|
| Behind (long) | < soft tolerance | Any | No action; absorb via next segment |
| Behind (long) | > soft tolerance | Soft start | No action; planner gets shortened next segment duration |
| Behind (long) | > hard threshold | Hard start | Skip from `catching_up_order` (music first; spots last); if insufficient, cut at boundary |
| Ahead (short) | < 5s | Any | Accept silence; no action |
| Ahead (short) | 5–30s | Soft start | Fire next segment early (early_seconds allows it) |
| Ahead (short) | 5–30s | Fixed start (early_seconds=0) | Inject filler from `coasting_order` (station ID, jingle, short promo) |
| Ahead (short) | > 30s | Any | Replan remaining segment; request additional track from Music process |

**Default plan-time bias: slight overfill.** When two tracks are equally valid for a slot and the segment has a soft-end successor, prefer the longer one. Being 5s long costs nothing with a soft-start successor. Being 5s short risks an audible gap before a fixed-start successor.

**catching_up_order semantics** (field on `clock_segments`):
- Values: ordered list of content types to skip when running behind
- Example: `['music', 'promo', 'filler']` — skip music first, then promos, then fillers; never skip campaign spots (mandatory = true)
- The Supervisor iterates this list, signals Queue Feeder to drop the next pending item of that type, and re-evaluates drift after each drop

**coasting_order semantics** (field on `clock_segments`):
- Values: ordered list of content types to inject when running ahead
- Example: `['station_id', 'jingle', 'music']` — try a station ID first; if gap too large, try a jingle; if still too large, add a short music track
- The Supervisor signals Planner to request a short item from the Branding or Music process and inserts it into the remaining plan

**Gap vs fire early — preference:**
- Prefer filling (coasting_order) over firing early when a suitable filler exists (< 60s gap)
- Prefer firing early over filling when the gap exceeds 60s — forcing a long filler sequence sounds worse than an early start
- Only possible when the next segment allows early handover (`start_policy.early_seconds > 0`)

**Skip vs fire late — preference:**
- Prefer firing late over skipping when next segment has soft start (absorb without action)
- Prefer skip over cut when content is music (music can be faded; spots cannot be cut mid-read)
- Avoid skipping contract-bound spots; mark as `mandatory` in plan_items and never include them in catching_up_order

---

### Decision 21 — Queue depth = 1; Queue Feeder as cut-short agent

**Status: decided**

The LiquidSoap queue is maintained at depth 1. Rationale: items already in the queue cannot be corrected without dropping them. With depth 1, the queue always holds exactly the next item to play, and everything further ahead remains in the plan where the Supervisor can still modify it.

**Queue Feeder trigger:** `on_end` fires N seconds before the current track ends. Queue Feeder reads the next `pending` item from the active plan and pushes it via `POST /push`. N should be large enough for the HTTP round-trip (5 seconds is sufficient for local Docker; configure as `queue_advance_seconds` in supervisor config).

**Cut-short mechanism:** Implemented by the Supervisor via `POST /skip` to LS harbor. The Queue Feeder does not decide to skip — that is a Supervisor correction decision. The Queue Feeder only executes pushes on trigger. The sequence for a cut-short:
1. Supervisor decides a skip is needed (catching_up_order)
2. Supervisor calls `POST /skip` on harbor → LS aborts current track
3. LS fires `on_track` for the previously-queued next item
4. LS fires `on_end` N seconds before that item ends → Queue Feeder pushes the item after it

The queue feeder has a safety fallback: if the plan is exhausted or unavailable when `on_end` fires, push a random music track from the current clock's primary rotation to prevent silence. Log this as `EMERGENCY_FILL`.

---

### Decision 22 — Campaign placement constraints enforced by Planner

**Status: decided**

The Campaign process returns candidates with metadata. The Planner enforces all placement constraints during stop-set assembly. The Campaign process does not know what other campaigns are being placed in the same break.

**Constraints the Planner enforces:**
1. **Advertiser separation** — minimum N spots between two spots from the same `customer_id` in the same break
2. **Campaign separation** — same `campaign_id` must not be adjacent in the same break; minimum 1 spot between if the same campaign appears twice (allowed)
3. **Competing exclusions** — if campaign A is placed, remove all campaigns in A's `competing_exclusions` set from remaining candidates
4. **First-in-slot** — among `slot_1_required` candidates, the Planner picks the winner by highest `pacing_score`; others drop to position 2+
5. **Slot-1 per-day relaxation** — if a `slot_1_required` campaign has `slot_1_satisfied_today = true` and priority is `best_effort`, the Planner may place it in any position; if priority is `hard` and pacing is behind, still try slot 1

**What the Campaign process adds:**
- `slot_1_satisfied_today: bool` — did this campaign already get slot 1 in an earlier break today?
- Campaign process tracks slot-1 delivery per day and updates this flag on CONFIRM_USED

**Multiple pacing levels:** Campaign process maintains pacing for each campaign at three granularities: global (all-time during campaign dates), per-show (plays in each show instance), and per-interval (plays in each broadcast interval). Eligibility check uses all three. The `pacing_score` returned for each candidate reflects the most-behind level.

---

### Decision 23 — Staging changes without shadow tables

**Status: decided**

No shadow tables. The DB is always the source of truth. Changes applied at any time take effect at the next planning pass.

**Why this works:**
- Segment N is already running its finalized plan when a change lands — we let it finish; no table required to buffer the change
- Segment N+1's draft plan is built at the start of segment N. If the change arrives after the draft is built, the finalization pass (30–60s before the boundary) re-reads the DB and picks up the change via substitution
- Segment N+2 and beyond are planned from scratch using the current DB state — no staging needed

**One constraint:** changes that affect the broadcast template (clock structure, segment boundaries) should be applied between segment boundaries, not mid-segment. The UI may show a banner: "Changes will take effect at the next segment boundary." This is a UX note, not a data model restriction.

**Operator plan modifications** (direct plan_items edits in the operator console): written to SQLite. Planner reads plan_items at finalization time and treats any operator-modified items as pre-confirmed (skips REQUEST_CANDIDATES for those positions). Queue Feeder reads plan_items in order — no special handling.

---

### Decision 24 — Logging structure

**Status: decided**

Logging is not a separate process. Every process logs via pino (already configured in Fastify). All scheduling-relevant log entries use structured JSON with a mandatory set of fields:

```typescript
interface SchedulingLogEntry {
  timestamp: string         // ISO 8601
  process: string           // 'supervisor' | 'planner' | 'music' | 'campaign' | 'branding' | 'rundown' | 'queueFeeder'
  event: string             // see event catalog below
  plan_id?: number
  plan_item_id?: number
  segment_id?: number
  media_id?: number
  campaign_id?: number
  music_campaign_id?: number
  drift_seconds?: number
  reason?: string           // free-form reasoning string — required for all planning decisions
  [key: string]: unknown    // process-specific extras
}
```

**Event catalog (partial):**
- Supervisor: `SEGMENT_START`, `SEGMENT_END`, `DRIFT_UPDATE`, `CORRECTION_SKIP`, `CORRECTION_FILL`, `CORRECTION_REPLAN`, `LIVE_TAKEOVER_START`, `LIVE_TAKEOVER_END`, `EMERGENCY_FILL`
- Planner: `PLAN_DRAFT_START`, `PLAN_DRAFT_COMPLETE`, `PLAN_FINALIZE_START`, `PLAN_FINALIZE_COMPLETE`, `PLAN_ITEM_PLACED`, `PLAN_ITEM_SUBSTITUTED`, `PLAN_ITEM_DROPPED`, `PLAN_REPLAN`
- Content processes: `CANDIDATES_REQUESTED`, `CANDIDATES_RETURNED`, `CONFIRM_USED`, `RETURN_UNUSED`, `DROP_COMMITTED`
- Queue Feeder: `PUSH_SENT`, `PUSH_ERROR`, `EMERGENCY_FILL`

The `reason` field on `PLAN_ITEM_PLACED` is the primary tool for analyzing scheduling decisions:
```
"heavy_rotation campaign='Pop Hits Q3' (plays 2/8 today, behind); LRP pick track_id=442"
"campaign='Acme Radio' pacing_score=0.72 (behind hard); slot_1 — competing_exclusions cleared [campId=8]"
"coasting fill: gap=18s, coasting_order=['station_id','jingle'] → station_id sid=12"
```

Logs are queryable from the UI (see Decision 25). No separate logging process needed.

---

### Decision 25 — UI visibility into supervisor state

**Status: decided (scope)**

The operator must be able to see what the supervisor is doing without reading log files. Minimum viable supervisor visibility panel:

**Active segment panel:**
- Current segment name, type, scheduled end time
- Running drift (`+Ns behind` / `−Ns ahead`) updated in real-time
- Next correction action if drift > threshold

**Active plan list:**
- Ordered list of plan_items for the current and next segment (pending / playing / played / dropped)
- Each item shows: content type, media title, planned duration, status, reason
- Operator can mark an item for skip (sets `status = operator_skip_requested`; Supervisor acts on it at the next safe moment)

**Campaign pacing dashboard:**
- Per campaign: target plays today/week, actual plays, pacing score, projected end-of-day
- Oversubscribed break indicator (occupation_ratio > 0.90)

**Process health panel:**
- Each supervisor process: last heartbeat, status (`running` / `error` / `stopped`)
- LS connection status (last successful harbor response)

**Supervisor log feed:**
- Last N structured log entries (filterable by event type and process)
- This is the primary tool for diagnosing scheduling gaps and reasoning

All of these read from SQLite (`plans`, `plan_items`, `play_history`, campaign pacing) and from a new `supervisor_state` table (a single-row ephemeral state table: current_segment_id, current_drift_seconds, last_heartbeat_at, active_plan_id).

---

### Decision 26 — Dry run / simulation

**Status: decided (scope)**

A dry run executes the Planner's planning logic over a future time window without producing actual LiquidSoap commands. It:

1. Accepts `{start_at, end_at}` as input
2. Iterates through each segment in the clock schedule for that window
3. For each segment: runs the full planning algorithm (REQUEST_CANDIDATES → assemble → gap fill) using current pacing state
4. Updates simulated pacing state between segments (so later segments see the projected plays from earlier ones)
5. Records each simulated `plan` and `plan_item` to a separate set of tables (`sim_plans`, `sim_plan_items`) tagged with a `simulation_id`

**Output:** a timeline of simulated segment plans. Each plan shows the same per-item `reason` field used in live planning. Campaign pacing projections (projected plays by end of dry-run period) are derived from the simulation.

**UI:** calendar/timeline view with per-segment click-through to the simulated plan items. Oversubscribed breaks and pacing shortfalls highlighted.

**Dry run does not require LiquidSoap to be running.** The Planner already works offline (Decision 9). The only difference is: instead of waiting for segment boundaries, the dry run advances time synthetically.

---

### Decision 27 — catching_up_order / coasting_order exact semantics

**Status: decided**

The type vocabulary is already defined in shared schemas as `DRIFT_EVENT_TYPES = ['songs', 'jingles', 'station_ids', 'spots', 'promos']`. Both fields are JSON arrays of these values on `clock_segments`.

#### catching_up_order — mechanics

The Supervisor has positive drift (running long) and the next segment has a hard start. It iterates `catching_up_order` in listed order:

1. Find the next `plan_item` with matching `content_type` and `status = 'pending'`
2. Mark it `status = 'supervisor_skipped'`; remove it from the Queue Feeder's feed
3. Recompute remaining duration vs. remaining wall-clock time; stop if drift absorbed
4. If still behind: advance to the next type in the list; repeat

**`spots` must never appear in `catching_up_order`.** Spots are `mandatory = true` in plan_items. The Supervisor must also guard in code: if `item.mandatory === true`, skip it in the iteration regardless of what the list says.

**Sensible defaults by segment type:**

| Segment type | Default | Reasoning |
|---|---|---|
| `music` | `['jingles', 'station_ids', 'promos', 'songs']` | Shed interstitials first (short, cheap), then promos, songs last (most valuable) |
| `stop_set` | `['promos', 'jingles', 'station_ids']` | Only non-contractual content; spots never touched |
| `news` / `bulletin` | `[]` | Rundown items are mandatory; nothing skippable |
| `voice_track` | `['songs']` | Music fill is the only skippable content in a voice-track segment |

#### coasting_order — mechanics

The Supervisor has a gap (running short). For each type in `coasting_order`, it requests a candidate from the Planner specifying `max_duration_seconds = gap − 2s`. The Planner requests from the relevant content process (Branding for station_ids/jingles, Campaign for promos, Music for songs), filters to items ≤ `max_duration_seconds`, and returns the best fit. The item is injected and the Supervisor re-evaluates the residual. Iteration continues until the gap drops below the 5s silence threshold or the list is exhausted.

The order should place the **shortest content types first** to avoid overshooting:

**Sensible defaults by segment type:**

| Segment type | Default | Reasoning |
|---|---|---|
| `music` | `['station_ids', 'jingles', 'promos', 'songs']` | Station ID (15–30s) fills small gaps; escalate to song only if gap is large |
| `stop_set` | `['promos', 'jingles', 'station_ids']` | Promos fill naturally in a break; interstitials for small residuals |
| `news` / `bulletin` | `['station_ids', 'jingles', 'songs']` | Same fill priority as music; song if rundown ran very short |
| `voice_track` | `['songs']` | Only music belongs in a music-segment gap |

**"Too long to fit" handling:** If the content process returns nothing ≤ `max_duration_seconds` (no station ID short enough), the Supervisor moves to the next type in the list. If the list is exhausted and gap > 5s, the Supervisor emits a `COASTING_FILL_FAILED` event and logs the unfilled gap. The next segment's start_policy determines whether silence or early start is the fallback.

---

### Decision 28 — stop_set_estimates: separate table, not a plans column

**Status: decided**

The break space estimate (`BreakSpaceEstimate`) is written to a dedicated `stop_set_estimates` table, not as a JSON column on `plans`.

**Why not a column on `plans`:**
- The inventory UI needs to query "show occupation ratios for all upcoming stop-set breaks in the next 7 days, grouped by segment" — this query benefits from a `segment_id` column with an index, not from parsing a JSON blob on the plans table
- The `plans` table is generic (covers all segment types); a stop-set column would be null on ~70% of rows
- SQLite cannot index into a JSON column, so filtering by `oversubscribed = true` across the plans table would require full scans

**Schema (one row per plan, unique on plan_id):**

```sql
stop_set_estimates
  id                       integer primary key
  plan_id                  integer NOT NULL UNIQUE references plans(id) on delete cascade
  segment_id               integer NOT NULL references clock_segments(id) on delete cascade
  computed_at              integer NOT NULL   -- unix ms
  break_duration_seconds   real NOT NULL
  hard_claimed_seconds     real NOT NULL
  contested_seconds        real NOT NULL
  free_seconds             real NOT NULL
  occupation_ratio         real NOT NULL      -- (hard_claimed + contested) / break_duration
  oversubscribed           integer NOT NULL   -- 0/1 boolean: occupation_ratio > 0.90
  candidate_count          integer NOT NULL   -- eligible campaigns for this break
```

**Write pattern:** Campaign process inserts when the draft plan is created; upserts (update in place) when the finalization pass recomputes with fresher pacing data. Only one row per plan; no draft vs. final distinction — the row always holds the most recent estimate.

**Queries this enables cleanly:**

```sql
-- All oversubscribed upcoming breaks
SELECT sse.*, cs.name
FROM stop_set_estimates sse
JOIN plans p ON p.id = sse.plan_id
JOIN clock_segments cs ON cs.id = sse.segment_id
WHERE p.status IN ('draft', 'finalized')
  AND sse.oversubscribed = 1
ORDER BY p.clock_instance_started_at;

-- Occupation ratio history for one break (inventory analysis)
SELECT computed_at, occupation_ratio
FROM stop_set_estimates
WHERE segment_id = ?
ORDER BY computed_at DESC
LIMIT 90;
```

---

## Deferred to backlog

The following are confirmed features that will not be built in V2 initial implementation:

| Feature | Reason deferred | Notes |
|---|---|---|
| Sweeps Planner | Not needed until sweeps content built out | Sweeps overlay model documented in `project_clocks_design_detail.md` |
| Overlay Content Feeder | Depends on LS secondary audio layer design | Required for beds; design the LS mixer topology first |
| Beds (background audio) | Blocked on overlay feeder | Document LS mixer input reservation in LS script planning |
| Tracking (recorded shows) | Separate content type, low priority | Tracking process will return pre-recorded show clips for tracking segments |
| Voice Track | Similar to tracking | Will slot into same content process model |
| Live Content Process | Not applicable — live is Supervisor state | |
| Operator Console full UI | Data model is ready; UI is deferred | `plan_items` table plus planned API endpoints are sufficient; full drag-reorder UI is follow-on work |
| Simulation UI | Core dry-run logic can land first; simulation UI follows | |

---

### Decision 29 — Two-plan model: active plan + next plan

**Status: decided — 2026-05-28**

The supervisor always tracks two plans simultaneously:

- **Active plan** — executing right now. Belongs to segment N (currently on air). The Queue Feeder reads from it one item at a time.
- **Next plan** — being assembled for segment N+1. Sits in SQLite as `status = 'draft'` or `status = 'finalized'`. Becomes the active plan the moment segment N+1 starts.

The supervisor carries two references in memory: `active_plan_id` and `next_plan_id`. At every segment boundary: next_plan → active_plan; a new next_plan request is issued immediately.

**State machine for `next_plan`:**

```
Segment N starts
  → resolve segment N+1 (via clockResolver.nextSegment)
  → emit PLAN_DRAFT_REQUESTED for N+1  [first pass]
  → store drift_at_first_pass = current_drift_seconds
  → next_plan_id = null (waiting)

PLAN_DRAFT_READY for N+1
  → next_plan_id = plan_id
  → plan visible in UI

T = segment_N_end − 30s
  → compute drift_delta = current_drift_seconds − drift_at_first_pass
  → emit PLAN_FINALIZE_REQUESTED for next_plan_id  [second pass]
    (carries drift_delta so planner can decide depth of re-assembly)

PLAN_FINALIZED for next_plan_id
  → next_plan is ready; sits in DB until boundary fires

Segment N ends / N+1 starts
  → activate next_plan (status → 'active')
  → next_plan → active_plan
  → immediately resolve segment N+2 and repeat from top
```

**Cold start (supervisor starts mid-segment with no plan):**

1. Resolve current segment; compute `remaining_seconds = segmentEnd − now`.
2. Request first-pass draft for the current segment with that remaining target.
3. On draft ready: immediately finalize (no T−30s gate; we are already mid-segment).
4. Activate the plan. Treat `drift_at_first_pass = 0` (restart baseline).
5. Resolve next segment; request first-pass draft for it normally.

The Queue Feeder must not push until there is an active plan. On cold start it blocks until step 4 completes (typically 1–5 seconds of DB work).

---

### Decision 30 — First-pass / second-pass terminology and minimum segment length

**Status: decided — 2026-05-28**

**Terminology (supersedes "draft / finalization" wherever ambiguous):**

| Term | Meaning |
|---|---|
| First pass | Plan assembly triggered at segment N start for segment N+1. Full assembly: content process requests, sequencing, gap fill. Result: `status = 'draft'`. Visible in UI immediately. |
| Second pass | Re-validation or full re-assembly triggered at T−30s before segment N end. Result: `status = 'finalized'`. Becomes active at segment N+1 boundary. |

**Minimum segment length: 120 seconds**

The clock builder must enforce a minimum of 120 seconds per segment. This guarantees:
- At least 90 seconds for first-pass assembly before T−30s arrives.
- The planner has real time to call all four content processes and assemble the sequence.

**Fallback: boundary fires before second pass completes**

If segment N ends while the second pass is still in progress (rare: very short segment, slow content process):
1. Activate the first-pass draft as-is (`draft` → `active`).
2. Log `PLAN_ACTIVATED_WITHOUT_FINALIZATION` with `plan_id` and `segment_id`.
3. Continue normally. The active plan may have stale pacing; the *following* segment's plan will correct.

This fallback also applies on cold start if the supervisor cannot complete even the first pass before the segment ends (extremely rare, but possible on a heavily loaded system). In that case, fall back to the emergency fill path (random music from the default rotation) and log `EMERGENCY_FILL`.

---

### Decision 31 — Drift delta: second-pass trigger and target duration adjustment

**Status: decided — 2026-05-28**

**What is drift delta?**

`drift_delta = drift_at_second_pass − drift_at_first_pass`

It measures how much the drift *changed* during segment N's playback — i.e., how much the organic and operator-induced drift accumulated *after* the first pass was built. A large `drift_delta` means the first-pass plan was assembled under significantly different conditions than what the segment actually experienced.

**Second-pass depth:**

| `|drift_delta|` | Second-pass action |
|---|---|
| < 30s | Lightweight: re-validate pending items against fresh pacing only. Substitute invalid items. No full re-assembly. |
| ≥ 30s | Full re-assembly: drop all pending items in the next plan; request fresh candidates from content processes; re-assemble from scratch with drift-adjusted target. |

The 30s threshold is configurable in the supervisor config table (see Decision 36, `second_pass_drift_delta_threshold_seconds`, default 30).

**Target duration adjustment during full re-assembly:**

When `|drift_delta| ≥ 30s`, the second pass sends a drift-adjusted `target_duration_seconds` to the planner:

```
adjusted_target = nominal_segment_duration − drift_delta
```

- `drift_delta > 0` (fell further behind): adjusted_target < nominal. Gives next segment less content so it finishes closer to its scheduled end, compensating for the late start.
- `drift_delta < 0` (fell further ahead): adjusted_target > nominal. Gives next segment more content to fill the time gained from the early start.

**Bounds:** `adjusted_target` is clamped to `[nominal × 0.6, nominal × 1.4]`. You cannot compress a segment below 60% or expand it beyond 140% of its scheduled duration. Beyond those bounds, recovery falls to the segment after next.

**Rundown segments are exempt.** When segment N+1 is `news` or `bulletin`, the supervisor always sends `nominal_segment_duration` regardless of `drift_delta`. The planner handles compression/expansion internally based on actual rundown content length (see Decision 35).

**UI exposure:**

`supervisor_state` table gains two columns:
- `next_plan_drift_delta_seconds` — the most recently computed drift delta for the next plan
- `next_plan_draft_drift_seconds` — the drift value recorded at first-pass time

The UI supervisor panel shows `drift_delta` alongside the running drift. An indicator ("second pass triggered full re-assembly") fires when `|drift_delta| ≥ threshold`.

---

### Decision 32 — Forward segment resolution

**Status: decided — 2026-05-28**

The supervisor needs to know what segment comes *after* the current one in order to request a first-pass draft for it at the right moment. The `clockResolver` module must expose a `nextSegment(nowMs, db)` function that:

1. Resolves the current segment (same as `resolveCurrentSegment`).
2. Advances past the current segment's end boundary.
3. Resolves the segment that starts at that boundary.
4. Returns the resolved next segment with its `segmentId`, `clockInstanceStartedAt`, and `segmentEndMs`.

The result is valid until segment N ends. The supervisor caches it alongside the current-segment cache and invalidates both on segment boundary.

**Edge cases:**

- Clock structure ends (e.g. the last segment of the last clock in a day) → fall back to the template's fallback clock or the default rotation. Log `NO_NEXT_SEGMENT`.
- Calendar gap (no clock scheduled for the upcoming time) → same fallback.
- Show changes at the boundary → next segment resolver must honour which show (if any) is active at the next boundary.

---

### Decision 33 — Overserve factor

**Status: decided — 2026-05-28**

Content processes return more candidates than the planner strictly needs. This gives the planner a pool to choose from when optimising duration fit, sequencing, and inter-campaign spacing.

**Mechanics:**

The supervisor includes `overserve_factor` in every `REQUEST_CANDIDATES` message. The content process multiplies `duration_needed_seconds × overserve_factor` to determine how many candidates to return.

Example: planner needs 8 minutes of music, `overserve_factor = 2.0` → content process returns ~16 minutes worth of candidates (approximately 4–5 songs). The planner picks the sequence that fills closest to the target.

**Defaults by content type:**

| Content type | Default overserve factor |
|---|---|
| Music | 2.0 (2× needed duration) |
| Campaign spots | 1.5 (sufficient for exclusion/separation logic) |
| Branding (jingles, station IDs) | 1.0 (round-robin pool; all available returned anyway) |
| Rundown | 1.0 (all assigned clips returned; position is fixed) |

The global `overserve_factor` in supervisor config applies to music and campaign. Branding and rundown override it internally.

**UI exposure:** `overserve_factor` appears as a configurable field in the supervisor settings panel (numeric input, range 1.0–4.0, default 2.0). Operators who have large music libraries and want more scheduling variety increase it; operators on slower hardware decrease it to reduce planning time.

---

### Decision 34 — Plan item cut/skip attributes

**Status: decided — 2026-05-28**

Every `plan_item` carries two boolean attributes that govern how the supervisor and Queue Feeder may treat it at runtime:

| Attribute | Meaning |
|---|---|
| `cut_allowed` | This item may be interrupted mid-play at a hard segment boundary. Audio will fade or be cut. |
| `skip_allowed` | This item may be dropped from the plan before it starts playing (catching-up correction). |

**Source of these values:**

1. **Segment-type defaults** in the supervisor config table (see Decision 36). Example: `music` → `cut_allowed=true, skip_allowed=true`; `campaign` → `cut_allowed=false, skip_allowed=false`.
2. **Content process override**: a content process may set `cut_allowed=false` or `skip_allowed=false` on a specific candidate, overriding the default. Example: campaign process marks every spot candidate with `cut_allowed=false` regardless of config.
3. The config default applies when the content process does not set an override.

**Relationship to `mandatory`:**

`mandatory` (already on plan_items) means the item is contractually required to air. `skip_allowed=false` means the supervisor will not remove it proactively. These overlap but are not the same: a promo can be `mandatory=false` (not contractual) and `skip_allowed=false` (operator preference). In practice: `mandatory=true` implies `skip_allowed=false`; the reverse is not true.

**Schema change:** Add `cut_allowed integer NOT NULL DEFAULT 1` and `skip_allowed integer NOT NULL DEFAULT 1` to `plan_items`. The planner writes these from the content process candidate + config lookup when inserting each item.

**Boundary cut logic:** The supervisor, when approaching a hard segment boundary with content still pending:
1. Walk pending items from the tail. If the last item has `cut_allowed=true` (music), allow it to be cut by the next segment's start.
2. If the last item has `cut_allowed=false`, drop it (do not start it) and accept the resulting gap. Fill the gap via `coasting_order` if > 5s.

---

### Decision 35 — Rundown segment: planner owns expansion and compression

**Status: decided — 2026-05-28**

For `news` and `bulletin` segments, the supervisor cannot know the real content duration at the time it requests the plan. The supervisor always sends the **nominal segment duration** (from the clock structure) as `target_duration_seconds` — never a drift-adjusted value.

The planner determines the actual plan length after receiving rundown content from the Rundown process:

```
rundown_total_duration = sum(clip.duration_seconds for clip in ordered_clips)
gap = target_duration_seconds − rundown_total_duration
```

- `gap > 0` → planner fills with music/branding per `coasting_order` (same gap-fill logic as all other segments). The plan ends at approximately `target_duration_seconds`.
- `gap ≤ 0` (rundown content overruns the segment) → planner drops the last clip(s) to fit within `target_duration_seconds` and emits `RUNDOWN_OVERFLOW` event. Supervisor logs this.
- `gap < silence_gap_tolerance_seconds (default 5s)` → no filler attempted; silence accepted.

**What this means for drift recovery:** The supervisor does not ask rundown segments to absorb drift. If segment N has accumulated drift, the supervisor expects segment N+2 (a music or stop-set segment) to absorb it via target duration adjustment. Segment N+1 (news/bulletin) plays its nominal length and is not responsible for drift compensation.

---

### Decision 36 — Supervisor global config table

**Status: decided — 2026-05-28**

A single-row `supervisor_config` table holds all tunable runtime parameters. Operators can edit these via the supervisor settings panel. The supervisor process reads this table on startup and refreshes it on a 30-second cycle (so changes take effect without restart).

**Schema:**

```sql
supervisor_config
  id                                    integer PRIMARY KEY DEFAULT 1
  -- Planning
  overserve_factor                      real    NOT NULL DEFAULT 2.0
  second_pass_drift_delta_threshold_s   real    NOT NULL DEFAULT 30.0
  second_pass_lead_time_s               real    NOT NULL DEFAULT 30.0
  -- Drift correction
  drift_correction_threshold_s          real    NOT NULL DEFAULT 10.0
  coasting_correction_threshold_s       real    NOT NULL DEFAULT 30.0
  -- Silence
  silence_gap_tolerance_s               real    NOT NULL DEFAULT 5.0
  -- Queue
  queue_advance_s                       real    NOT NULL DEFAULT 8.0
  -- Content type defaults: cut_allowed (1/0)
  cut_allowed_music                     integer NOT NULL DEFAULT 1
  cut_allowed_campaign                  integer NOT NULL DEFAULT 0
  cut_allowed_promo                     integer NOT NULL DEFAULT 0
  cut_allowed_jingle                    integer NOT NULL DEFAULT 0
  cut_allowed_station_id                integer NOT NULL DEFAULT 0
  cut_allowed_branding                  integer NOT NULL DEFAULT 0
  cut_allowed_rundown                   integer NOT NULL DEFAULT 0
  cut_allowed_voice_track               integer NOT NULL DEFAULT 0
  -- Content type defaults: skip_allowed (1/0)
  skip_allowed_music                    integer NOT NULL DEFAULT 1
  skip_allowed_campaign                 integer NOT NULL DEFAULT 0
  skip_allowed_promo                    integer NOT NULL DEFAULT 1
  skip_allowed_jingle                   integer NOT NULL DEFAULT 1
  skip_allowed_station_id               integer NOT NULL DEFAULT 1
  skip_allowed_branding                 integer NOT NULL DEFAULT 1
  skip_allowed_rundown                  integer NOT NULL DEFAULT 0
  skip_allowed_voice_track              integer NOT NULL DEFAULT 0
```

**Rationale for defaults:**

| Content type | cut_allowed default | skip_allowed default | Reasoning |
|---|---|---|---|
| music | yes | yes | Songs are the natural fill and the natural sacrifice. A fade on music is acceptable radio practice. |
| campaign (spot) | no | no | Contractual. Never cut, never skip. `mandatory=true` is also set. |
| promo | no | yes | Not contractual; can be deferred but not cut mid-read. |
| jingle | no | yes | Short enough to complete before boundaries; droppable when catching up. |
| station_id | no | yes | Same as jingle. |
| branding (envelope) | no | no | Intro/outro clips define the show's identity; dropping them is audibly jarring. |
| rundown | no | no | News/bulletin items are mandatory content; cutting is editorially unacceptable. |
| voice_track | no | no | Recorded show content; matches rundown treatment. |

**UI exposure:** The settings panel groups these into sections: Planning, Drift Correction, Silence, Queue, and Content Type Defaults. Each field has a tooltip explaining what it controls. Numeric fields have validated ranges (e.g. `overserve_factor` 1.0–4.0, thresholds 5–120s).

---

### Decision 37 — Show extension and cut-short fallback (outline; full design deferred)

**Status: outline decided — full design deferred — 2026-05-28**

**Show extension:**

When an operator extends a show:
- The supervisor enters `EXTENSION_MODE`. It stops tracking the calendar as source of truth.
- It continues tiling segments from the **current calendar block's clock** (the show's clock if a show is active; otherwise the current clock). "Tiling" means repeating the clock's segment sequence past the scheduled end.
- The operator specifies extension in **whole-minute increments** (e.g. +5, +10, +15 minutes). The supervisor uses this to know when to expect the extension to end and resume calendar tracking.
- Segments that were scheduled to start during the extension window are skipped (no attempt to recover them). When extension ends, the supervisor reattaches to the calendar at the **next upcoming segment boundary** and resets drift to zero.
- The UI shows an `EXTENSION_ACTIVE` badge with a countdown to extension end.

**Cut-short show / show skip:**

If a show is cut short or skipped:
- The supervisor does **not** fire the next scheduled show or clock early. This avoids broadcasting a hard-start scheduled segment unexpectedly early.
- Instead it activates a **fallback playlist**: a configured music playlist (set per show or globally in `supervisor_config`) played via the emergency fill path until the next scheduled boundary arrives.
- Log event: `SHOW_CUT_SHORT`, including `show_id`, `segment_id`, `remaining_seconds`, `fallback_playlist_id`.
- When the next natural calendar boundary arrives, the supervisor exits fallback mode and resumes normal planning.

**What to design later:** The UI controls for show extension (minute-increment buttons, extend/end controls), the fallback playlist configuration field (per-show or global), and the calendar resume logic when a show runs long past a clock change boundary.

---

### Decision 38 — Campaign pacing: interval vs show (mutually exclusive) and validation

**Status: decided — 2026-05-28**

A campaign has **one** sub-target granularity, or none:

| Configuration | Meaning |
|---|---|
| Neither | Global pacing only (`plays_per_month` over the campaign period). |
| `plays_per_interval_per_day` | Must hit N plays in each broadcast interval, each day it airs. |
| `plays_per_show` | Must hit N plays per show occurrence it is targeting. |

These two are mutually exclusive — a campaign cannot have both. The UI enforces this: selecting one disables the other.

**Validation constraint (enforced at campaign save time):**

If `plays_per_interval_per_day` is set:
```
total_interval_plays = plays_per_interval_per_day × campaign_duration_days
```
This must not exceed the campaign's total capacity. Total capacity is approximated as:
```
total_capacity = plays_per_month × (campaign_duration_days / 30)
```
The UI warns and blocks save if `total_interval_plays > total_capacity`. This prevents a configuration where the interval sub-target demands more plays than the campaign can physically deliver in total.

**Pacing score at planning time:**

The campaign process computes a pacing ratio at each active granularity:
```
global_ratio = actual_plays_to_date / expected_global_plays_to_date
interval_ratio = actual_plays_in_interval / expected_interval_plays_to_date  (if configured)
show_ratio = actual_plays_in_show / min_plays_per_show  (if configured)
```
`pacing_score` = the *worst* (lowest) ratio across all active granularities. A campaign that is on pace globally but behind in the current show scores as behind. Eligibility exclusion (daily cap, weekly cap) operates independently as a binary gate before the pacing score is computed.

---

### Decision 39 — Slot-1 per-day sharing semantics (confirmed)

**Status: decided — 2026-05-28**

| Priority | `slot_1_satisfied_today = false` | `slot_1_satisfied_today = true` |
|---|---|---|
| `hard` | Must have slot 1. Excludes all other slot-1 competitors from the break. | Must still have slot 1. Exclusion still applies. Slot-1 is always required. |
| `best_effort` | Competes for slot 1 normally. Winner excludes other `slot_1_required` competitors. | Satisfied for today. Drops requirement; can share break with other slot-1 competitors in any position. |

Two `best_effort` slot-1 campaigns that have both satisfied their daily slot-1 can appear in the same break in non-slot-1 positions. The campaign process sets `slot_1_satisfied_today = true` on `CONFIRM_USED` when a campaign wins slot 1 for the day. This flag resets at midnight (or at the start of the broadcast day).

---

### Decision 40 — Show envelope detection and serving

**Status: decided — 2026-05-28**

**How the planner knows it is in a show:**

The supervisor includes `show_id` (nullable) and `show_name` (nullable) in every `PLAN_DRAFT_REQUESTED` message, resolved from the current calendar context. If the segment is inside a show's calendar block, both fields are set. If not (generic clock time), both are null.

**Is this the first or last segment of the show?**

The planner determines this itself by querying the calendar. Given `show_id`, `clock_instance_started_at`, and `segment_id`, the planner:
1. Finds the calendar block for this show instance (the row in `calendar_entries` covering this time).
2. Looks up the clock's segment order. First segment = `show_start`, last segment = `show_end`.
3. Checks whether the next clock instance (from `clockResolver.nextSegment`) belongs to the same show and calendar block. If not → this is the last segment.

The supervisor sends the raw context; the planner derives the structural position. This is cleaner than the supervisor doing two calendar lookups per segment and sending boolean flags.

**Who serves show envelope clips:**

The Branding process. When the planner has confirmed this is a show-start or show-end segment, it includes `show_id` in the `REQUEST_CANDIDATES` call to the Branding process. The Branding process queries show configuration for the `show_start_playlist_id` and `show_end_playlist_id` and returns the appropriate clips as `show_start` / `show_end` candidates in the pool.

**Placement:**

- `show_start` envelope: inserted at position 0, before any segment-start envelope. (Show envelope wraps the segment envelope — the show intro comes first, then the segment intro if one exists.)
- `show_end` envelope: appended at the tail after the segment-end envelope. (Segment outro first, then the show outro.)
- Both carry `skip_allowed=false, cut_allowed=false` (they are identity clips; interrupting them sounds wrong).

---

### Decision 41 — last_in_slot attribute

**Status: decided — 2026-05-28**

`last_in_slot = true` on a plan item means this item must be placed at the tail of its structural group — typically a segment-end or show-end envelope. The planner places items with `last_in_slot=true` after all gap fill, as the final item(s) before the segment boundary.

Content types that carry `last_in_slot`:
- Segment-end envelopes (`segment_end` from Branding pool)
- Show-end envelopes (`show_end` from Branding pool)
- No other content type uses `last_in_slot`.

The planner reserves duration for `last_in_slot` items up-front (same as the current `endReserveSeconds` logic) and inserts them at the end regardless of gap fill results.

---

### Decision 42 — Queue Feeder: zero decision logic; Supervisor owns all fallback

**Status: decided — 2026-05-28**

The Queue Feeder reads the next `pending` plan item from the active plan and pushes it to LiquidSoap. That is its entire job. It has no fallback logic, no emergency fill, and no gap detection.

**If the plan is exhausted before the segment ends:**

The supervisor detects this on its 500ms tick (no more pending items in active plan, segment not yet ended). It decides:
- If the gap is coverable via `coasting_order`: request a fill item from the planner and insert it into the active plan as a new pending item. Queue Feeder picks it up on its next trigger.
- If the gap exceeds 60s and the next plan is finalized: fire the next segment early (advance next_plan → active_plan). No injected fill needed.

The Queue Feeder never decides either of these. It only pushes what the supervisor puts in the plan.

**No emergency fill in the Queue Feeder.** If there is truly nothing to push (plan exhausted, supervisor hasn't inserted fill yet, next segment not ready), the Queue Feeder does nothing and logs `QUEUE_STALL`. The supervisor's next tick resolves the situation within 500ms.

---

### Decision 43 — Drift tolerance defaults: prefer early/late over fill/skip

**Status: decided — 2026-05-28**

**Corrected from previous draft.**

| Situation | Preference | Default |
|---|---|---|
| Running ahead (gap before next segment) | Prefer firing next segment **early** over inserting fill content | `true` |
| Running behind (segment running long) | Prefer letting next segment start **late** over skipping content | `true` |

These are the defaults. Both are configurable in `supervisor_config` as boolean fields:
- `prefer_early_start_over_fill` — default `true`
- `prefer_late_start_over_skip` — default `true`

**What "prefer early" means in practice:** When the supervisor detects a gap in the current plan and the next plan is finalized, it fires the next plan immediately rather than waiting for the scheduled boundary. It only inserts `coasting_order` fill if the next plan is not yet finalized or the gap is very small (< `silence_gap_tolerance_s`, default 5s).

**What "prefer late" means in practice:** When the supervisor detects positive drift (running behind) and the next segment is soft-start, it lets the current segment run over the scheduled boundary rather than skipping content. It only skips if the next segment has a hard start (fixed boundary that cannot flex) or if `prefer_late_start_over_skip = false`.

---

### Decision 44 — Plan transition: when last active item starts playing

**Status: decided — 2026-05-28. Superseded 2026-07-11 — see Decision 60 (activation trigger) and Decision 61 (transition/segment-boundary detection).** The queue-ahead-push half of this decision (pushing the next plan's first item when the outgoing plan's last item starts playing) is still correct and unchanged; only the "this is also when the plan becomes active" half was replaced.

The transition from active plan to next plan happens when the **last pending item of the active plan transitions to `status = 'playing'`** — i.e., when LiquidSoap sends the `on_track` webhook confirming that item is now on air.

At that moment:
1. Supervisor sets `next_plan → active_plan` (`active_plan_id = next_plan_id`, `next_plan_id = null`).
2. Resets `planActivatedAtMs = Date.now()` for the new active plan.
3. Resets `currentDriftSeconds = 0` (new baseline; the intentional offset, if any, was already baked into the plan target — see Decision 45).
4. Resolves the segment after next, emits `PLAN_DRAFT_REQUESTED` for it.

The Queue Feeder then reads from the new active plan when `on_end` fires for the last old-plan item. The handoff is seamless: the last old item is playing, the new plan is active, and the next push comes from the new plan.

**Why "starts playing" not "pushed to queue":**

Pushing happens 8 seconds before the old item ends. Using push time would activate the new plan while the old plan's last item is still playing but not yet finished — resulting in a double-active state. Using "starts playing" means the old plan's last item has definitively started, and the new plan takes over for all subsequent pushes.

---

### Decision 45 — Intentional offset: clean drift baseline on fire-early/late

**Status: decided — 2026-05-28**

When the supervisor intentionally fires a segment early or late, it creates a predictable, known deviation from the scheduled wall-clock boundary. Without accounting for this, the new segment would start with an apparent drift equal to the early/late amount, which would immediately trigger spurious correction actions.

**The fix:** the supervisor records `intentional_offset_seconds` at the moment of firing:
- Fire early by X seconds: `intentional_offset_seconds = −X`
- Fire late by X seconds: `intentional_offset_seconds = +X`

The plan for the new segment is built with a target duration adjusted by this offset:
```
adjusted_target = nominal_duration − intentional_offset_seconds
```
- Fire early (negative offset): `adjusted_target = nominal + X` → more content to fill the extra time
- Fire late (positive offset): `adjusted_target = nominal − X` → less content; segment is compressed to meet the following boundary

Because `planActivatedAtMs = Date.now()` (actual activation time, not scheduled time), and the plan target already matches the actual available time, drift naturally starts near 0 for the new segment. The supervisor does not need to specially adjust its drift calculation — the combination of "actual activation baseline" + "adjusted plan target" produces the correct result.

**State storage:** `intentional_offset_seconds` is stored in `supervisor_state` and logged with every `SEGMENT_START` event. It resets to 0 when the next segment starts on schedule (no intentional offset). It is surfaced in the UI supervisor panel as "Fired ±Xs from schedule" when non-zero, so operators can see why a segment started off-time.

**Capped:** `|intentional_offset_seconds|` is capped at 50% of the nominal segment duration. Firing more than half a segment early or late is not a drift correction — it is a structural change that requires operator awareness.

---

### Decision 46 — Rundown segments: drift correction via skip/fill, not target adjustment

**Status: decided — 2026-05-28**

Rundown (news/bulletin) segments cannot have their target duration adjusted to absorb drift — the content is fixed-order mandatory clips. Drift correction inside a rundown segment uses only:

1. **`catching_up_order` skip:** The rundown segment's `catching_up_order` may list gap-fill content types (e.g. `['songs', 'jingles']`). If the supervisor is running behind, it skips these non-mandatory gap-fill items from the plan. It never skips the mandatory rundown clips.
2. **`coasting_order` fill:** If running ahead, the supervisor injects short fill content (station ID, jingle) into the remaining plan gap.

**Drift carry-forward:** If drift remains after a rundown segment (because the rundown clips are fixed-length and the available correction was insufficient), the drift carries forward to the next segment. The next segment's plan is built using `adjusted_target = nominal − current_drift_seconds` at second-pass time (Decision 31), absorbing the inherited drift naturally. The rundown segment is transparent to this mechanism — it simply passes through with drift unchanged.

The supervisor does not flag this as an anomaly. It is expected that rundown segments do not compress or expand.

---

### Decision 47 — Gap fill music sourcing for rundown and voice-track segments

**Status: decided — 2026-05-28**

When the planner fills a gap in a `news`, `bulletin`, or `voice_track` segment with music (because `coasting_order` includes `songs` and the gap is large enough), it requests music candidates from the Music process using the **current clock's primary rotation** — the same rotation pool used for music segments.

The Music process responds with rotation-eligible candidates (artist separation, repeat interval, play history respected) in the same way as for pure music segments. The planner picks the track(s) that best fit the remaining gap.

**Branding gap fill** (jingles, station IDs) is sourced from the Branding process's general pool (no show-specific filter — these are station-wide assets). This is the same pool used for interstitials in music segments.

The segment configuration's `coasting_order` controls the priority: if `['station_ids', 'jingles', 'songs']`, the planner tries a station ID first, then a jingle, then a music track. Each type is requested only if the remaining gap exceeds the `silence_gap_tolerance_s` threshold.

---

### Decision 48 — Content process → segment type matrix (final)

**Status: decided — 2026-05-28**

Complete mapping of which content processes the planner calls for each segment type. All four processes are called only when their content is actually needed (conditional on segment config, not unconditionally).

| Segment type | Music | Campaign | Branding | Rundown |
|---|---|---|---|---|
| `music` | ✓ Primary rotation + hot-play + heavy rotation candidates | — | ✓ Segment/show envelopes + interstitials (jingles, station IDs) | — |
| `stop_set` | — | ✓ Spots + promos + space estimate | ✓ Segment/show envelopes only (no interstitials in a break) | — |
| `news` | ✓ Gap fill only (if `coasting_order` includes `songs`) | — | ✓ Segment/show envelopes + gap fill (jingles, station IDs) | ✓ Ordered mandatory clips |
| `bulletin` | ✓ Gap fill only (if `coasting_order` includes `songs`) | — | ✓ Segment/show envelopes + gap fill (jingles, station IDs) | ✓ Ordered mandatory clips |
| `voice_track` | ✓ Gap fill only | — | ✓ Segment/show envelopes | ✓ Ordered mandatory clips |
| `live` | — | — | — | — |

Notes:
- **Show envelopes** are included in the Branding response only when `show_id` is set in the request. The Branding process returns `show_start` / `show_end` candidates; the planner inserts them based on `is_show_start` / `is_show_end` determination (Decision 40).
- **Stop-set branding:** a stop-set segment CAN have a segment-start envelope (a short jingle before spots start). This is optional — configured on the segment. The Branding process returns it if the segment has one configured.
- **Music in rundown segments:** requested only if gap fill is needed and `coasting_order` includes `songs`. Planner skips the Music request entirely if the segment is `can_fill = false` or `coasting_order` is empty.

---

### Decision 49 — Fire-early transition: 30-second finalization window

**Status: decided — 2026-05-28**

When the supervisor decides to fire the next segment early (to close a gap rather than insert fill content), it uses the following algorithm to give finalization time to complete before the first push from the new plan.

**Remaining time is computed from SQLite — no LS query needed:**

```
remaining_in_current_item =
  (play_history.started_at + plan_items.planned_duration_seconds × 1000) − Date.now()
```

`started_at` is already stamped on `on_track`. `planned_duration_seconds` is already in the plan item. The supervisor has this from its existing `computePlanPlayhead` logic.

**The algorithm:**

1. Supervisor decides to fire early at time T. Compute `remaining` in the currently playing item.
2. **If `remaining ≥ 30s`:** the currently playing item is the cut point.
   - Mark all subsequent pending items in the active plan as `supervisor_skipped`.
   - Emit `DROP_COMMITTED` to content processes for all skipped items.
   - Immediately emit `PLAN_FINALIZE_REQUESTED` with `adjusted_target_seconds` (see below).
   - Queue Feeder finds no more pending items after the playing item → does not push anything further.
   - When the playing item ends (`on_track` fires for next item, which is now in the new active plan) → transition.
3. **If `remaining < 30s`:** walk forward through pending items in order. Find the first pending item whose `planned_duration_seconds ≥ 30s`. That item becomes the cut point.
   - Push it via Queue Feeder (normal path). Mark everything after it as `supervisor_skipped`.
   - Immediately emit `PLAN_FINALIZE_REQUESTED`.
   - Transition when that item ends.
4. **If all remaining items are short (< 30s each):** let them play in sequence. Emit `PLAN_FINALIZE_REQUESTED` immediately. Finalization has the cumulative runtime of the short items to complete. If finalization is still outstanding when the last item ends: transition anyway and log `PLAN_FINALIZE_TIMEOUT`. Activate draft.

**`adjusted_target_seconds` in `PLAN_FINALIZE_REQUESTED`:**

When the supervisor fires early, it knows `intentional_offset_seconds` — how early the new plan will start relative to the scheduled boundary. The adjusted target for the new plan is:

```
adjusted_target = nominal_segment_duration + |intentional_offset_seconds|
```

The supervisor computes this and passes it in `PLAN_FINALIZE_REQUESTED`. The planner uses this value as the target for re-assembly (full re-assembly if `|drift_delta| ≥ threshold`; otherwise substitution pass only, with the adjusted target recorded for the plan). This ensures the new plan has enough content to fill the extra time from the early start.

**For the normal second-pass path (T−30s gate, not fire-early):**

The same `PLAN_FINALIZE_REQUESTED` message carries:
- `adjusted_target_seconds = nominal − current_drift_seconds` (clamped to [60%, 140%] of nominal)
- `drift_delta = current_drift − drift_at_first_pass` (governs full vs lightweight)
- `current_drift_seconds` (for logging and the target formula)

The planner uses `adjusted_target_seconds` directly. The supervisor owns the computation; the planner does not re-derive drift.

**Transition trigger for fire-early vs normal:**

- **Normal (plan naturally exhausted):** when the last pending item transitions to `playing` (Decision 44) → `next_plan → active_plan`.
- **Fire-early:** the supervisor explicitly manages the transition. When `on_track` fires for the first item of the new plan (the item that follows the cut point in the LS queue) → supervisor sets `active_plan_id = next_plan_id`, resets `planActivatedAtMs = Date.now()`, resets drift to 0. Decision 44's general trigger does not apply to the fire-early path.

---

### Decision 50 — Schema additions for two-plan model

**Status: decided — 2026-05-28**

#### `PLAN_DRAFT_REQUESTED` bus message (additions)

```typescript
interface PlanDraftRequestedMessage {
  type: 'PLAN_DRAFT_REQUESTED'
  request_id: string
  segment_id: number
  clock_instance_started_at: number
  target_duration_seconds: number  // existing
  now_ms: number                   // existing
  show_id: number | null           // NEW — null if no show active
  show_name: string | null         // NEW — null if no show active
}
```

The planner uses `show_id` to request show envelopes from the Branding process. It uses `show_id` + `clock_instance_started_at` to determine `is_show_start` / `is_show_end` by querying the calendar boundary.

#### `PLAN_FINALIZE_REQUESTED` bus message (additions)

```typescript
interface PlanFinalizeRequestedMessage {
  type: 'PLAN_FINALIZE_REQUESTED'
  request_id: string
  plan_id: number
  now_ms: number                        // existing
  adjusted_target_seconds: number       // NEW — computed by supervisor; planner uses as target
  drift_delta_seconds: number           // NEW — |drift_delta| ≥ threshold → full re-assemble
  current_drift_seconds: number         // NEW — for logging
}
```

#### `supervisor_state` table (additions)

```sql
ALTER TABLE supervisor_state ADD COLUMN next_plan_id integer REFERENCES plans(id);
ALTER TABLE supervisor_state ADD COLUMN next_plan_draft_drift_seconds real;
ALTER TABLE supervisor_state ADD COLUMN next_plan_drift_delta_seconds real;
ALTER TABLE supervisor_state ADD COLUMN intentional_offset_seconds real NOT NULL DEFAULT 0;
```

- `next_plan_id` — the plan currently being assembled for the next segment. Null when no next plan exists yet.
- `next_plan_draft_drift_seconds` — the drift value recorded when the first pass was requested. Used to compute `drift_delta` at second-pass time.
- `next_plan_drift_delta_seconds` — the most recently computed `drift_delta` for the next plan. Exposed in UI.
- `intentional_offset_seconds` — the intentional early/late offset used when activating the current active plan. Shown in UI as "Fired ±Xs from schedule". Reset to 0 on normal (on-schedule) plan activation.

#### `supervisor_config` table (additions to Decision 36)

```sql
ALTER TABLE supervisor_config ADD COLUMN prefer_early_start_over_fill integer NOT NULL DEFAULT 1;
ALTER TABLE supervisor_config ADD COLUMN prefer_late_start_over_skip  integer NOT NULL DEFAULT 1;
ALTER TABLE supervisor_config ADD COLUMN fire_early_min_window_s real NOT NULL DEFAULT 30.0;
```

- `prefer_early_start_over_fill` — default `1` (true): when running ahead and gap exceeds threshold, fire next segment early rather than inserting fill content.
- `prefer_late_start_over_skip` — default `1` (true): when running behind and next segment is soft-start, start it late rather than skipping content.
- `fire_early_min_window_s` — default `30.0`: minimum seconds the supervisor guarantees between the fire-early decision and the plan transition. Used in the cut-point selection algorithm (Decision 49).

#### `plan_items` table (additions from Decision 34)

```sql
ALTER TABLE plan_items ADD COLUMN cut_allowed  integer NOT NULL DEFAULT 1;
ALTER TABLE plan_items ADD COLUMN skip_allowed integer NOT NULL DEFAULT 1;
```

Populated by the planner at insert time using the segment-type defaults from `supervisor_config` plus any content-process-level overrides on the candidate.

---

### Decision 51 — Organic drift is accounted at activation; execution drift drives corrections

**Status: decided — 2026-05-28**

#### Organic drift is known at plan activation

The moment a plan is activated, the supervisor computes:

```
planned_overshoot_seconds =
  sum(plan_items.planned_duration_seconds) − nominal_segment_duration_seconds
```

- **Positive**: the plan will run longer than the segment. The segment will finish late.
- **Negative**: the plan will finish before the segment ends. There will be a gap.
- **Zero**: perfect fit (rare in practice due to track length rounding).

This is **accounted drift** — a known, deterministic deviation built into the plan at assembly time. The supervisor does not need to observe drift accumulating to discover it. It is written to `supervisor_state.planned_overshoot_seconds` at activation.

#### First-pass target for next segment already incorporates planned overshoot

The next segment's first-pass plan should account for the current segment's planned overshoot from the start:

```
first_pass_target_N+1 = nominal_duration_N+1 − planned_overshoot_N
```

This means the planner builds the next segment's plan with the right length from the very first pass. The second pass only needs to correct for **execution drift** — deviations that occurred during playback beyond what the plan already promised.

#### Execution drift is the only drift that requires correction

```
execution_drift = actual_drift_at_second_pass − planned_overshoot_N
```

- If `|execution_drift| < correction_threshold`: no correction needed. The accounted overshoot is being absorbed cleanly.
- If `|execution_drift| ≥ correction_threshold`: operator-introduced or playback-timing drift has accumulated. Trigger correction (catching-up, coasting, or replan).

The `drift_delta` threshold in Decision 31 (30s for full re-assemble at second pass) now specifically measures execution drift. Organic overshoot is already baked into the first-pass target and does not count toward that threshold.

The second-pass target formula simplifies to the same result:

```
second_pass_target = nominal_N+1 − actual_drift_N
                   = (nominal_N+1 − planned_overshoot_N) − execution_drift
                   = first_pass_target − execution_drift
```

#### Fire-late and fire-early decisions are made at plan activation, not reactively

The decision of whether to let the current segment overrun the boundary (fire late) or fire early is a structural decision based on the next segment's `start_policy`. It is made **once, at plan activation**, not reactively on each tick as drift accumulates.

| `planned_overshoot` | Next segment `start_policy` | Decision at activation |
|---|---|---|
| > 0 (will run long) | flexible (soft start) | Accept late start. Record `expected_late_seconds = planned_overshoot`. No corrective action. Next segment starts late; its plan was already shortened to compensate. |
| > 0 (will run long) | hard (fixed start) | Immediately correct via `catching_up_order`. Begin skipping non-mandatory items from the plan before they have even aired. Do not wait for drift to accumulate. |
| < 0 (will finish early) | allows early start | Accept early start. Record `expected_early_seconds = |planned_overshoot|`. Gap fill not needed; plan exhaustion triggers normal fire-early transition (Decision 49). |
| < 0 (will finish early) | hard (no early start) | Gap fill was already placed in plan by the planner via `coasting_order`. Supervisor monitors remaining gap at runtime. If gap remains (fill exhausted), silence is accepted up to `silence_gap_tolerance_s`. |

The tick loop still runs every 500ms and watches for execution drift diverging from the accounted state. But it does **not** trigger corrections for drift that is entirely explained by `planned_overshoot`. Only `|execution_drift| > correction_threshold` warrants action.

#### `supervisor_state` additions for this model

```sql
ALTER TABLE supervisor_state ADD COLUMN planned_overshoot_seconds real NOT NULL DEFAULT 0;
-- expected_late/early derived from planned_overshoot; not stored separately.
```

The supervisor logs `PLAN_ACTIVATED` with `planned_overshoot_seconds` and `boundary_decision` (one of: `accept_late`, `correct_immediately`, `accept_early`, `gap_fill_in_plan`) so operators can see why the segment was handled the way it was from the moment it started.

---

## Resilience under live schedule changes and restarts

Prompted by a live incident (2026-07-04): editing a scheduled clock's segments (a playlist-only change) cascade-deleted the active plan and produced ~7 minutes of dead air, because `PUT /clocks/:id/segments` deletes and recreates every segment row on the clock regardless of what actually changed, and `plans.segment_id → clock_segments.id` is `ON DELETE CASCADE`. Recovering it surfaced a second, independent gap: the tick loop's per-segment cache is time-based only and has no way to notice a schedule mutation invalidated what it's tracking. This section documents the resulting design for making schedule mutations, restarts, and recovery actions safe by construction rather than by luck.

### Decision 52 — Segment identity is stable; segments are never implicitly deleted or reissued

**Status: implemented & deployed 2026-07-08 (commit `b3b0e62`).** `PUT /clocks/:id/segments` (`routes/clocks.ts`) now upserts by id instead of delete+recreate; a new `DELETE /clocks/:id/segments/:segmentId` route is the only way a segment is removed, and it's rejected with 409 while the clock is structure-locked (same as an attempted add/remove/reorder via PUT). The structure lock's identity check was tightened to also reject reordering (`incoming[i].id !== existing[i].id`), not just type/duration drift, since order is supposed to be frozen too. `ClockSegmentCreateSchema` gained an optional `id` field to carry this through. Frontend's `deleteSeg` now calls the new endpoint immediately for a persisted segment (positive id) rather than waiting for the next Save — a temp/unsaved segment (negative id) is still just removed locally. Verified against the local dev DB: no-op save preserves ids, content-only edits preserve id, new segments get fresh ids without disturbing others, explicit delete works, and all three lock rejections (shrink, reorder, remove) return 409 while a content-only save on a locked clock still succeeds.

`clock_segments.id` is not just a row key — it's the identity that every hourly occurrence of that segment pins to for as long as the clock is scheduled (`plans.segment_id`, `stop_set_estimates.segment_id`, `play_history.clock_segment_id`, `supervisor_state.current_segment_id`, and `resolution_identity`, Decision 58). `PUT /clocks/:id/segments` currently treats every save as delete-all-and-recreate-all, so even a pure content edit (e.g. changing which playlist feeds a segment) reissues fresh ids for every segment on the clock — which cascades into deleting the live plan for whichever segment happens to be currently airing.

**New rule:** a segment is only ever removed by an explicit, per-segment operator delete action — never inferred from the save payload being shorter than what's stored. The segment structure lock (count/order/type/duration frozen while the clock is scheduled — already enforced server-side in `routes/clocks.ts`) is unaffected; this decision is about how the edits that *are* allowed (content/source changes) get persisted.

**Implementation implication:** `PUT /clocks/:id/segments` moves from delete+recreate to a per-row upsert matched by id — `UPDATE` existing rows in place (preserving `id`), `INSERT` only for genuinely new segments, and `DELETE` only ever driven by an explicit `DELETE /clocks/:id/segments/:segmentId` call. Deleting a segment that's currently live (has an active plan) is still destructive by nature — that's an accepted, operator-intentional consequence of an explicit delete, not something to design around.

---

### Decision 53 — Default clock: mandatory station-wide fallback, resolved as a fourth priority tier

**Status: implemented & deployed 2026-07-08 (commit `2df9d21`).** `station_settings.default_clock_id` added (nullable, `ON DELETE set null`, migration `0055`), a "Fallback" section with a default-clock dropdown added to the Scheduling settings page (with a warning banner when unset), and `resolveCurrentSegment` (`clockResolver.ts`) now tries it as tier 4 via the existing `resolveSegmentWithinClock` helper — `source_type: 'default'`, `source_id` = the clock id itself. `RESOLVED_SCHEDULE_SOURCES`/`ScheduledStateSchema` in `apps/shared/src/schemas/supervisor.ts` already had a `'fallback'` literal from the abandoned prior attempt mentioned below, but it's dead code (no route or UI reads it) — left untouched rather than wired up, since it belongs to a different, superseded design. Verified against the local dev DB: the real ~3-minute daily gap in this station's template schedule (23:57–00:00, uncovered by any `template_entries` row) resolves to `null` with no default clock configured, and correctly resolves to the configured default clock's first-matching segment once one is set, without disturbing tiers 1–3.

`resolveCurrentSegment` (`clockResolver.ts`) resolves in priority order: calendar entry → template clock entry → template entry → (today) `null`, which means silence whenever nothing covers the current moment. A prior attempt at a fallback chain (`shows.extension_policy`, `supervisor_config.silence_gap_tolerance_s`) was abandoned mid-way and left as dead schema fields.

**New rule:** add a single station-wide `default_clock_id` (on `station_settings`, the existing global singleton row). When no calendar entry, template clock entry, or template entry covers the current moment, resolve against the default clock as a fourth tier — using the *same* `resolveSegmentWithinClock` helper the other three tiers already use. This means the default clock resets to its first segment at the top of every wall-clock hour and loops within the hour exactly like any other clock, with no new "when did the gap start" bookkeeping required.

**Explicitly out of scope:** no further fallback beneath the default clock (no default playlist, no "any song in the library"). The supervisor requires a default clock to be configured; that configuration is a startup precondition, not something to design a fallback-of-a-fallback for.

**Escaping fallback requires no special-case logic.** Because `resolveCurrentSegment` re-evaluates the entire priority cascade from scratch on every call, "am I still in fallback" is never a flag that needs setting or clearing — it's just whichever tier wins on the next resolution. A template run that fills a gap is picked up the moment reconcile runs again (Decision 54): the cascade finds a `template` match before it ever reaches tier four, and `resolution_identity`'s `source_type` naturally flips from `default` to `template`.

---

### Decision 54 — Reconcile is triggered automatically by schedule-affecting mutations

**Status: implemented & deployed 2026-07-08 (commit `9f733c2`).** `RECONCILE_REQUESTED` gained a free-form `trigger: string` field (mirroring `PUSH_NEXT_REQUESTED.reason`, not a closed union, so a new call site never needs a bus-type change) and a `requestReconcile(trigger)` convenience export from `bus.ts`. Wired into: `PUT`/`DELETE /clocks/:id/segments` (`clock_segment_save`/`clock_segment_delete`), all individual `calendar-entries` and `template-entries` CRUD routes (`calendar_entry_change`/`template_entry_change`), `POST /apply-template` once per batch and only if it actually changed anything (`template_run`), and `PATCH /shows/:id` when `default_clock_id` is present in the patch body (`show_default_clock_change`). The existing align-to-wall-clock route now passes `trigger: 'operator'` explicitly instead of relying on a hardcoded default in the bus handler. **Expanded beyond the decision's literal list:** also wired `PUT`/`DELETE /template-clock-entries` (`template_clock_entry_change`) — not named in the original bullet list below, but confirmed to be tier 2 in `resolveCurrentSegment`'s own resolution cascade, i.e. exactly the class of gap this decision exists to close. Verified live against the local dev instance: watched `logs/supervisor.log` while firing each route and confirmed `RECONCILE_START` with the correct `trigger` value for calendar-entry PATCH, clock-segment PUT, and show default-clock PATCH.

`reconcile()` already exists and is cheap, idempotent, and safe to call repeatedly (re-derives truth from the DB each time; see Decision 57 for how it decides whether to disturb what's already running). Today it only runs at process startup and via the manual `align-to-wall-clock` operator action (Decision 56). The live incident happened because nothing told it to run when a clock's segments changed out from under it.

**New rule:** emit `RECONCILE_REQUESTED` automatically from every mutation that can change *what* resolves for the current moment:
- Clock segment save/delete (Decision 52)
- Calendar entry create/update/delete, applied in batch (Decision 55)
- Template entry create/update/delete, applied in batch (Decision 55)
- Template run, once after the whole batch commits — not once per row
- A show's `default_clock_id` reassignment (changes which clock a template/calendar row without an explicit `clock_id` resolves to)

**Explicitly excluded — do not trigger reconcile:** playlist assignment, media library content, rotation config, sweeper config, campaign/interval config, rundown content. These affect *what a plan is built from*, not *which segment resolves* — per Decision 23 (already decided), they're picked up automatically by the next `PLAN_DRAFT_REQUESTED` because content processes (confirmed for `MusicProcess`) query the DB live on every request, with no caching layer. No supervisor notification needed for this category; this decision reaffirms Decision 23 rather than superseding it.

**UI note:** surface a passive hint near content-editing screens ("changes apply to the next plan; use Reconcile Clock to pick them up immediately") rather than triggering reconcile for a category that doesn't need it.

---

### Decision 55 — Calendar/template edits are staged and applied as a batch

**Status: implemented & deployed — all 3 phases (commits `ec5edc7` Phase 1 2026-07-09, `86605d9` Phase 2 2026-07-09, `3df0cad` Phase 3 2026-07-09).** Full implementation plan at `/Users/daniel.grigore/.claude/plans/dynamic-honking-patterson.md`. Phase 1 adds `POST /template-entries/batch` and `POST /calendar-entries/batch` (`apps/api/src/routes/schedule.ts`) — both accept `{ ops: Array<create|update|delete> }`, apply sequentially inside one `db.transaction`, and fire exactly one `requestReconcile('template_batch_apply'|'calendar_batch_apply')` after commit. `create` ops carry a client-side negative `tempId` (mirroring Decision 52's clock-segment convention) for response-side id mapping only — `update`/`delete` always target a real positive id, since the frontend's planned squash-per-row design (Phase 2/3) guarantees every row appears as at most one op per batch. The calendar endpoint replicates the individual PATCH/DELETE routes' rundown-content migration (`rundownAssignments`/`rundownDurationOverrides`/`rundownShowContent`, keyed by date/time_start/clock_id) and additionally fixes a data-loss hazard found during design review: two ops in one batch moving existing rows through a position *cycle* (row A → row B's current slot, row B → elsewhere) would, under naive sequential replay, have row A's "clear destination" step delete row B's still-live rundown content before row B's own migration ran. Fixed with a two-pass move — evacuate every position-changing row's rundown content to a transaction-local sentinel slot before any `calendar_entries` row is touched, then in a second pass clear genuine (non-batch) destination content and land the sentinel content. Verified against the local dev DB: plain create/update/delete batches, a rollback-on-invalid-op check (zero partial writes), duplicate-target rejection, exactly one reconcile per batch (both endpoints), and — the critical case — the position-swap scenario with real seeded rundown content confirmed to survive with no data loss and no sentinel leakage.

Calendar and template entries have no save boundary today — `PATCH /calendar-entries/:id` and `PATCH /template-entries/:id` (and the corresponding inserts/deletes) each take effect immediately, one row at a time. Reconciling after every single row edit during a multi-step editing session would be correct but noisy — and for the bulk template-run path (`schedule.ts`, delete + batched insert of calendar entries for a date range), reconciling per-row would mean dozens of redundant reconcile passes mid-batch.

**New rule:** calendar/template editing sessions are staged and committed via an explicit Apply action, which commits the batch in one transaction and fires exactly one `RECONCILE_REQUESTED` afterward. Template run already performs its materialization as a batch operation — it gets the same treatment: one reconcile call after the batch commits, not one per row.

**Why this is safe to be relatively relaxed about:** per Decision 57, reconcile only disturbs anything if the active plan's `resolution_identity` no longer matches a fresh resolve. Most calendar/template edits don't touch the *currently airing* occurrence, so the vast majority of Apply-triggered reconciles will simply confirm nothing needs to change.

**Confirmed unaffected by this decision:** single-row `PATCH` operations on `calendar_entries`/`template_entries` already preserve row id (verified in `routes/schedule.ts`) — this decision is about *when* reconcile fires relative to a batch of edits, not about how those edits are persisted.

---

### Decision 56 — Two recovery actions: Reconcile (safe) and Align to Clock (forceful, forward-only)

**Status: implemented & deployed 2026-07-08 (commit `85379bf`).** The existing `align-to-wall-clock` endpoint is unchanged server-side; its UI button on the Supervisor page is relabeled "Reconcile". New `POST /supervisor/v2/align-to-clock`: reads the active plan, reconstructs its segment's wall-clock bounds via the newly-exported `segmentBoundsWithinClock` (moved out of a private `supervisor.ts` method so both the route and `activePlanSegmentEndMs`/`exhaustedActivePlanSegmentEndMs` share one implementation), and compares against a fresh `resolveCurrentSegment` — if the active plan's segment already starts at or after the fresh resolve's segment start, it's a no-op (forward-only guarantee); otherwise it flips the plan's status to `completed` before emitting `RECONCILE_REQUESTED` with `trigger: 'align_to_clock'`, forcing `reconcile()`'s trust check (D57) to fail and rebuild from wall clock. Response includes `invalidated: boolean` so the caller can tell which branch ran. New UI button styled distinctly (amber, `AlertTriangle` icon) with a `window.confirm()` guard, matching the app's existing destructive-action pattern (Dashboard resync, user/certificate deletion). **Data-hygiene fix included:** `activatePlanById` now also transitions the *previous* active plan to `completed` on every ordinary handover (previously left at `'active'` forever, per the gap noted below) — `completed` was a dead enum value with no writer anywhere in the codebase before this. Deferred, not implemented: the "Reset to Fallback" third action. Verified against the local dev DB: a scratch plan pointed 2 hours in the past correctly returned `invalidated: true` and flipped to `completed`; the real (current) active plan correctly returned `invalidated: false` (no-op); no active plan at all returns `invalidated: false` without erroring; confirmed live via Playwright that both buttons render, the confirm dialog shows the right warning text, and the real POST fires end-to-end with a 200.

The existing `POST /supervisor/v2/align-to-wall-clock` endpoint just emits `RECONCILE_REQUESTED` — it's already `reconcile()`, not a distinct forceful mechanism. That's fine for the "something might be stale, double check" case, but there's a genuinely different, more destructive action operators need: "I know the active plan is wrong or unwanted, throw it away and rebuild from wall clock right now."

**New rule — two distinct actions:**
- **Reconcile** (rename the existing endpoint's UI label from "align to wall clock"): safe, non-disruptive, respects the trust criteria in Decision 57. Suitable to fire automatically (Decision 54) and to expose as a low-stakes manual button.
- **Align to Clock**: explicitly invalidates the current active plan first (transitions its `plans.status` away from `active` — see the data-hygiene note below), then runs reconcile, which is thereby forced into a full wall-clock rebuild regardless of what the trust check would otherwise have concluded.

**Align to Clock is forward-only.** If the plan is currently *behind* wall clock, forcing it forward means skipping whatever content sits between the plan's position and true wall-clock-now — that's an accepted, deliberate trade-off for an explicit operator action (accepting some content won't air, in exchange for being back in sync). But if the plan is currently *ahead* of wall clock (see Decision 57 — this is a legitimate, self-inflicted state, e.g. from heavy operator skipping), Align to Clock must **not** force a backward jump: whatever aired while ahead is already logically consumed (items marked played/skipped, pacing counters advanced), and reactivating an earlier segment's plan would immediately recreate a behind-schedule condition, achieving nothing. When wall-clock resolution would place the station at or behind where the active plan already is, Align to Clock is a no-op.

**Identified but deferred — a third action, "Reset to Fallback":** for the specific case of "the plan is far ahead and the operator wants to stop it without rewinding," dropping into the default-clock fallback (Decision 53) until wall-clock naturally catches up to where calendar/template resolution continues is a plausible clean answer — no rewind, no waiting out arbitrary ahead-content. Not designed in detail; revisit as its own decision when needed.

**Data-hygiene note surfaced while designing this:** `activatePlanById` currently never transitions the *previous* active plan's status away from `'active'` on handover — it just moves the pointer. This hasn't caused incorrect behavior (`reconcileOccurrence` breaks ties by highest plan id), but Align to Clock's "invalidate" step will be the first code to explicitly retire a plan, which is a good opportunity to also close this gap generally (e.g. transition the previous plan to `completed` at every handover, not just at Align to Clock time).

---

### Decision 57 — Active-plan trust criteria for reconcile

**Status: implemented & deployed 2026-07-08 (commit `bd8f39a`, shared with Decision 58).** `activePlanSegmentEndMs` (`supervisor.ts`) now takes the freshly-resolved `ResolvedSegment` and `nowMs` instead of just a timestamp, and checks all 4 criteria before trusting the active plan: status+clock-instance (unchanged), `resolution_identity` match against a fresh `computeResolutionIdentity(resolved)` (Decision 58), at least one `pending`/`playing` item via a new `hasPendingOrPlayingItems` helper (distinct from the existing `pending`-only `hasPendingItems`), and remaining runway ≥ `RUNWAY_WORTH_IT_THRESHOLD_S` via the existing `computeEstimatedRemaining`. Being behind or ahead of wall clock remains explicitly non-disqualifying — untouched. Verified with 6 isolated scratch-plan scenarios directly against the local dev DB (all-criteria-pass, identity-mismatch, exhausted, low-runway, no-active-plan, stale-clock-instance) — each produced the designed trust/no-trust outcome.

`reconcile()` already uses a hybrid, not a blind "always align to wall clock": if `activePlanId` refers to a plan that is `status='active'` and belongs to the same `clock_instance_started_at` as a fresh resolve, it's trusted completely — reconcile won't touch it regardless of which segment wall-clock resolution alone would pick. This exists specifically because an earlier, always-align version of reconcile forced activation back to the wall-clock-resolved segment and undid a correct organic early handoff (confirmed live 2026-05-2X/06-XX regression, documented in the existing code comment) — this is not a hypothetical risk, it's a bug that shipped and got reverted once already. Always-aligning is rejected as a simplification for that reason.

**Gap found while reviewing this:** the trust check only compares plan id and clock instance — it does not check whether the trusted plan has any content left. An exhausted-but-still-`'active'`-status plan (e.g. reconcile runs in the brief window after the last item finished but before `handleExhaustedPlan` catches up on the next tick) is currently trusted and left untouched, meaning reconcile can silently do nothing during a genuine gap.

**Refined trust criteria — a plan is trusted (left alone) only if all of:**
1. `status='active'` and same `clock_instance_started_at` (existing check, unchanged)
2. The calendar/template slot that produced it still resolves to the same `resolution_identity` (Decision 58)
3. It has at least one `pending`/`playing` item left (new)
4. Remaining runway is worth preserving — reuse `RUNWAY_WORTH_IT_THRESHOLD_S` (300s) symmetrically with how `reconcileNext` already gates early cutover for the *next* segment (new)

**Explicitly not a disqualifying condition: being behind wall clock.** A plan behind schedule should be trusted exactly the same as one that's ahead — soft reconcile must never invalidate a behind plan and skip forward to catch up, because that discards whatever content sits in the skipped segments (ad inventory, promos, anything with pacing commitments). Catching up from behind is the job of the existing drift-recovery machinery (gradual, one segment at a time via the normal exhausted-plan handoff), not something reconcile should short-circuit. Skipping ahead to close a gap is reserved for the explicit Align to Clock action (Decision 56), where the operator is knowingly accepting that trade-off.

**Explicitly not a disqualifying condition: being ahead of wall clock**, for the same reason organic early handoff is protected today — being ahead because of a validated, legitimate handoff (or heavy operator skipping) is a real, accepted state, not an error to correct.

---

### Decision 58 — `resolution_identity` is sufficient to detect a reconfigured schedule slot

**Status: verified, no code change needed — 2026-07-08.** Confirmed by reading every `plans` INSERT path (`insertPlanRow` in `planner.ts`, the only place a `plans` row is created): cold start, the normal proactive next-segment draft, and every reconcile-driven draft all stamp `resolution_identity: computeResolutionIdentity(resolved)` via `PLAN_DRAFT_REQUESTED`. The one path that doesn't create a fresh row (`PLAN_REPLAN_REQUESTED`) correctly doesn't touch it either, since it mutates an existing plan rather than drafting a new occurrence. This premise is what makes Decision 57's new identity check meaningful without any further schema or write-path changes.

No new synthetic version/uniqueness stamp is needed. `computeResolutionIdentity` (`source_type:source_id:segment_id:clock_instance_started_at`) already changes exactly when something structurally meaningful happens — a different calendar/template row wins resolution priority, or the resolved segment changes — **provided** the rows it's built from don't reissue identity for edits that aren't structurally meaningful:

- Individual `calendar_entries`/`template_entries` edits already satisfy this — confirmed they're `PATCH`-by-id in `routes/schedule.ts`, not delete+recreate.
- `clock_segments` did not satisfy this before Decision 52; it does once segment saves preserve row id for content-only edits.
- The bulk template-run materialization path legitimately reissues fresh `calendar_entries` ids for the affected date range — correct, since a template run genuinely replaces the schedule for that period rather than editing it in place. This is exactly the case Decision 55 already covers with a single post-batch reconcile.

---

### Decision 59 — Plan continuation across a restart: persist the current play-history pointer, reconstruct instead of blind-resetting

**Status: implemented & deployed 2026-07-08 (commit `84ba88c`).** `supervisor_state.current_play_history_id` added (nullable, `ON DELETE set null`, migration `0056`), mirrored whenever `this.currentPlayHistoryId` changes via a new `setCurrentPlayHistoryId` helper (both branches of `handleTrackStarted`). `hydrateFromDb`'s old blind reset-to-`pending` is now `reconstructOrResetPlayingItem`: it only reconstructs when exactly one `plan_items` row is `'playing'` in the active plan, its `play_history_id` matches the persisted pointer, and `last_heartbeat_at` is present — then checks `started_at <= last_heartbeat_at` for plausibility before deciding played-during-downtime (marks `plan_items` `'played'` and stamps `play_history.ended_at`) vs. still-playing (leaves it alone; `computePlanPlayhead` already reads `play_history.started_at` for `'playing'` items, so drift math needs no changes). Any failed precondition — no pointer, mismatched pointer, more than one `'playing'` row, or an implausible timestamp — falls back to the original blind reset, unchanged. Verified with 5 isolated scratch-row scenarios (expired-during-downtime, still-playing, implausible timestamp, mismatched pointer, no pointer) directly against the local dev DB, all producing the designed outcome.

`handleTrackStarted` durably stamps `play_history.started_at` for every track that starts, linked back via `plan_items.play_history_id` — "what played and exactly when" is already captured permanently. What is *not* persisted is `this.currentPlayHistoryId`, the in-memory pointer to "what's playing right now" — there's no corresponding column on `supervisor_state`. Because of that, `hydrateFromDb()` has no durable, authoritative pointer to recover on restart, and defensively resets any `plan_items.status='playing'` row straight to `'pending'` — a documented, deliberate choice made after an earlier bug where trusting a stale `started_at` produced "a massive negative drift that triggers a runaway loop on every tick." That reset is also the likely mechanism behind observed duplicate-play symptoms after a restart (multiple `play_history` rows logged for the same `plan_item_id` during a boot-time retry storm, 2026-07-04) — resetting to `pending` means whatever was already legitimately airing gets pushed and played again.

**New approach:**
1. Persist `current_play_history_id` on `supervisor_state`, written in the same place `this.currentPlayHistoryId` is set today (`handleTrackStarted`).
2. On restart, `hydrateFromDb` reconstructs instead of blind-resetting: read the pointed-to item's `started_at`, and bound trust in it against the last recorded heartbeat before the process died (this bounds how long the actual outage plausibly was, guarding against the original stale-data failure mode that motivated the reset).
   - If plausible and the item's expected end time has already passed by now → mark it `played` (assume it aired to completion during the downtime — the safer default, avoids a duplicate re-push).
   - If plausible and not yet elapsed → treat it as still legitimately `playing`; normal playhead math continues unchanged.
   - If the timestamp looks implausible (protects the original bug this reset was built to prevent) → fall back to today's reset-to-`pending` behavior.

---

### Decision 60 — Ground-truth plan activation: replace administrative lock-in with confirmed on-air detection

**Status: implemented & deployed 2026-07-11 (commits `fffbd1c`, `6e2285c`, `3b3a9c8`). Supersedes the activation half of Decision 44.**

Decision 44's mechanism conflated two different things: "time to push the next plan's first item into the queue" and "the next plan is now actually active." Promotion (`active_plan_id = next_plan_id`) happened the moment the *outgoing* plan's last item started playing — before the *incoming* plan's own content had genuinely started airing. Since `/supervisor/v2/status`'s `plan_items` is built unconditionally from `active_plan_id`, "Now Playing" could describe a plan that wasn't really on air yet, for the full remaining duration of the outgoing item (seconds to minutes). `supervisorStatus.ts` carried a segment-ID-comparison workaround to compensate, which could itself reference a third, different plan.

**Fix:** split the old single trigger into two independent ones:
- **Queue-ahead nudge** (unchanged timing — last item of the active plan starts playing): still emits `PUSH_NEXT_REQUESTED`, no longer also activates.
- **Activation** (new, ground-truth): in `handleTrackStarted`, on every confirmed `LS_TRACK_STARTED`, look up which `plan_id` the just-confirmed `play_history` row's item actually belongs to. If it differs from `active_plan_id`, that plan **is** now active — no prediction against `next_plan_id`'s timing, no assumption about which position in the plan aired first (an item can be dropped before ever airing).

**Bug found live during rollout, fixed same window (`6e2285c`):** `queueFeeder.ts`'s fallback to `next_plan_id` once `active_plan_id` runs dry needed the existing queue-depth cap ("at most 1 playing + 1 pre-queued") extended to span *both* plan ids — it was scoped only to `active_plan_id`. Without the fix, once the active plan ran dry, every ~500ms tick fell into the fallback with no cap and pushed an entire plan's worth of items into LiquidSoap's queue within under a second.

**Also removed:** `supervisorStatus.ts`'s segment-ID-comparison fallback — the actual root of the plan-mismatch bug — no longer needed since `active_plan_id` always means "what's really airing," by construction.

**Verified live:** watched a real transition end-to-end — `PLAN_ACTIVATED` fired exactly when the incoming plan's own first item's real on-air webhook landed, not before.

---

### Decision 61 — Segment/plan transitions are playhead-driven, not wall-clock-driven

**Status: implemented & deployed 2026-07-11 (commit `2ad30f9`). Refines Decision 60; supersedes the transition-detection half of Decision 44.**

Decision 60 fixed *when* a plan activates, but `tick()` separately re-derived "what segment is current" from a fresh `resolveCurrentSegment(Date.now())` every ~500ms — nominal (planned) segment durations walked from the top of the wall-clock hour, with no awareness of what was actually airing — and used that comparison (`isNewSegment`) as the trigger for `SEGMENT_START`/`SEGMENT_SUMMARY` logging **and** for requesting the next segment's draft.

Under real accumulated drift (10+ minutes, observed live 2026-07-11), nominal wall-clock resolution could report a segment two or more slots ahead of the true playhead. The instant `tick()` saw that jump, it requested a draft for the segment *after* the skipped-to one — permanently orphaning whatever plan was already drafted for the segment(s) that got skipped, since nothing ever references that segment again. This produced two orphaned plans live and a 536-second dead-air incident, recovered only by an unrelated, slow fallback (`HARD_START_FILL` replanning the wrong plan rather than recovering the orphaned one).

This is the same bug class already fixed once in a different call site: `handleExhaustedPlan()` carries a 2026-07-03 comment about a near-identical ~115s dead-air incident, fixed by anchoring to "the exhausted plan's own segment... not a fresh wall-clock resolve." `tick()`'s main boundary-detection block never got the same treatment until now.

**Fix:** move all segment/plan transition bookkeeping — `SEGMENT_START`/`SEGMENT_SUMMARY` logging, `currentSegmentId`/`currentSegmentEndMs`/`currentClockInstanceMs`, and the next-draft request — out of `tick()`'s wall-clock poll and into `activatePlanById`, the one place a transition is already ground-truth-confirmed. A new `resolveActivePlanSegment(planId)` helper (the same "trust the plan's own `segment_id`/`clock_instance_started_at`" pattern as the existing `activePlanSegmentEndMs`/`exhaustedActivePlanSegmentEndMs`) reconstructs real bounds from the plan that actually just activated. Every activation path already funnels through `activatePlanById` — ground-truth on-air confirmation (Decision 60), `handleExhaustedPlan`'s forced advance, `reconcileOccurrence`'s `RECONCILE_ACTIVATE`, cold-start's immediate activation — so this fixes all of them at once, and removes a previous redundancy where a forced advance flipped `active_plan_id` immediately but left bookkeeping to whatever the wall-clock poll happened to do on a later tick.

`tick()` no longer computes `isNewSegment` at all. Wall-clock resolution (`getCachedSegment`/`resolveCurrentSegment`) is still used, deliberately, only where there is genuinely no playhead to be relative to (cold start, orphan recovery) or as an explicit re-grounding (`reconcile()`/align-to-wall-clock) — never to decide an ordinary transition. `maybeHandleHardStartGate` was also simplified to key off the tracked `currentSegmentEndMs` instead of a second, independent wall-clock resolve, for the same reason — under drift the two could point at different "next" segments.

**Verified live post-deploy:** watched two consecutive real transitions, one of them crossing an hour-instance boundary (the exact class that orphaned a plan minutes earlier) — both produced `SEGMENT_SUMMARY` → `SEGMENT_START` → `PLAN_ACTIVATED` in the same log batch, with no `PLAN_ADVANCE_FORCED`, under boundary drift of +530s to +1190s.

---

### Decision 62 — Proactive next-hard-segment lookahead: never discover a hard start one boundary too late

**Status: implemented & deployed 2026-07-11 (commit `8d88077`).**

Confirmed gap (found while reviewing Decision 61's aftermath): every segment resolution call site in `supervisor2/` — `maybeHandleHardStartGate`, `reconcileNext`, `resolveNextSegment` — is strictly "current" or "current+1." Nothing ever looks further than one segment ahead of wherever the tracked playhead currently sits. `reconcile()`, the one mechanism that re-grounds to true wall-clock time, only runs at boot, restart, or the manual Reconcile/Align to Clock buttons (Decision 56) — never on the ordinary tick loop.

**The failure mode this enables:** if tracked drift grows to multiple segments behind true wall-clock (already observed once, +530s→+1190s across two transitions post-Decision 61 — see the "still open" note there), a hard-start segment further down the schedule is invisible to `maybeHandleHardStartGate` until the playhead crawls up to it one boundary at a time. By the time it's finally the tracked "next" segment, real wall-clock time may already be past its start, blowing straight through `HARD_START_TOLERANCE_S` (30s) — a window sized for ordinary per-segment overshoot, not multi-segment backlog. Nothing today collapses the intervening flexible segments; their plans are simply never drafted (the same silent-absorption shape as the pre-Decision-61 orphaned-plan incident, minus the dead air, since whatever's already queued keeps playing).

**Design (revised during implementation — see "Why this changed from the original proposal" below):**

1. **`resolveNextHardSegment(afterMs)`** (`clockResolver.ts`), distinct from `resolveCurrentSegment` (which only ever answers "what covers timestamp X"): walks the schedule forward one segment at a time — across hour-instance boundaries where necessary — starting at `afterMs`, stopping at the first segment whose `start_policy.type === 'hard'`. Bounded at 50 segments so a schedule with no hard segments at all can't spin forever; returns `{ hard, skipped }` — the hard segment itself, plus every non-hard segment walked past to reach it (empty when `hard` is the immediate next segment, i.e. no gap).

2. **The skip-or-not decision is made once, at the point a draft is about to be requested — not every tick.** `resolveNextOccurrence(afterMs, nowMs)` (`supervisor.ts`) is the shared decision point, called from both `maybeRequestNextDraft` (fired once per activation) and `reconcileNext` (fired from `reconcile()`). It calls `resolveNextHardSegment`; if there's no gap, behavior is unchanged (plain structural next). If there's a gap, it compares **real time remaining before the hard segment's true start** against the **combined nominal duration of the segments in between** — if there isn't enough real runway to air them at nominal length, it skips straight to the hard segment (logging `SEGMENT_SKIPPED` for each bypassed segment) instead of drafting the structural next segment at all. This directly answers "how much of the current plan can we actually execute before we have to jump" at the moment it matters, rather than reactively waiting and force-invalidating later.

3. **`maybeHandleHardStartGate` (runs every tick, unavoidably — it's the only part of this that's inherently real-time-continuous) now targets the TRUE next hard segment via `resolveNextHardSegment`, not a single structural hop.** This is the one piece that still must run continuously: once step 2 has decided to skip ahead, this gate is what actually manages filling/trimming the *currently active* plan so it stretches to reach the hard segment's real boundary without running dry early (which would hand off prematurely, violating the hard segment's own no-early-start rule) or running long past it. Its boundary-time comparison changed from `this.currentSegmentEndMs` to `next.segmentStartMs` — those coincide when `next` is genuinely one hop away (contiguous clock layout), but not once it's several hops away. No other change to this gate's fill/trim logic — same thresholds, same triggers.

4. **No separate invalidation mechanism was needed.** Because the skip decision happens at `maybeRequestNextDraft` time — before a draft for an intervening segment is ever requested — there is nothing to invalidate afterward; the bypassed segments simply never get a `plans` row in the first place. (The original proposal below assumed the opposite order — draft first, detect divergence reactively, invalidate — which turned out to need real-time state that a one-shot per-activation check doesn't have.)

5. **Skipped segments are logged explicitly** via `SEGMENT_SKIPPED` (one per bypassed segment, emitted from `resolveNextOccurrence`), plus a `HARD_SEGMENT_LOOKAHEAD_TRIGGERED` summary event — so operators and any future reporting can see what was deliberately dropped, rather than inferring it from an absence of `plan_items` rows.

6. **Interaction with Decision 57's trust criteria:** unaffected — this path never touches `this.activePlanId` or its trust check. It only changes what `maybeRequestNextDraft`/`reconcileNext` request as the *next* plan; the currently active plan keeps running (and being filled/trimmed by point 3) exactly as it already would.

**Why this changed from the original proposal (points 1-6 above, superseded):** the original design (a continuously-cached `nextHardSegment` pointer, checked every tick, forcing an Align-to-Clock-style invalidation once real time closed to within tolerance) was reconsidered once it became clear the lookahead result is stable for the entire lifetime of the current segment — it only depends on schedule structure, not wall clock, so recomputing or comparing it every tick was unnecessary work solving a problem better solved once, at activation. The operator's framing during design review: "regardless of whether the next hard segment is 5 segments away or is the next segment, if we need to jump to it, we need to acknowledge that at the start of the current plan." That reframing is what produced the current design — a one-shot decision at the natural point a plan is drafted, plus reuse of the existing (already tick-driven, already correct) hard-start fill/trim gate for the only part that genuinely needs continuous real-time monitoring.

**Known, accepted imprecision:** `maybeRequestFinalization`'s T-30s finalization gate for `next_plan_id` is keyed off `this.currentSegmentEndMs` (the current segment's own nominal end). In the skip-ahead case, the hard segment's plan is drafted as `next_plan_id` directly, but its finalization still fires 30s before the *current* segment's nominal end — which, once there's a multi-segment gap, is earlier than ideal relative to the hard segment's real start. This only affects the precision of that plan's drift-corrected second-pass target (itself recomputed from actual `boundaryDriftSeconds` at real activation time regardless) — it does not affect correctness of the boundary timing or activation itself, both of which are governed by point 3's continuous fill/trim management. Left as-is; revisit only if it proves to matter in practice.

**Deliberately out of scope for this decision:** what happens if two hard-start segments occur back-to-back with no flexible segment between them (the single-step gate already covers the immediate one; the lookahead would simply find the *next* one after that, unaffected). Any UI surfacing of the `SEGMENT_SKIPPED` event beyond the existing log. Any cap on how far a plan can be filled to reach a distant hard segment — `replanRemaining`'s content assembly is not capped relative to the segment's own nominal duration (confirmed by reading `planner.ts`), so this relies on that existing, unbounded-by-design behavior rather than introducing a new one.

---

### Decision 63 — play_history is the single source of truth: persist cut-short outcome, give each content process its own view, retire the unused feedback protocol

**Status: implemented & deployed 2026-07-11 (commit `76b9cf9`).**

#### Part A — Persist on-air/cut-short outcome (the original, concrete bug)

Confirmed gap (found while discussing Decision 62): `plan_items.status` includes `supervisor_skipped` (set by `applyHardStartTrim`) and `operator_skipped` (set by the manual `/supervisor/v2/skip` route), but both are applied identically whether the item never started (`pending` → skipped, nothing else ever referenced it) or was actively `playing` and got forcibly cut via `HarborClient.skip()` mid-air. The only place the two cases are distinguished today is a transient log field (`on_air: isPlaying` in the `HARD_START_TRIM` log line) — never persisted to `plan_items` or `play_history`.

`play_history.aborted` exists and looks purpose-built for exactly this signal, but is hardcoded to `false` at row-insert time and never written `true` anywhere in the codebase — a dead column. `play_history` also carries no `planned_duration`, so a truncation can't even be inferred after the fact without joining back to `plan_items.planned_duration_seconds` and comparing against `ended_at − started_at` — nothing does that today.

**Why this matters beyond observability:** it already reaches counters that pacing decisions depend on, and would reach billing built the same way. `campaign.ts`'s `countPlaysByCampaign` and `spotBudget.ts`'s pacing/demand functions count `play_history` rows unconditionally by `campaign_id` — no filter on `aborted`, no join to `plan_items.status`. A campaign spot hard-trimmed mid-air today still counts as a completed play in pacing math, and would silently over-bill under the roadmap's planned `duration_bracket × plays_per_month` model if built on the same tables as-is.

**Design:**

1. **Close the loop at the moment of the cut, not later.** `applyHardStartTrim` and the operator `/supervisor/v2/skip` route both already know, synchronously, that they're acting on a `'playing'` item. At that same moment, look up that item's open `play_history` row (by `plan_item_id`) and set `aborted = true` and stamp `ended_at = now` directly — rather than leaving it to be closed out generically, indistinguishably from a natural finish, whenever the next track's start event happens to run `closeRow`/`closeOpenRowsBefore`.
2. **`pending`-status skips need no `play_history` change** — confirmed no row exists for an item skipped before ever being pushed (`play_history` rows are only inserted at push time, `queueFeeder.ts:213`), so a never-aired item was never counted in the first place. The fix is scoped entirely to the mid-air-cut case.
3. **Treat any aborted play as zero, not partial, for billing/pacing purposes** — matches the operator's framing directly: a track cut short doesn't get partial credit. No new "percentage delivered" concept.
4. **Schema-wise, no new column is required** — `play_history.aborted` already exists; this part is entirely about giving it a real writer. If a later decision wants richer detail (e.g. persisting `on_air` on `plan_items` itself, for symmetry with the log field, or recording actual elapsed seconds played), that's additive and can follow `drizzle-kit generate` normally — not needed to close the billing-accuracy gap itself.

#### Part B — play_history is the single source of truth, accessed through one dedicated view per content owner process

Every content process (Music, Campaign, Branding, Rundown — Decision 48) already derives 100% of its real behavioral state — LRP position, pacing, daily caps, slot-1 satisfaction — fresh from `play_history` on every `REQUEST_CANDIDATES` call, rather than from any state the process itself maintains. This decision makes that pattern explicit and formalizes it: instead of each process file writing its own ad hoc raw query against `play_history` (as `music.ts`, `campaign.ts`, and `branding.ts` each do today), each process gets one **named, dedicated view** — a reusable query with a documented contract for "what counts as played, for this process's purposes":

- **Music** — `plan_items.content_type = 'music'`. Counts any row regardless of `aborted`: LRP/rotation cares whether audio was physically emitted at all, not whether it finished.
- **Campaign** — `plan_items.content_type IN ('campaign', 'promo')` (promo has no separate process — Decision 16). This is the view Part A's fix lands in: counts only `aborted = false`, since this view backs billing/pacing/daily-cap decisions. Update every counter that currently reads `play_history` by `campaign_id` without regard to completeness — `campaign.ts`'s `countPlaysByCampaign`, `spotBudget.ts`'s pacing/demand functions — to route through this view instead of querying `play_history` directly.
- **Rundown** — `plan_items.content_type = 'rundown'`. Counts any row, same reasoning as Music. This view is also the foundation for Decision 65's fix (a separate, confirmed-live bug: the show-content sequencing cursor is never written anywhere, so that assignment mode has never actually sequenced) — see Decision 65 for the full mechanism and fix; not itself part of this decision's shipped scope.
- **Branding** — `plan_items.content_type IN ('jingle', 'station_id', 'branding')`. Counts any row, same reasoning. Note the layering here, since it caused some confusion while discussing this: the **media library** has its own distinct `envelope` category (separate from `jingle`, per `packages/shared/src/schemas/library.ts`'s `MEDIA_CATEGORIES`) so an operator can filter media by type when assigning show/segment envelope clips — that's a library-level concern, unrelated to this view. At the `plan_items` level, there is no `'envelope'` content type; jingle and station_id candidates land as `content_type = 'jingle'`/`'station_id'` respectively, and envelope candidates (segment/show open-close) land as `content_type = 'branding'`, the one enum value left unclaimed by anything else. This view operates entirely at the `plan_items` layer, so the media-level `envelope` category doesn't change anything here — worth the implementer confirming the exact `content_type` stamped for envelope items in `planner.ts`'s item-insertion code before relying on it, since that mapping wasn't traced line-by-line, only inferred from the enum's shape.

None of these views need to distinguish sub-kinds further (e.g. jingle vs. station_id vs. which of the four envelope kinds) for LRP purposes — `branding.ts`'s existing per-playlist `lrpPlaylist` queries already scope correctly by `playlist_id`/`media_id` directly, independent of `content_type`. The `content_type`-based view is a coarser "ownership" partition (useful for e.g. a future accounting/reporting surface across a whole process's output), not what drives rotation itself.

#### Part C — the CONFIRM_USED / RETURN_UNUSED / DROP_COMMITTED feedback protocol is confirmed unnecessary, not accidentally unused

Verified while designing Part B: the planner does emit `RETURN_UNUSED` with unused candidate ids after every plan build (`planner.ts:1392`), but no content process subscribes to it (`bus.ts:47` documents it as "informational") — and the same is true of `CONFIRM_USED` (every process treats it as a logging no-op, per each process file's own header comments). This is correct, not a gap to close, for a simple reason: every way a candidate can end up "not used" resolves to something a play_history view already sees without being told.

- Never selected during planning → no `plan_items` row references it → no `play_history` row → invisible to the next request, correctly still eligible.
- Selected but skipped before it ever plays (`pending` → `*_skipped`) → never pushed, so no `play_history` row either (Part A, point 2) → same as above.
- Selected, pushed, and cut mid-air → the *only* case that leaves a `play_history` row, and Part A's fix is exactly what makes that row correctly excluded from the views that should exclude it (Campaign's) while correctly included in the views that shouldn't (Music/Branding/Rundown's).

There is no fourth case where a process needs the Planner to proactively report anything back — the information is always fully reconstructable from the relevant view, the next time that process is asked for candidates. So this decision explicitly retires `RETURN_UNUSED`/`CONFIRM_USED`/`DROP_COMMITTED` as dead-by-design rather than dead-by-oversight — a future engineer should not "finish" wiring these up under the impression something was left unbuilt.

**Deliberately out of scope for this decision:** partial-credit billing models, surfacing cut-short indicators in the Supervisor UI's recent-plays list, any retroactive backfill of historical `play_history` rows (the fix is forward-looking only), actually implementing the Rundown cursor fix noted in Part B (logged as a related finding to pick up separately), and removing the `RETURN_UNUSED`/`CONFIRM_USED`/`DROP_COMMITTED` message types from `bus.ts` outright (this decision retires their *behavioral* relevance; deleting the now-purely-decorative plumbing is a separate, low-stakes cleanup).

---

### Decision 64 — `/supervisor/v2/status` must derive segment/elapsed data from the active plan, not an independent wall-clock resolve

**Status: implemented & deployed 2026-07-11 (commit `3f1c7a4`).**

Confirmed live, reproduced with real numbers: `current_drift_seconds`'s replacement, the operator-facing "live drift" figure (`liveDriftSeconds = elapsed_since_segment_start − plan_consumed_seconds`, Decision "drift display fixes"/`f28cd07`), can read wildly wrong — observed `-788.0s` on the Supervisor page — even though the underlying scheduling engine is healthy and self-correcting. This is a display bug in `supervisorStatus.ts`, not evidence of runaway drift.

**Root cause:** `supervisorStatus.ts:157-159` resolves `segment_started_at_ms`/`segment_duration_seconds`/`current_segment` via a fresh, independent `resolveCurrentSegment(nowMs)` — pure wall-clock calendar math, "what segment should nominally be airing right now." Meanwhile `plan_consumed_seconds` (`:169-193`) is computed correctly, from the *actually active* plan's own items. These two are only guaranteed to agree when the active plan's segment happens to match whatever the wall-clock resolver currently thinks is "now." Whenever the real active plan is mid-*crossing* — running long past its nominal boundary to absorb earlier negative drift, an accepted, deliberate behavior (Decision 51) — the wall-clock resolver has already nominally advanced to a later segment while the real plan is still airing the earlier one. `elapsed_since_segment_start` then measures time since a segment that isn't actually playing, while `plan_consumed_seconds` measures real consumption in a *different* segment entirely. The subtraction produces a number that describes nothing real.

**Confirmed live, 2026-07-11:** at the moment of investigation, `active_plan_id` (`7609`) belonged to segment 232 ("Stop Set hour-end", activated 303s late per `boundary_drift_seconds`), while `current_segment.id` in the same response was `225` ("Music-1") — the wall-clock resolver had already nominally rolled into the next hour's first music segment while the stop set was still genuinely on air. Traced back further: segment 231 ("Music-4") had been deliberately activated with `planned_overshoot_seconds: +310.77` (extended 310s beyond its 660s nominal length to pay down earlier accumulated slack, exactly as Decision 51 designs) and really did run 970.77s — during which the wall-clock resolver marched straight through Music-4's nominal end, the stop set's nominal 120s, and into the new hour's Music-1, all while a single extended plan was still legitimately airing. The `-788.0s` figure observed earlier in the same session is almost certainly the same mechanism at a larger real-vs-nominal gap.

**This is exactly the code comment already present at `supervisorStatus.ts:161-165`** ("active_plan_id always means 'what's really playing,' so there's no need to detect/compensate for a segment mismatch here anymore") proven incomplete: that comment is true for `plan_consumed_seconds` (which does read off `active_plan_id`), but `segment_started_at_ms`/`current_segment` were never updated to match — they still call `resolveCurrentSegment(nowMs)` independently, the same wall-clock-only pattern Decision 61 already identified and removed from the *supervisor's own* tracking, just not from this route.

**Fix:** extract a standalone, route-callable version of `resolveActivePlanSegment` (`supervisor.ts:1340-1367`, currently a private method on `SupervisorProcess`) into a shared module, the same way `segmentBoundsWithinClock` was already extracted for Decision 56 so both the route and the supervisor's internal methods could share one implementation. `supervisorStatus.ts` then derives `segment_started_at_ms`, `segment_duration_seconds`, and `current_segment` from `activePlanId`'s own segment via this shared resolver, instead of an independent `resolveCurrentSegment(nowMs)` call. `plan_consumed_seconds` needs no change — it already reads from the right source. `resolveCurrentSegment(nowMs)` remains appropriate for the *cold-start* case (`activePlanId == null`, no plan to derive anything from) — the fix only removes the independent wall-clock path when a real active plan exists.

**Why this matters beyond cosmetics:** an operator watching the Supervisor page during a legitimate, healthy crossing (exactly the mechanism Decision 51 relies on to keep the schedule converging) sees a large, alarming drift number and may reach for "Align to Clock" — which, per Decision 56, is a forceful, forward-only action that discards whatever content sits between the plan's real position and wall-clock-now. Acting on this display bug could cause the exact content loss Decision 56 warns is an accepted trade-off only for genuine operator-invoked recovery, triggered here by a false reading instead of an actual problem.

**Deliberately out of scope for this decision:** the separate, already-tracked question of why `boundary_drift_seconds` itself grows before settling (the "still open" item from Decision 61) — the trace gathered while investigating this confirms that metric is currently bounded and self-correcting (roughly −120s to +303s across 16 real transitions in this session), so it is not conflated with this display bug, which is a distinct root cause.

---

### Decision 65 — Rundown's show-content cursor never advances: sequencing is broken, fix it via the play_history view, not the abandoned push plan

**Status: implemented & deployed 2026-07-11 (commit `6f45d99`).**

Confirmed live bug, found while designing Decision 63's Rundown view: `rundown_playback_cursors.next_track_index` — the cursor that's supposed to sequence a show-content playlist's tracks across repeated news/bulletin airings — is written **nowhere in the codebase**. A full grep of `apps/api/src` turns up exactly two files referencing the table: `schema.ts` (the definition) and `rundown.ts` (a pure read). There is no insert, no update, anywhere.

**Mechanism:** `nextFromShowContentPlaylist` (`rundown.ts:240-289`) reads the cursor for a `(date, time_start, clock_id, segment_type)` slot, defaults to `next_track_index = 0` when no row exists (`:281`, `cursor?.next_track_index ?? 0`), and picks `tracks[cursorIdx % tracks.length]` (`:282`). Since no row is ever written, `cursorIdx` is *always* `0`, for every slot, every day. A news/bulletin segment assigned via show-content playlist mode therefore always serves the same first track — the "sequenced across all segments of that type in the same clock instance" behavior described in the file's own header comment (`rundown.ts:10-13`) has never actually worked.

**Root cause:** `rundown.ts:20-24`'s own comment explains the gap honestly: "State changes happen only on `CONFIRM_USED`. For Phase 2 we do not advance the show-content cursor here — the queue feeder is the authoritative owner of 'what actually played'... Cursor advancement is currently handled by the V1 picker; once V2's queue feeder lands in Phase 4 it will take over." Phase 4 (queue feeder + supervisor + drift, per the Build Plan below) did land, but nothing in `queueFeeder.ts` or anywhere else was ever wired to write `rundown_playback_cursors`. This is a dropped Phase-4 task, not a design that was tried and reverted — `CONFIRM_USED`'s handler for Rundown (`rundown.ts:66-72`) still just says "No state to advance here."

**Fix:** don't resurrect the abandoned push-based plan (queue feeder writing a cursor row on every rundown play — the same class of "process-owned mutable state that can desync from ground truth" Decision 63 Part C just argued against building). Instead, derive the next index the same stateless way every other process already works: query Decision 63 Part B's Rundown view (`play_history` joined through `plan_items.content_type = 'rundown'`) scoped to this slot's `clock_instance_started_at` + `segment_type`, count how many of the assigned playlist's tracks have already aired in that instance, and use `count % tracks.length` as the next index — replacing the cursor-table read in `nextFromShowContentPlaylist` with this query. Same modulo math the broken code already has; the only change is computing the count from ground truth instead of from a table nothing writes to. No special-casing for `aborted` needed here — per Decision 63 Part B, Rundown's view counts any row regardless, same as Music/Branding, since a cut-short rundown clip still legitimately occupied that sequence position.

**Why this matters:** show-content assignment is a real, operator-facing feature (configured via the Rundown editor per `docs/rundown.md`) that has silently never sequenced correctly — every day's first news bulletin plays the same lead track indefinitely. Not a corner case; it's the default behavior of the entire show-content assignment mode.

**Deliberately out of scope for this decision:** dropping the now-fully-dead `rundown_playback_cursors` table and its migration — worth a follow-up cleanup once the fix has been live long enough to be confident nothing else depends on it, not bundled into the same change as the behavioral fix.

---

### Decision 66 — Hard-start fill/trim gate must defer to the drafted decision, not re-derive its own

**Status: implemented & deployed 2026-07-12 (commit `a6dd5da`).**

Confirmed gap: `maybeHandleHardStartGate` independently called `resolveNextHardSegment` every tick, completely bypassing `resolveNextOccurrence`'s already-made decision (Decision 62) about whether the immediate next segment gets drafted normally or the active plan needs to bridge to a hard boundary itself. It just assumed "fill toward whatever hard segment I can find," regardless of whether a normal next-segment plan already existed. Confirmed live: a 120s stop-set got 63 items appended while its correctly-drafted next segment sat idle unused. Worse — because segment/plan transitions are exhaustion-driven with no independent wall-clock cutover (by design, see Decision 61), an oversized erroneous fill doesn't just waste planning cycles, it can indefinitely postpone a correctly-drafted next plan's activation: a scheduled 2-3 minute stop-set was observed running 42 minutes 37 seconds while an already-`finalized` next plan waited the entire time.

**Fix:** cache `resolveNextOccurrence`'s decision as `activePlanHardBoundary: { segmentId, startMs } | null` at the two points it's actually made (`maybeRequestNextDraft`, `reconcileNext`), clear it in `activatePlanById` (repopulated synchronously by the `maybeRequestNextDraft` call that already follows activation), and have `maybeHandleHardStartGate` consult the cached value instead of independently re-deriving it. When null (a normal next segment already has, or will have, its own plan), the gate now does nothing at all — no fill, no trim, no risk to the real next plan's activation.

**Also fixed in the same pass** (found while tracing the same incident):
- `firstPendingPosition` fell back to position `0` whenever a plan had no pending items left — exactly the state the fill trigger always found it in (confirmed live: `from_position:0, dropped_count:0` every single firing) — colliding with already-played items' positions when `replanRemaining` re-inserted from that position, corrupting the ordering `plan_consumed_seconds` depends on (the operator-facing drift figure showed as growing within a segment, which should be impossible). Replaced with the existing, already-correct `nextAppendPosition` (`MAX(position) + 1` across all statuses) at all three call sites that needed it: the hard-start fill trigger, the live-takeover-end refill (`handleLiveEnded`), and the pre-existing exhausted-plan topup path. `firstPendingPosition` had no remaining callers and was deleted.
- `/supervisor/v2/skip` mutated `plan_items`/called Harbor directly but emitted nothing on the bus — the running supervisor process had no way to know a skip happened until its next incidental poll. Wired to `requestReconcile('operator_skip')`, the same helper every schedule-mutation route already uses, so operator intervention triggers immediate reevaluation.

**Verified live:** the previously-broken stop-set segment ran to its nominal duration (118.5s vs. 120s nominal, 4 items) on multiple subsequent hourly cycles with zero false-positive fill/trim firings across 10+ segment transitions (both stop-set and music types). The fix's first genuine (non-false-positive) `HARD_START_FILL` firing was also observed post-deploy and behaved correctly — appended a reasonably-sized batch (11 items for a ~416s real gap), no position collision.

**Deliberately out of scope for this decision** (surfaced while investigating drift-cascade incidents afterward — see Decisions 67-69): the fill/trim target sizing itself is correct once the gate is only firing when it should, but a *different*, larger drift-cascade issue exists further upstream, in how the planner sizes and reassembles content — those are separate, unimplemented decisions below, not fixed here.

---

### Decision 67 — Second-pass full reassembly must net out already-committed (queue-ahead-pushed) content

**Status: implemented & deployed 2026-07-12 (commit `5ab6d72`).**

Confirmed gap (found while tracing a live drift incident): `finalizePlan`'s full-reassembly branch (`planner.ts`) computes both its reassembly trigger (`contentGapSeconds = |pendingSumSeconds − adjustedTargetSeconds|`) and its rebuild target (the `targetDurationSeconds` passed to `assembleForSegment`) using only this plan's `pending`-status items. But Decision 44's queue-ahead nudge can already have pushed this same plan's first item into Harbor *before* the T-30s finalization gate fires — flipping that item's status to `playing`, not `pending` — whenever the *previous* segment's last item starts playing well ahead of T-30s (common for long tracks). That already-committed, non-droppable item is invisible to both the reassembly trigger and the rebuild: the reassembly just builds a full `adjustedTargetSeconds` worth of *new* content on top of whatever's already committed, rather than the remainder still needed.

Confirmed live: a music segment (`Music-2`) finalized to a target of 763.415s, but its already-pushed first track ("A Horse in the Country," pushed 15s before finalize) stacked on top, producing 998.37s of real airtime — a ~235s overshoot that then cascaded into subsequent segments' drift via Decision 31's boundary-drift carry-forward, since a following stop-set (Decision 68) couldn't absorb it either.

**Fix:** before computing `needsFullReassembly` and before calling `assembleForSegment`, additionally query this plan's already-`playing` items and sum their `planned_duration_seconds` (`committedSeconds`). Use `effectiveTarget = Math.max(0, adjustedTargetSeconds - committedSeconds)` in place of `adjustedTargetSeconds` in both places: compare `pendingSumSeconds` against `effectiveTarget` (not the raw target) when deciding whether to reassemble, and pass `effectiveTarget` (not the raw target) as the rebuild's `targetDurationSeconds`. Log `committed_seconds` alongside the existing `PLAN_FINALIZE_FULL_REASSEMBLY` fields so this is visible in future incidents without having to cross-reference `PUSH_SENT` timing by hand.

---

### Decision 68 — Stop-set target floor must hold at both passes, not just the first

**Status: implemented & deployed 2026-07-12 (commit `5ab6d72`).**

Confirmed gap: `computeFirstPassTarget` (first pass, drafting) explicitly floors a stop-set's target at its own nominal duration — a stop-set is only ever allowed to grow to absorb negative drift (the active plan running short), never shrink, because shrinking a stop-set means cutting committed campaign airtime the campaign is owed. But `maybeRequestFinalization`'s second-pass clamp (`[0.6, 1.4] × nominal`) has no segment-type awareness at all — the identical proportional floor applies to every segment type, stop-sets included. Confirmed live: `Stop Set at 45min` (180s nominal) was finalized down to exactly 108s (`0.6 × 180`) at its T-30s gate — the opposite policy the same segment's first pass had already committed to minutes earlier.

**Fix:** fetch `segment.type` alongside `duration_seconds` in `maybeRequestFinalization` (currently only the latter is selected), and give it the same type-aware bounds `computeFirstPassTarget` already has: for `stop_set`, floor at `nominal` and cap at `nominal × 1.5` (matching first pass's ceiling, not the generic `1.4`); all other types keep their existing `[0.6, 1.4] × nominal` bounds unchanged. Net effect: a stop-set's allowed range is `[nominal, nominal × 1.5]` consistently at both passes, instead of being protected at first pass and unprotected at second.

**Related, deliberately separate scope:** whether a stop-set should also be allowed a small, non-drift-related overshoot/gap (distinct from the drift-floor question above) — purely because the campaign/promo candidate pool can't always fit the boundary exactly — and whether campaign pacing (a campaign already ≥5% ahead of its target pace becoming ineligible, forcing a shorter or skipped stop-set; a campaign under target driving a deliberately lengthened one) should drive stop-set sizing at all. Real, valuable design, but a distinct feature from this decision's drift-floor fix — no campaign-pacing-based eligibility exclusion exists anywhere in `campaign.ts` today (confirmed by inspection: the only threshold, `MANDATORY_PACING_THRESHOLD`, only ever *promotes* a behind-pace campaign to mandatory, never excludes an ahead-of-pace one) — to be scoped as its own decision later.

---

### Decision 69 — Second pass must re-check hard-segment adjacency, not just drift

**Status: implemented & deployed 2026-07-12 (commit `160284a`).**

This revisits the imprecision Decision 62 explicitly deferred ("Known, accepted imprecision," above): `maybeRequestFinalization` never re-runs anything equivalent to `resolveNextOccurrence` — it only recomputes a drift-adjusted target for whatever plan is already drafted as `next_plan_id`. If the real runway to an upcoming hard segment changes between first pass (draft time) and second pass (T-30s) — most plausibly because accumulated drift shrank it in between — the already-drafted next plan is finalized as-is, with no re-evaluation of whether drafting it (at this length, or at all) is still the right call.

**Fix:** `resolveNextOccurrence` now returns `{ resolved, lookahead }` instead of just the resolved segment — it already computed the raw `HardSegmentLookahead` internally, just wasn't surfacing it. Both existing callers (`maybeRequestNextDraft`, `reconcileNext`) were updated to destructure and are otherwise unchanged. `maybeRequestFinalization` calls it again at T-30s (cheap — the function is nowMs-driven and designed to be re-evaluated fresh) and compares the freshly-resolved segment against the segment this plan was actually drafted for:
- Same segment as first pass (nothing changed) → proceed with normal finalize; Decisions 67/68's target math applies unchanged.
- Fresh resolution now says skip-to-hard where the draft was for the structural-next segment → cap the target at whichever is smaller, the segment's own nominal duration or the real seconds remaining before the hard segment's true start. If that capped amount is still `>= RUNWAY_WORTH_IT_THRESHOLD_S` (300s), finalize the existing draft at the capped length instead of the drift-formula target. If not, retire the draft (`plans.status = 'completed'`, the same retirement value `activatePlanById`/`align-to-clock` already use for superseded plans; matching in-memory/`supervisor_state` next-plan fields cleared) and set `activePlanHardBoundary` so the active plan — via the existing, unmodified Decision 66 hard-start gate — becomes responsible for reaching the hard segment on the very next tick.
- Reverse case (fresh resolution now says draft-normally where the existing draft was built for the hard segment directly — runway recovered since first pass) → logged only (`HARD_SEGMENT_RUNWAY_RECOVERED`), no action taken. There's no practical time at T-30s to draft-then-finalize a fresh plan for the newly-preferred segment without risking the boundary itself; deferred in the same "revisit if it proves to matter in practice" spirit as Decision 62's own known imprecision.

**Confirmed safe:** `reconcileOccurrence`'s candidate query (`inArray(plansTable.status, ['draft', 'finalized', 'active'])`) excludes `'completed'` rows by construction, so a retired draft can never be resurrected by a later operator-triggered reconcile — it will simply find no valid candidate and request fresh if needed. Re-calling `resolveNextOccurrence` in the unchanged-decision case can double-log `SEGMENT_SKIPPED`/`HARD_SEGMENT_LOOKAHEAD_TRIGGERED` for segments already logged at first pass — confirmed harmless (both log-only, nothing treats them as an idempotency signal).

**Deliberately out of scope:** the campaign-pacing-driven stop-set sizing carved out of Decision 68 remains separate and unimplemented — this decision's "shrink but keep" path only ever caps against real wall-clock runway, never against content-eligibility rules.

---

### Decision 70 — Jingle and station-ID must never land back-to-back

**Status: implemented 2026-07-12 (commit `4efd7a8`), deployed 2026-07-12 (commit `04bb1b2`).**

`assembleMusicPlan`'s interstitial injection checked jingle-due and station-ID-due independently against the same `musicCount`, each gated only on its own `% N === 0` cadence — if both cadences coincided at the same track boundary, both got inserted back-to-back.

**Fix:** mutually exclusive per boundary. The station-ID check only runs if a jingle wasn't actually *placed* this round (not just "due") — gating on placement rather than eligibility means a jingle whose pool is exhausted or whose pick doesn't fit still leaves room for station-ID at that same boundary.

---

### Decision 71 — First-pass drift recovery must be capped in absolute terms, not just proportionally

**Status: implemented 2026-07-12 (commit `b9caa5d`), deployed 2026-07-12 (commit `04bb1b2`).**

`computeFirstPassTarget` clamped the drift-corrected target to `[floor, nominal × 1.5]` — proportional to the segment's own nominal length, with no absolute limit on how much correction one segment gets asked to absorb in a single shot. A very large drift (operator-induced, or the assembly-overshoot class of bug Decision 67 fixed) got corrected as aggressively as the proportional clamp allowed, rather than spread across several segments.

**Fix:** cap the *correction amount itself* — `MAX_DRIFT_RECOVERY_PER_PLAN_S = 300` (5 minutes) — before applying the existing floor/ceiling clamp. No explicit "recovery ledger" needed: `boundaryDriftSeconds` is recomputed from real wall-clock-vs-schedule facts at every activation regardless of what got applied here, so whatever this cap leaves uncorrected simply persists and gets another chance next cycle. Scope: non-stop-set segments only — see Decision 73, which removes drift correction from stop-sets entirely.

---

### Decision 72 — Music assembly: single boundary decision, in received order, no next-segment awareness

**Status: implemented 2026-07-12 (commit `4efd7a8`), deployed 2026-07-12 (commit `04bb1b2`).**

The fill loop skipped non-fitting candidates and kept hunting the rest of the (2.5×-overserved) pool for anything that fit a shrinking ±30s tolerance window, rather than placing candidates strictly in order and stopping cleanly at the first crossing. A separate end-of-segment patch (d1/d2) bolted on next-segment-type awareness (`isNextHard`/`nextIsFlexibleStopSet`) that duplicated what the hard-start gate (Decision 66) already polices continuously and correctly.

**Fix:** walk `music.candidates` strictly in received order. Place anything that fits cleanly (`duration_seconds <= remaining`). The first candidate that wouldn't fit is the boundary-crossing one — make exactly one decision (place it, forcing `cut_allowed: true` as an unconditional safety net for the hard-start gate, if its overshoot is smaller than the gap left by not placing it) and stop; no further candidates are evaluated. Deleted entirely: `FLEXIBLE_OVERSHOOT_TOLERANCE_SECONDS`, `tryFitItem`, `isHardEnd`, the whole d1/d2 block, and `lookupNextSegmentPolicy` (confirmed via grep: no callers outside this function). The segment-end envelope check already handled a negative `remaining` sensibly — no change needed there, just a larger effective range of values than before.

---

### Decision 73 — Stop-sets no longer participate in drift correction at all; gain a bounded fit-overshoot tolerance instead

**Status: implemented 2026-07-12 (commits `4efd7a8`, `b9caa5d`), deployed 2026-07-12 (commit `04bb1b2`).**

Stop-set content is governed by campaign/promo pacing rules operating on their own (daily/monthly) timescale — using stop-set length as a wall-clock drift-absorption lever created exactly the first/second-pass inconsistency Decision 68 had to patch. Removing it outright is a real simplification: music segments (the majority of segment-seconds) remain fully capable of absorbing drift via Decision 71, so overall schedule-correction capacity is unaffected.

**Fix:**
- `computeFirstPassTarget`: for `stop_set`, returns `nominal` outright — no `boundaryDriftSeconds`/`plannedOvershootSeconds` term at all (Decision 74 adds a recovery-boost addend on top, at the call sites).
- `maybeRequestFinalization`: likewise skips the drift-based `rawTarget`/clamp entirely for `stop_set` — base target is `nominal`. Decision 68's type-aware floor/ceiling fix becomes unreachable for this branch specifically (harmless — still fully active for every other segment type).
- `finalizePlan`'s reassembly trigger: extended the existing rundown drift-exemption to also cover `stop_set` — stop-sets no longer care about `driftDelta`, but `contentGapSeconds` remains a meaningful trigger (catches eligibility changes between draft and finalize, e.g. a campaign crossing its pacing threshold — Decision 74).
- `assembleStopSetPlan`: gains the same single-boundary-decision shape as Decision 72's music redesign. Once the normal campaign fill loop and promo fill both exhaust without overshoot, one final step re-derives still-eligible campaigns (same advertiser-separation/adjacency rules as the main loop, without requiring a spot to already fit) and unused promos, finds the smallest-overshoot option across both (a campaign's shortest available spot, or a promo), and places it only if that overshoot is smaller than the remaining gap. Replaces the old "only ever undershoot, stop at the 15s floor" behavior with a bounded, symmetric tolerance — matching the standing view that stop-sets should tolerate a small overshoot because exact-fit is often impossible, same as music, just for a different reason (spot-pool granularity, not drift).

---

### Decision 74 — Campaign and promo pacing eligibility: 5%-ahead exclusion, monthly recovery-driven stop-set lengthening

**Status: implemented 2026-07-12 (commit `ac6f1f5`, wiring in `b9caa5d`), deployed 2026-07-12 (commit `04bb1b2`).**

**Eligibility:** a campaign or promo already `AHEAD_OF_PACE_THRESHOLD` (0.05, i.e. 5%) ahead of its own pace target is no longer eligible as a stop-set candidate. Campaigns use their existing global pacing basis (`plays_per_month`, linear-interpolated over the campaign's date range) — `computePacingScore` now returns both the existing one-sided "how behind" score and the raw signed ratio it's derived from (`globalPacingBehind` renamed `globalPacingRatio`), so the new eligibility check reuses the same query rather than running it twice. Promos have no monthly target field, so they use their existing daily basis (`min_plays_per_day`) — ahead-of-pace means already ≥5% over that daily minimum; a promo with no minimum configured (0) has nothing to be ahead of, so the check is skipped for it.

This is what actually resolves the promo-backfill gap found during design: once promos are held to the same pacing discipline as campaigns, a stop-set with everything ahead of pace genuinely ends up under-filled — exercising Decision 73's overshoot-or-gap decision on real scarcity — instead of silently backfilling with promos regardless of their own pace.

**Monthly recovery-need calculation — superseded by Decision 75, 2026-07-12 (commit `670de9f`):** this decision originally shipped a standalone `getStopSetRecoveryBoostSeconds(clockSegmentId, nowMs)` in `spotBudget.ts` — a per-day-cached, per-segment pre-allocated absolute-seconds share, wired into `computeFirstPassTarget`/`maybeRequestFinalization` via a `computeFirstPassTargetWithRecovery` wrapper and a `RECOVERY_ABSOLUTE_MAX_SECONDS` (240s) cap. Design discussion afterward found this broke whenever a stop-set was skipped (its pre-allocated share simply evaporated instead of flowing to stop-sets that actually aired) and re-derived pacing math `spotBudget.ts` already did more completely elsewhere. See Decision 75 for the replacement — the eligibility-exclusion mechanism described above is unaffected and unchanged.

---

### Decision 75 — Campaign-driven stop-set recovery multiplier, sourced from the existing L1/L2/L3 budget system

**Status: implemented 2026-07-12 (commit `670de9f`), deployed 2026-07-12 (commit `04bb1b2`). Supersedes the recovery-calculation half of Decision 74.**

`spotBudget.ts` already has a full L1 (`getInventory` — calendar/template-projected stop-set capacity, promo-margin-adjusted) / L2 (`getDemand` — all active campaigns' pro-rated `plays_per_month` demand, correctly scoped by show/interval) / L3 (`getAvailable` — L1 minus L2) system, built specifically to answer "is there enough scheduled capacity for what campaigns need." Decision 74's recovery calculation ignored all of that and approximated with a cruder per-campaign sum, pre-allocated per segment per day — which silently lost its allocation whenever a stop-set got skipped (Decision 62 skip-ahead, or an operator crossing over one mid-plan).

**Fix:** new `getStopSetRecoveryMultiplier(nowMs)` in `spotBudget.ts` calls `getAvailable`/`getInventory` for the period `{start: now, end: endOfMonth}`, mode `'remaining'`, and derives `1 + max(0, -available.global.minutes) / inventory.effective.global.minutes` — if campaign demand genuinely exceeds scheduled stop-set capacity for the rest of the month, `available.global.minutes` is negative, and that's the real shortfall signal. No caching added — `getAvailable`/`getInventory` already hit this file's own `inventoryCache`/`demandCache` internally. No caching *needed*, either: `CampaignProcess` is already fully stateless (`CONFIRM_USED`/`DROP_COMMITTED` are no-ops, `campaign.ts:70-82` — pacing is recomputed from `play_history` fresh on every `buildPool` call), so there's no skip to announce and nothing to invalidate.

**Ownership:** `CampaignProcess.buildPool` calls this and attaches `recovery_multiplier` to the returned `StopSetCandidatePool` (`types.ts:103-110`) — computed once, where the data already is, rather than duplicated across two files. `assembleStopSetPlan` (`planner.ts`) requests the candidate pool with a generous upper bound (`targetDurationSeconds × MAX_RECOVERY_MULTIPLIER`, so spot-pool filtering in `campaign.ts` doesn't prematurely exclude a candidate that would fit once the real multiplier is known), then applies the real multiplier locally, capped at `MAX_RECOVERY_MULTIPLIER` (1.5). This makes the boost apply identically at first pass (`buildPlan`) and at a T-30s full reassembly (`finalizePlan`) — one code path, not the two duplicated supervisor.ts call sites Decision 74 had. All of that supervisor.ts wiring (`computeFirstPassTargetWithRecovery`, `RECOVERY_ABSOLUTE_MAX_SECONDS`, both call sites, the `maybeRequestFinalization` stop-set branch) is reverted — the feature now lives entirely in `campaign.ts` + `planner.ts`.

**Composability with Decision 69 (hard-boundary override):** the multiplier only applies when `targetDurationSeconds >= segment.duration_seconds` (nominal). If it's below nominal, Decision 69's hard-boundary cap (`min(nominal, realRemainingSeconds)`) is already in force for a good reason — a hard segment is imminent — and must win outright; boosting on top of it could overshoot that boundary. This is a self-contained comparison against the segment's own known nominal — no new flag needed through `finalizePlan`/bus messages.

**Scope, confirmed during design:** the multiplier is driven by campaign shortfall only. The L1/L2/L3 system doesn't model individual promo demand — promos are a flat margin (`getPromoMargin()`) there, not a per-promo target the way campaigns have `plays_per_month`. Promos benefit passively: once a stop-set is bigger, the existing fill order (campaigns first by pacing_score, then promos) lets them claim whatever room campaigns don't use. Promo pacing keeps its own daily-basis eligibility treatment from Decision 74, unchanged.

---

### Decision 76 — Stop-set segments can no longer use a hard start policy

**Status: implemented 2026-07-12, deployed 2026-07-12 (commit `04bb1b2`).**

`applyHardStartTrim` (`supervisor.ts`) protects an upcoming hard boundary by trimming the active plan's remaining content, but its `priorityGroups` only know how to cut `jingle`/`branding`/`station_id` and `music` content. A stop-set's content is exclusively campaign and promo spots — neither type is in that list. If a stop-set were configured `hard` (or sat as the active plan in front of a later hard boundary), the trim gate would find nothing it's allowed to cut and do nothing, letting the hard boundary slip silently. `stop_set` was also, until now, the *default* `start_policy` for new stop-set segments in the clock editor (`ClocksPage.tsx` `TYPE_DEFAULTS`) — not a rare misconfiguration but the built-in template.

**Fix:** stop-set segments may only be `flexible`, enforced at both layers:
- `packages/shared/src/schemas/scheduling.ts` — `ClockSegmentCreateSchema` and `ClockSegmentPatchSchema` gain a `superRefine` rejecting `type === 'stop_set' && start_policy.type === 'hard'` (the shared object shape was pulled out as `ClockSegmentCreateShape` so `.partial()` for the patch schema still works after the refine is layered on for create).
- `apps/web/src/pages/clocks/ClocksPage.tsx` — `TYPE_DEFAULTS.stop_set.start_policy` changed to `flexible`; the "Hard" radio option is hidden entirely when editing a `stop_set` segment; a segment loaded with legacy `hard` data shows an amber notice pointing at the Flexible option instead of silently mutating the operator's data.

**Known pre-existing live data, not yet touched:** production clock 5, segment 230 ("Stop Set at 45min") is currently configured `hard`. This fix doesn't rewrite that row — it's a live DB write requiring separate explicit sign-off. Until that row is fixed (via the UI, next time clock 5 is edited, or a direct data fix), saving *any* change to clock 5's segment list will be rejected by the new server-side check until segment 230 is switched to flexible — this is intentional backstop behavior, not a bug.

---

### Decision 77 — A finalized-but-empty stop-set plan must be skipped, not waited on forever

**Status: implemented & deployed 2026-07-12 (commit `9a781f7`).** Confirmed live on the deploy's own restart: `PLAN_SKIPPED_EMPTY` fired correctly for another empty stop-set plan (same ahead-of-pace situation), skipping forward cleanly instead of stalling.

Live incident, same night as Decisions 70-76's deploy: segment 231 (Music-4)'s active plan exhausted normally after its last item aired. The next segment (232, "Stop Set hour-end") had already drafted and finalized — with **zero items**. All 3 currently-active campaigns were massively ahead of Decision 74's 5%-ahead-of-pace threshold (real play counts of 2,686 / 2,175 / 350 against expected ~41 / 14 / 27 by this point in each campaign's run — pre-existing pacing-target/reality mismatch, not a bug), and the one active promo has no media attached. Confirmed, per discussion: this is *correct, intentional* behavior for Decision 74 — a stop-set has nothing to say when nothing is behind pace, and should not be forced to carry filler just to avoid being empty. The bug is entirely in what happens next.

**Two compounding gaps, both real:**

1. **The exhaustion-detection gate never even ran.** `tick()`'s `isCurrentPlayHistoryStillOpen()` treated the outgoing track as "still genuinely playing" purely because `play_history.ended_at` was `NULL`. But `ended_at` is only ever closed by a *later* on-air webhook confirming something new started — and here, nothing new ever got pushed (the empty plan had nothing to push), so LiquidSoap silently fell back to its own internal blank source, an event that produces no webhook at all. `ended_at` would never close, `isCurrentPlayHistoryStillOpen()` would report "still open" forever, and `handleExhaustedPlan()` — the function that already exists specifically to force an advance without waiting for Decision 60's on-air confirmation — never got invoked.
2. **Even once invoked, `handleExhaustedPlan()` didn't check whether the next plan itself had anything to air.** It activates any `draft`/`finalized` `nextPlanId` unconditionally. A finalized plan with zero items can never satisfy Decision 60's "wait for confirmed on-air" gate — there's no first item that could ever generate that confirmation — so activating it just relocates the same deadlock one plan later.

Combined, the station sat on dead air for ~37 minutes until an operator manually triggered `/supervisor/v2/align-to-clock` (Reconcile), which re-derives everything from a fresh wall-clock resolve and isn't subject to either gap.

**Fix, both in `supervisor.ts`:**

1. `isCurrentPlayHistoryStillOpen(nowMs)` now takes `nowMs` and corroborates `ended_at IS NULL` against the item's own expected end (`play_items.planned_duration_seconds` joined off `play_history_id`, mirroring the same `started_at`/duration plausibility check Decision 59 already uses for restart reconstruction). If the expected end has clearly passed (same 5s grace as `tick()`'s neighboring `isStale` check, extracted as `STILL_OPEN_GRACE_MS`) and nothing newer is airing, it's no longer treated as open — regardless of `ended_at`. When the row can't be corroborated (no matching `plan_items` row, e.g. a manually-inserted play), it falls back to trusting ground truth as before.
2. `handleExhaustedPlan()` gains a check, immediately after loading `nextPlan`: if its status is `finalized` and a `plan_items` count for it comes back zero, call the new `skipEmptyNextPlan(nowMs)` instead of proceeding to activate it. Only checked once `finalized` — an empty `draft` can still gain content at the T-30s second pass, so it isn't pre-judged. `skipEmptyNextPlan` retires the empty plan (`status = 'completed'`, matching how a genuinely-aired plan gets retired), clears the `next_plan_*` pointers (in-memory and `supervisor_state`), logs `PLAN_SKIPPED_EMPTY`, and calls the existing `reconcileNext(emptySegment.segmentEndMs, nowMs)` — the exact same recovery path the neighboring "no next plan at all" branch already uses, just anchored at the empty plan's own segment end instead of the outgoing plan's. No new resolution logic — this composes with the existing runway/hard-boundary model in `reconcileNext`/`reconcileOccurrence` for free.

**Deliberately not changed:** Decision 74's exclusion logic and its lack of a fallback-fill tier. Confirmed during design discussion: an empty stop-set is the *correct* outcome when every campaign is ahead of pace, not a defect to paper over.

---

### Decision 78 — Fix the exhausted-plan/finalize race; implement `intentional_offset_seconds` for real; surface the drift-recovery cap

**Status: implemented 2026-07-12, not yet deployed.**

Live investigation of an "impossible"-looking timeline (planned length far exceeding a frozen "gap" baseline, `plan Δ` reporting almost the entire plan's content as a mid-flight shift) traced to a genuine concurrency bug, found on the same night as, but distinct from, Decision 77.

**The race:** `tick()` runs `maybeRequestFinalization(nowMs)` first — if a plan's T-30s gate is due, this emits `PLAN_FINALIZE_REQUESTED` and returns immediately; the actual reassembly (drop old items, add new ones) happens in the planner on a later event-loop turn. Later in that *same* `tick()` call, the exhaustion check can independently decide the *previous* plan just ran out, see the plan from the finalize request as a ready `next_plan_id`, and synchronously force-activate it via `activatePlanById` — which takes a one-time snapshot of the plan's total content for `planned_overshoot_seconds`. Nothing coordinates the two: if the snapshot lands between the reassembly's drop and add, it freezes an artificially-empty baseline for the rest of the segment. Confirmed live down to the millisecond (draft with 2 items → finalize requested → exhausted-plan advance fires 16ms later → activation snapshot taken → reassembly completes 39ms after *that*, with the real 5-item/937s content).

This also matters beyond the display: `planned_overshoot_seconds` is a direct input to `computeFirstPassTarget`'s drift-correction formula for whatever segment comes *after* the corrupted one — so the race doesn't just show a wrong number, it feeds a wrong number into a real scheduling decision.

Separately, discussion of "does a universal, cause-agnostic drift-correction mechanism exist" found that it already does — `computeFirstPassTarget`'s `rawCorrection = boundaryDriftSeconds + plannedOvershootSeconds`, clamped to `±MAX_DRIFT_RECOVERY_PER_PLAN_S` (300s), applied at every next-draft-request site (both `reconcileNext` and the ordinary per-activation `maybeRequestNextDraft`), for any segment type except `stop_set`. No new mechanism was needed there. But `intentional_offset_seconds` (Decision 45) turned out to be dead code — `private readonly intentionalOffsetSeconds = 0;`, never assigned anywhere else in `supervisor.ts`. The UI has only ever displayed a hardcoded zero; this was a backend gap, not a UI one.

**Fix, all in `supervisor.ts`:**

1. **Race fix.** `finalizationRequestedForPlanId` is meant to mean "a finalize is currently in flight for this plan," but was only ever cleared inside `activatePlanById` (unconditional reset for whichever plan just activated) or the hard-boundary-retire branch of `maybeRequestFinalization` — never on genuine completion, so it couldn't distinguish "in flight" from "long done." `handlePlanFinalized` now clears it when `msg.plan_id` matches. `handleExhaustedPlan` gains a guard immediately after the `nextPlan.status` check: if `finalizationRequestedForPlanId === nextPlanId`, log `ACTIVATION_DEFERRED_FINALIZE_IN_FLIGHT` and defer — the next 500ms tick retries once the flag has cleared (finalize round-trips have consistently taken tens of milliseconds, never longer, in every observed log).
2. **`intentional_offset_seconds` implemented for real.** New `nextPlanIntentionalOffsetSeconds` field, set as a side effect wherever the correction is actually computed: `computeFirstPassTarget` (first pass; `0` for `stop_set`, consistent with Decision 73) and `maybeRequestFinalization`'s second-pass `driftAdjustedTarget` calc (supersedes the first pass when it runs; also `0` for stop-sets). `intentionalOffsetSeconds` itself changes from a `readonly` always-zero field to a regular one, populated in `activatePlanById` from `nextPlanIntentionalOffsetSeconds` at the moment this segment's own plan activates, then reset for the next cycle — mirroring exactly how `plannedOvershootSeconds`/`boundaryDriftSeconds` are already captured at that point. `hydrateFromDb` restores it from the DB row on restart, matching its sibling fields (previously not restored at all, since it was always 0 anyway).
3. **Cap surfaced — then made operator-configurable.** Initially shipped as a read-only tooltip on the existing "offset" stat, sourced from the `MAX_DRIFT_RECOVERY_PER_PLAN_S` constant. Follow-up: the operator actually wanted to *change* it, not just see it, so it moved to `station_settings.drift_recovery_cap_seconds` (migration `0057`, `real` column, default `300`, same table/pattern as `promo_margin`/`default_clock_id`), editable on the Scheduling settings page (bounds `[30, 1800]`). `computeFirstPassTarget` became `async` and reads the live value via new `getDriftRecoveryCapSeconds(db)` (no caching — a single indexed row lookup, called from draft-request sites only, never the 500ms tick loop, mirroring `spotBudget.ts`'s `getPromoMargin` pattern exactly). The status route's `drift_recovery_cap_seconds` field now reflects the actual configured value instead of a hardcoded constant, and the tooltip still explains what it means.

**Deliberately not built:** a new/parallel "universal" correction mechanism — the existing one already covers this; only its inputs needed fixing.

---

### Decision 79 — Enrich supervisor logging so silence and "stuck" stop looking identical

**Status: implemented 2026-07-13, not yet deployed.**

Live investigation of a real ~51-minute dead-air incident (plan 7797's last item, "Pose ton gun," confirmed on-air then never detected as exhausted) hit a wall: the deciding function, `isCurrentPlayHistoryStillOpen`, and `tick()`'s "not exhausted, no-op" branch that trusts it are both completely silent. Ruled out stale code, corrupted duration data, a crashed tick loop (`TICK_FAILED` never fired), and a `hasPendingItems` bug — but couldn't pin down why the still-open check kept returning `true` for 51 minutes, because there was zero log trace of what it was actually computing during that window. The incident only resolved via an unrelated container restart, not any self-healing logic.

Explicit design constraint, since the concern raised was CPU/memory cost, not log volume: **no new DB queries anywhere in this decision.** Everything below either logs values a check was already computing to make its true/false decision, or values already sitting in memory as a side effect of normal operation (`this.activePlanId`, `this.boundaryDriftSeconds`, etc.). The only always-on-every-tick cost is a handful of cheap timestamp comparisons; the actual log writes are throttled to fire at most once every 30-60s.

**Three changes, all in `supervisor.ts`:**

1. **`isCurrentPlayHistoryStillOpen` returns diagnostics, not a bare boolean** — `{ stillOpen, expectedEndMs, corroborated }` from the same single query as before. `tick()` uses this to log a throttled `STILL_OPEN_WAIT` entry/ongoing/exit trio (new `stillOpenWaitSince`/`lastStillOpenLogMs` fields, same entry/ongoing/exit shape `queueFeeder.emitStall` already uses) — logged once when the wait begins, re-logged at most every `STILL_OPEN_WAIT_LOG_THROTTLE_MS` (30s) while it continues, and closed out via a new `resetStillOpenWait(nowMs)` helper called from every other branch of the push-timing block (normal push, early push, and right before `handleExhaustedPlan` runs).
2. **Escalating silence alerts, not fire-once.** `silenceAlertFired` (a one-shot boolean, latched forever after the first alert) replaced with `lastSilenceAlertMs: number | null`, re-firing every `SILENCE_ALERT_REPEAT_MS` (60s) while the stall persists, escalating from `warn` to `error` past `SILENCE_ALERT_ESCALATE_S` (300s). Each repeat carries a fresh snapshot (`current_play_history_id`, `still_open_wait_seconds`) reusing state already in memory.
3. **Periodic `SUPERVISOR_SNAPSHOT`** — every `SUPERVISOR_SNAPSHOT_INTERVAL_MS` (60s), regardless of which branch `tick()` takes that cycle, logs `active_plan_id`, `next_plan_id`, `current_segment_id`, `current_play_history_id`, `boundary_drift_seconds`, `planned_overshoot_seconds`, `intentional_offset_seconds`, and the current still-open wait duration if any — a flight recorder, not an alert. This is what was actually missing during the 51-minute gap: a timeline of what the system believed, not just a before/after.

All four new cadence constants are grouped together and commented as candidates for a future Logging settings tab (explicitly deferred, long-term ask) — same shape as Decision 78's `drift_recovery_cap_seconds` migration (hardcoded constant → `station_settings`/`supervisor_config` column → settings field), so wiring them up later is mechanical.

---

### Decision 80 — Split the finalize de-dup guard from in-flight tracking (Decision 78 regression)

**Status: implemented and deployed 2026-07-13 (`cfdb4c0`).**

Decision 78's race fix reused `finalizationRequestedForPlanId` for two conflicting purposes: a permanent de-dup flag (must stay set once a plan has been asked to finalize, never cleared until activation) and a transient in-flight flag (must clear the moment `PLAN_FINALIZED` arrives). Clearing it on completion — required for the in-flight meaning — reopened the de-dup guard, so `maybeRequestFinalization`/`reconcileOccurrence` re-requested finalize for the same already-finalized plan on the very next tick. That completed instantly, re-cleared the flag, and repeated forever, while `handleExhaustedPlan`'s new activation guard (reading the same field) saw it freshly re-set every tick and deferred activation indefinitely. Confirmed live: `ACTIVATION_DEFERRED_FINALIZE_IN_FLIGHT` fired continuously for plan 7803, producing roughly 18 minutes of real dead air — self-inflicted by Decision 78, on the same night it shipped.

**Fix:** a dedicated `finalizeInFlightForPlanId`, set at every `PLAN_FINALIZE_REQUESTED` emission site alongside `finalizationRequestedForPlanId`, cleared only in `handlePlanFinalized` on genuine completion (or when a plan is abandoned via activation or hard-boundary retirement). `finalizationRequestedForPlanId` reverts to its original semantics — set once, never cleared on completion. `handleExhaustedPlan`'s activation guard now reads `finalizeInFlightForPlanId` exclusively.

This is the second guard-field regression in two decisions (77 touched the same neighborhood; 78 introduced this one; both found live, same night). See the audit immediately below for why this keeps happening and what else it found.

---

## Plan-Lifecycle Guard Field Audit — 2026-07-13

Prompted directly by Decision 80: two guard-field bugs shipped back-to-back in the same file, both found only by live incident. Rather than wait for the next one, every instance field in `supervisor.ts` that gates a plan-lifecycle request or transition was read end-to-end — every set site, every clear site, every read site — and checked against what it's supposed to mean.

**The shared root cause, found doing this:** every guard below is released by a bus message (`PLAN_DRAFT_READY`, `PLAN_FINALIZED`, `PLAN_REPLANNED`) that `planner.ts` emits *only on its handler's success path*. Each subscription in `planner.ts` (`start()`, ~line 165) is `void this.handleXRequested(msg).catch(err => logger.error(...))` — the catch exists to keep the process alive and log, not to tell the supervisor anything. If `buildPlan`, `finalizePlan`, or `replanRemaining` throws for any reason — a bad segment row, a DB error, an edge case in assembly — the corresponding completion event never fires, and whichever guard was waiting for it is stuck **permanently**, with a single `*_FAILED` log line as the only trace. No `PLAN_DRAFT_FAILED`/`PLAN_FINALIZE_FAILED`/`PLAN_REPLAN_FAILED` message exists in `bus.ts` today — there is no path back to the supervisor on failure at all.

Decision 80's incident was self-inflicted (a field-reuse bug), but the identical visible symptom — a guard stuck open forever, an activation deferred forever, dead air with no self-heal — is reproducible **today**, with no code change, by any exception thrown inside the planner's three request handlers. That's the actual thing worth fixing, not another one-off patch to whichever field breaks next.

| Field | Meaning | Set at | Cleared at | Verdict |
|---|---|---|---|---|
| `finalizationRequestedForPlanId` | De-dup: never ask twice for the same plan's finalize | `reconcileOccurrence` (draft branch), `handlePlanDraftReady` (cold start), `maybeRequestFinalization` (T-30s gate) | `activatePlanById` (unconditional), hard-boundary-retire branch of `maybeRequestFinalization` | Sound post-D80. Shares the systemic no-completion risk above. |
| `finalizeInFlightForPlanId` | Is a finalize outstanding for this plan *right now* | Same 3 sites as above | `handlePlanFinalized` (on matching completion), `activatePlanById`, hard-boundary-retire branch | Sound post-D80. Same systemic risk: if `PLAN_FINALIZED` never arrives, this never clears, and `handleExhaustedPlan` defers that plan's activation forever — exactly tonight's symptom, via a different trigger. |
| `draftedForNextSegment` | De-dup: don't re-request a draft for the same next segment/instance | `maybeRequestNextDraft` (existing-plan-found branch and fresh-request branch) | `activatePlanById`, hard-boundary-retire branch | Structurally sound, same systemic risk: if `buildPlan` throws, this never clears and that occurrence's draft pipeline stalls silently until the active plan exhausts and `handleExhaustedPlan`'s own reconcile fallback papers over it. |
| `coldStartFinalizeSent` | One-shot latch: has the cold-start finalize already been sent | `handlePlanDraftReady` (cold-start branch) | `handleExhaustedPlan`'s rare resolve-failure fallback | **Gap found:** nothing guards the window between `tick()` first calling `requestColdStartDraft()` and the draft actually coming back — this flag is only set once the draft already has. `tick()` re-fires every 500ms during planner turnaround, unlike the ordinary next-draft path (which `draftedForNextSegment` protects). Low severity: `handlePlanDraftReady`'s existing "already has pending content" check absorbs the duplicates as `NEXT_PLAN_DRAFT_DEFERRED`, not incorrect behavior — just avoidable duplicate draft rows and planner load. Should get its own in-flight guard, mirroring `draftedForNextSegment`. |
| `exhaustedPlanReconciledFor` | De-dup: only reconcile once per exhausted plan id | `handleExhaustedPlan` (no-next-plan branch) | `activatePlanById` | Sound — keyed by plan id, cleared exactly when that plan stops being active. No double duty. |
| `activePlanHardBoundary` | Cached decision: is the active plan on the hook to reach a hard boundary itself | `reconcileNext`, `maybeRequestNextDraft`, hard-boundary-retire branch | `activatePlanById` | Sound — a recomputed-fresh-each-cycle decision cache, not a request-guard. No double duty. |
| `pendingReplanForPlanId` | De-dup across 3 independent call sites (`EXHAUSTED_PLAN_TOPUP`, `HARD_START_FILL`, live-takeover-ended) that all request a replan for the active plan | All 3 sites | Only the `PLAN_REPLANNED` bus handler | **Confirmed latent bug**, not yet triggered live as far as the logs show: `planner.ts`'s `handleReplanRequested` only emits `PLAN_REPLANNED` after `replanRemaining()` resolves. A single replan exception permanently disables both the hard-start fill gate and the exhausted-plan top-up gate for the rest of that plan's active life — silently, with only a `PLAN_REPLAN_FAILED` log line. |

**Recommended fix (not yet implemented):**
1. Planner's three request handlers emit a `_FAILED` completion event (`PLAN_DRAFT_FAILED` / `PLAN_FINALIZE_FAILED` / `PLAN_REPLAN_FAILED`, carrying `request_id`/`plan_id`) alongside the existing log line whenever the handler throws — today's silent black hole becomes a message the supervisor can act on.
2. Supervisor gains handlers for those three events that clear the matching guard field(s), and where sensible, fall back — a failed replan can fall back to the existing `PLAN_STALL`/reconcile path already used for "no next plan."
3. A coarse timeout as an independent backstop: if a guard has been set longer than a generous bound (e.g. 60s — draft/finalize/replan round-trips have never been observed above low hundreds of ms in any live log this session), log a `WARN` and clear it. This protects against a bug in the new failure-event wiring itself reintroducing the same "stuck forever" class.
4. Separately, low-priority: give cold start its own in-flight guard (mirroring `draftedForNextSegment`) so a slow planner response can't produce duplicate `PLAN_DRAFT_REQUESTED` emissions during cold start.

---

### Note — Decision 81 attempted, then reverted; holding for a full review instead

A follow-up to the audit above was drafted and briefly implemented (bus messages for planner failures, a timeout to release a stuck guard, a matching guard for the cold-start request), then reverted at the operator's explicit direction before being committed. Not because the idea was wrong, but because of how it was arrived at: it added a sixth special-case field on top of the five the audit had just finished cataloging, patching the guard-field pattern one more time instead of stepping back from it. The operator does not want the plan-lifecycle logic maintained this way — five-plus similarly-shaped guard fields, each hand-wired at multiple call sites, tracked by name — going forward.

Standing decision: no more incremental patches to individual guard fields. The next work here is a full review of the whole supervisor/scheduling algorithm — everything that automates content against the calendar/template (segment and clock-instance resolution, plan drafting/finalization, drift correction, hard-start handling, live takeover) — conducted and discussed in plain language, not in terms of internal field names. The audit above stays as accurate background for that review; it should inform the review rather than be patched around piecemeal.

---

### Decision 82 — Reduce the Supervisor's recurring loop to a reality-checked diagnose-and-dispatch core; plan lifecycle is explicitly not the Supervisor's problem

**Status: design direction decided in review, 2026-07-14. Nothing implemented yet — no code touched.**

First output of the holistic review Decision 80/81 called for. Covers two separate decisions reached together, plus a set of supporting findings from a detailed walk through the LiquidSoap integration that motivated them.

**Finding: the tick loop is a checklist of independently-polled concerns, almost all assumption-based.** Today `tick()` runs ~12 steps every 500ms — segment resolution, cold start, the T-30s finalize gate, orphan self-heal, playhead computation, the silence alert, the push decision, the hard-start fill/trim gate — each deciding for itself whether to act, every cycle, mostly via cheap early-outs. None of it ever asks LiquidSoap anything; every belief about what's actually playing comes from arithmetic on stored timestamps (`now − started_at` vs. a planned duration), never a live check against reality.

**Decision 1 — the loop shrinks to: heartbeat, plus one diagnostic check that queries reality and dispatches to whichever routine is warranted.** Instead of every concern polling its own condition in parallel, one check asks "are we on track" — where's the playhead really, cross-checked against LiquidSoap's own live state, not just our stored timestamps — and the *outcome* of that single check decides whether to push, correct drift, trigger hard-start fill/trim, or do nothing. This collapses today's silence check / push decision / hard-start gate from three independently-polled branches into three possible *outcomes* of one diagnosis.

What moves fully outside the recurring loop as part of this:
- **Cold start and orphan self-heal** collapse into the existing startup/reconcile path instead of remaining separate tick-checked branches. This also removes a real race found during the review: today's blunt cold-start branch (`activePlanId == null && nextPlanId == null && !coldStartFinalizeSent → request a draft, no existing-plan check`) can fire concurrently with `reconcile()`'s careful, existing-plan-checking version right after boot, because the hydrate-then-reconcile sequence in `start()` isn't awaited before the tick timer begins. One mechanism, not two, closes that.
- **Drafting the next segment's plan** stays exactly as it is today — triggered as a side effect of a plan *activating* (ground-truth track-start, or a forced handoff), never polled. Confirmed unchanged; this was already the right shape (moved out of the tick loop earlier specifically to fix a wall-clock-jump-skips-a-segment bug), just re-affirmed rather than touched.
- **The T-30s finalize gate and the hard-start fill/trim gate** are candidates to become scheduled one-shot timers (compute the target moment once, fire once) rather than polled thresholds — same shape as the silence alert becoming a watchdog reset on every successful push rather than a per-tick comparison. Direction agreed; exact mechanism not yet designed.
- **The periodic snapshot's usefulness is an open question**, not yet decided either way.

**Decision 2 — plan-lifecycle correctness is explicitly not the Supervisor's responsibility.** This reframes the guard-field audit above rather than replacing it. The D78/D80 fragility existed because the Supervisor kept its *own* private, in-memory bookkeeping ("did I already ask for this, is it done yet" — `finalizationRequestedForPlanId`, `finalizeInFlightForPlanId`, `draftedForNextSegment`, `pendingReplanForPlanId`, `coldStartFinalizeSent`) shadowing something the database already tracks correctly: a plan's own `status` column. The Supervisor never needed a parallel copy of "is this plan finalized yet" — it could always just read the plan's real status. Going forward, the Supervisor's job is to check reality and ask for what's needed; whether a draft/finalize/replan request eventually succeeds, fails, or needs retrying is the Planner's concern, backed by the plan's own persisted state — not a set of Supervisor instance fields that can drift out of sync with events that might never arrive. This also supersedes the earlier idea (sketched, then reverted, in the Decision 81 note above) of building one *generic* in-flight-request tracker inside the Supervisor — that was solving the problem at the wrong layer; the better fix is not tracking requests in the Supervisor at all.

**Confirmed buildable: a `/now-playing`-style endpoint**, the mechanism Decision 1's reality-check depends on. Verified directly against the actual running instance (LiquidSoap 2.2.5, `soono-liquidsoap` container) via `liquidsoap -h`, not just documentation. The `queue` source (`request.queue`) exposes these as its own methods:
- `current() → request?` — the request currently being played, **nullable**.
- `queue() → [request]` / `length() → int` — what's waiting, separate from what's playing.
- `remaining() → float` / `elapsed() → float` — live position within whatever `current()` returns, when it's non-null.

The nullability of `current()` matters: **"nothing currently playing" and "the queue has items waiting" are two independently-true facts, not one derived from the other.** Confirmed this is a real, reachable state, not a hypothetical: `fetch()`'s own doc note says feeding the queue with a new request "can take long to return," and `is_ready()`'s doc note is explicit that being ready to stream is not the same as currently streaming. So an item can sit in the queue, formally present, while LiquidSoap is still resolving it — and since the whole output is `fallback(track_sensitive=false, [live, queue, blank()])`, if `queue` isn't ready at that exact instant, the fallback drops straight to `blank()` (real silence) even though `/queue` would still report depth > 0.

This shapes what `/now-playing` needs to check: not just "remaining/elapsed on the current track" (which presumes something is playing), but `current()` first — null or not — with `queue()`/`length()` reported separately, since those two can genuinely diverge. No equivalent pull-style metadata getter exists beyond `current()`'s own request handle (`on_metadata`/`on_track` are callback-only for anything richer) — a `/now-playing` handler would need to combine `current()`/`remaining()`/`elapsed()` with metadata already captured by the existing `on_track` callback, stashed into script-side state instead of only being POSTed to the API. Same `harbor.http.register` pattern `/live-status` already proves works — query a source's live state synchronously, at request time.

**Supporting findings from this review, not yet actioned, carried forward:**
- `live-started` / `live-ended` webhooks have full receiving-side handling in the Supervisor and dedicated routes, but nothing found in the generated LiquidSoap script actually triggers them (`input.harbor`'s connect/disconnect callbacks aren't wired). The live-audio takeover itself works regardless — that's LiquidSoap's own `fallback(track_sensitive=false, [live, queue, blank()])` operator, entirely independent of any webhook — but the Supervisor's *awareness* that a takeover is happening may not be firing at all. Not yet confirmed by testing; live-host logs weren't checked (host was unreachable during the review).
- No equivalent of the Supervisor's own heartbeat exists for LiquidSoap's liveness. `lastPushSentMs` (in-memory, resets on restart) is the closest incidental proxy, but nothing treats "is LiquidSoap actually alive" as a first-class, persisted fact the way `last_heartbeat_at` does for the Supervisor's own process.
  - **Confirmed mechanism to close this:** `process.pid() → int` is real (verified via `liquidsoap -h`) and changes on every restart, since it's the OS process id. Capturing it once at script load and stamping it onto every webhook payload (`on_track`, `on_end`) and every query endpoint (`/live-status`, future `/now-playing`) gives the API a per-boot identifier — the Supervisor just remembers the last pid it saw, and any arrival carrying a different one is unambiguous proof LiquidSoap restarted in between. Deliberately spread across *every* event rather than relying on one dedicated "just booted" webhook: a single boot notification can itself get lost in exactly the kind of startup race seen tonight (harbor briefly unreachable right after a compose restart) — with the pid riding on everything, even a missed boot notification still gets caught retroactively by the next ordinary webhook. A dedicated boot webhook is still worth adding as the fast path on top of this, not instead of it.
- `on_end`'s `remaining` value — genuine, LiquidSoap-verified remaining time — is received by the Queue Feeder and discarded; only used as a fire trigger, never to validate anything.
- The queue depth-cap (at most 1 playing + 1 pre-queued) is enforced by counting `plan_items` marked `'playing'` in our own database, not by querying LiquidSoap's actual queue contents. If that count is ever wrong, an extra push doesn't error — `request.queue` has no size limit — it just sits appended at the end of the real queue and will genuinely play later, potentially firing `on_track` for stale/superseded content and confusing plan activation well after the fact.

---

### Decision 83 — Unified playhead: one on-demand-computed calendar position, not per-mechanism tracking

**Status: design decided 2026-07-14 (holistic review continuation). Elaborates the reality-check premise of Decision 82. Not yet implemented.**

Today "where are we" has no single answer — the Supervisor's plan-playhead (sum of terminal item durations plus elapsed time in the currently-playing item), the wall-clock resolver (used only at cold-start/reconcile), the per-activation drift snapshot, and the hard-segment lookahead's own starting point are four separately-computed beliefs about position, each capable of disagreeing with the others under drift — exactly the failure shape behind the Decision 61 dead-air incident.

**Fix:** one playhead resolver, computed on demand, never stored. Given "now," it answers a single question — which calendar/template/default-clock segment are we in, and how far into it — derived from real ground truth (the last confirmed on-air event plus elapsed time since), never from independently re-resolving wall-clock time except when there is genuinely no ground truth to anchor to (cold start, LS-restart recovery, orphan recovery — Decision 88). Every mechanism that currently does its own position math becomes a caller of this one function instead:

- Resume-after-restart (Decision 59) stops being special-cased logic living only in the boot path — it's the same function, called with whatever ground truth is available (possibly stale, bounded by last heartbeat, same trust check as today).
- Drift becomes an always-askable live comparison (resolver's calendar position vs. true wall-clock now), not a value snapshotted once per activation and frozen until the next one.
- The hard-segment lookahead (Decision 62) walks forward from this function's answer, not from a separately-tracked "current" pointer that could disagree with it.

Explicit design rule, carried over from Decision 63's single-source-of-truth philosophy and Decision 82's Decision 2: the playhead is never a column, never a Supervisor instance field kept in sync by convention — it's a function, called fresh, every time an answer is needed.

---

### Decision 84 — Plan lifecycle: add `Transitioning` and `Invalid`, split write-ownership, replace guard-field bookkeeping with idempotent requests

**Status: design decided 2026-07-14. Directly answers the Decision 80/81 guard-field audit; supersedes the in-flight-tracking half of Decision 82's Decision 2 with a concrete mechanism. Not yet implemented.**

Two new plan states:

- **`Transitioning`** — a plan whose first item has already been pushed into LiquidSoap's queue (the existing queue-ahead nudge, Decision 60) but has not yet been ground-truth-confirmed on air. This names a window that exists today but has no label — its absence is exactly what let Decision 78's activation-snapshot race happen (a snapshot taken mid-window, with no state boundary marking "this plan has one foot in the door"). Enters `Transitioning` at the queue-ahead push; exits to `active` at ground-truth confirmation (unchanged trigger from Decision 60).
- **`Invalid`** — a plan no longer trusted as ground truth, for either of two reasons, tagged with a `reason` string (mirroring the existing mandatory `reason` already required on every `plan_item`): `transition_failed` (a `Transitioning` plan's first item never got confirmed within a bounded window — reuse the same "how long is too long" judgment the silence alert already makes) or `restart_ambiguous` (Decision 83's playhead resolver comes back without enough confidence to say where the Supervisor really is, after a restart). Declaring a plan `Invalid` always immediately triggers a fresh Request Plan call (Decision 85) for that segment — the state is only useful if it drives recovery, not just a label.

Full state shape: `draft → finalized → Transitioning → active → completed`, with `Invalid` reachable as a side-exit from `Transitioning` or from restart hydration. `completed` keeps its existing meaning (retired on purpose — normal handoff or deliberate forced retirement); `Invalid` sits on a different axis entirely — retired because the state can no longer be trusted, not because the job is done.

**Write ownership, made an explicit rule rather than an emergent accident:**
- **Planner** is the sole writer of `draft → finalized` — it's the only thing that knows if content is actually ready.
- **Supervisor** is the sole writer of `finalized → Transitioning → active → completed / Invalid` — it's the only thing that hears ground truth from LiquidSoap.

**The actual fix for the guard-field class of bug (Decision 80's audit):** the root cause was never which field held which flag — it was that every flag existed because the Supervisor had to remember "did I already ask for this" in its own private memory, with no way to unstick a flag if the corresponding request silently failed (no `PLAN_DRAFT_FAILED`/`PLAN_FINALIZE_FAILED`/`PLAN_REPLAN_FAILED` message exists anywhere). The fix isn't adding failure events and a timeout to unstick a frozen flag — that approach was sketched and explicitly reverted in Decision 81 for being one more special case on the pile. The fix is removing the need to remember anything at all. **Every plan-lifecycle request becomes idempotent against the plan's own persisted state:** "give me a draft for this segment/clock-instance" is a no-op if a plan already exists for that exact occurrence (reusing the existing `resolution_identity` dedup key from Decision 58); "finalize this plan" is a no-op if it's already past `draft`. The Supervisor is free to ask as often as reality calls for it — every tick, if needed — because asking twice is harmless by construction. This removes the entire class of stuck-guard bugs (Decisions 77, 78, 80) rather than patching the next instance of it.

---

### Decision 85 — Universal Request Plan routine: one shared calculation, three decision contexts

**Status: design decided 2026-07-14. Formalizes and extends Decisions 62/69/71/73's separately-evolved mechanisms into one named routine. Not yet implemented.**

A single calculation — given Decision 83's playhead, computes `xh` (real time remaining before the next hard-start segment, walking forward across however many segments necessary, reusing Decision 62's existing `resolveNextHardSegment`) and `cs` (runway remaining in whatever segment is currently active) — backs three outcomes:

1. **`xh` below the worth-it threshold** → target the hard segment directly (the structurally-next segment is skipped entirely; it never gets a `plans` row, per Decision 62's existing behavior).
2. **`cs` above the same threshold** → correct the *current* segment (a mid-flight replan of the active plan), rather than deferring the correction to whatever comes next.
3. **Otherwise** → target the structurally-next segment, with the drift correction folded into its sizing.

**Both thresholds share one constant, not two independently-guessed numbers: 300 seconds** — reusing the value two separate parts of the system (Decision 62's lookahead, Decision 69's finalize re-check) already converged on independently through live incidents, rather than introducing new, untested placeholders for either branch. Candidate for an eventual station setting, following the same pattern as the drift-recovery cap (Decision 78).

**Drift correction is capped, not divided.** The correction applied to a segment's target is clamped to an absolute ceiling (the existing `MAX_DRIFT_RECOVERY_PER_PLAN_S`/`drift_recovery_cap_seconds`, Decisions 71/78) rather than computed as a fixed fraction of the outstanding drift. A cap needs no memory of "how much correction is still owed" — drift is always re-measured fresh from real facts (Decision 83's playhead vs. wall clock) at every evaluation, so whatever the cap leaves uncorrected simply reappears as drift next time, with no ledger to maintain.

**Branch 3's offset compounds two genuinely additive quantities, throttled together:** when the current segment's remaining runway (`cs`) was too small to be worth a mid-flight correction (branch 2 didn't fire), that small leftover sliver doesn't vanish — it's going to play out uncorrected regardless of what's decided next, so it behaves exactly like already-locked-in drift. The next segment's target folds in `(drift + cs)`, both under the same cap — not `drift` capped plus `cs` added afterward uncapped, since throttling only part of what's being corrected for defeats the point of throttling at all.

**Hard-boundary commitment takes precedence over ordinary drift correction.** If the active plan is already committed to reaching a hard boundary (branch 1's outcome, cached at the moment it was decided — Decision 66's `activePlanHardBoundary`), branch 2's mid-flight replan does not independently recompute or contest that; it defers to the boundary-reaching fill/trim mechanism (Decision 66) instead of chasing its own drift-derived target. This reads the cached decision rather than recomputing it, so it doesn't reintroduce a second independent belief about the same fact.

**Stop-sets bypass this entire routine.** A guard sits in front of all three branches: if the target segment is a stop-set, skip straight to "target = nominal," full stop — no drift offset, no `cs`-based correction (Decision 73, unchanged, already correct in production).

**Three calling contexts, not one universal call site that always evaluates all three branches:**
- **Plan activation** → only needs the `xh` check (branch 1 vs. branch 3) — the caller already knows it's asking "what comes next."
- **A runtime deviation** (operator skip/inject, live takeover ending) → only needs the `cs` gate (branch 2, yes/no) — the caller already knows it's asking "should I fix current."
- **Cold start, operator-triggered reconcile, or orphan-plan recovery** (Decision 88) → the only contexts with no prior triggering event to lean on, so the full three-way evaluation runs for real, starting cold from just Decision 83's playhead.

**Returns, per the original design intent:** `{plan_id, start_offset, length_offset}` — a normal request/response call, awaited inline at the point it's needed. Idempotency (Decision 84) is what makes it safe if the same request fires twice (a lost response, a race, a restart mid-request) — it is not a reason to avoid waiting for the answer in the first place.

---

### Decision 86 — Two-phase gate consistency by construction: finalize re-invokes Request Plan, it does not re-derive its own logic

**Status: design decided 2026-07-14. Resolves the root cause behind Decisions 68 and 69 (a stop-set floor enforced at draft but forgotten at finalize; hard-segment adjacency checked at draft but never re-checked at finalize) and Decision 67's finding that draft and finalize used different formulas for the same target. Not yet implemented.**

Both historical bugs happened because draft and finalize computed "what should this segment's target be" via two separately hand-written pieces of logic that started out equivalent and drifted apart as one got a fix the other didn't. **Fix: finalize does not compute a target any other way than calling Decision 85's Request Plan routine again**, with whatever the playhead/drift/runway looks like at finalize time (which may differ from draft time). Every rule Request Plan applies — the stop-set guard, the hard-boundary precedence, the cap — is automatically reapplied, because it's the same code path re-executing, not a second implementation that has to be remembered to stay in sync with the first.

What remains genuinely finalize-specific, and is not a gate-consistency question: comparing the fresh answer against what's already been assembled, netting out content that's already irreversibly committed (pushed to LiquidSoap, Decision 67's `committedSeconds` fix) before deciding whether the gap between assembled and target content is small enough for lightweight substitution or large enough to warrant a full reassembly. That comparison-and-reconcile logic stays; only the target-computation logic gets unified.

This also means mid-flight replanning (Decision 85's branch 2, current-segment correction) is the same call site, not a third implementation — draft, finalize, and replan are one mechanism, invoked at three different moments, rather than three things that must be kept consistent with each other by discipline.

---

### Decision 87 — Fill/skip is a tactical target-chasing tool, not a drift-recovery lever

**Status: design decided 2026-07-14. Clarifies the relationship between `catching_up_order`/`coasting_order` (Decision 27) and drift correction (Decision 85) as the design matured. Not a rule change to the underlying content-selection logic (Decision 27) — a clarification of intended usage going forward.**

Fill/skip plays three distinct, narrower roles, none of which decide "how much drift to correct":

1. **Ordinary gap-filling during plan assembly** (Decision 8) — unrelated to drift, present even when drift is zero; makes one segment's assembled content match *its own already-decided target*.
2. **Precision boundary-reaching** (Decision 66's fill/trim gate) — closes the last stretch of gap between what's airing and a boundary it needs to hit, only after Decision 85 has already set the target; a fine-tuning instrument, not a strategic decision.
3. **Reactive correction for runtime deviations** (Decision 8's deviation monitor — operator skip, manual inject, live takeover ending) — realigns already-built content with a target that was already decided; it does not re-decide the target itself.

**Explicit rule going forward: fill/skip must never be triggered directly by the raw wall-clock drift number.** It should only ever respond to a local gap — how far the content already built is from the target Decision 85 already committed to. Decision 85's hard-boundary-precedence rule is the first application of this discipline; any future fill/skip logic that reaches for raw drift instead of a local target-vs-actual comparison is a regression to the pre-Decision-85 mental model and should be caught in review.

Also confirmed and left unchanged, as orthogonal to drift entirely: a stop-set's own small content-fit overshoot tolerance (Decision 73 — spot/promo durations don't always sum exactly to a target) and the campaign-pacing-driven recovery multiplier that can lengthen a stop-set (Decisions 74/75 — driven by monthly ad-inventory math, not wall-clock schedule drift).

---

### Decision 88 — LiquidSoap-restart detection via process pid; cold start, orphan recovery, and LS-restart recovery unify into one path

**Status: design decided 2026-07-14, extending Decision 82's confirmed-buildable `process.pid()` finding into a concrete mechanism. Not yet implemented.**

**The gap:** no mechanism exists today to detect that LiquidSoap itself restarted while the Supervisor process kept running — confirmed by code survey, not just absence of a doc reference. This is distinct from a Supervisor-process restart (Decision 59/84's `Invalid`/resume handling) — here the Supervisor's own beliefs are intact, but LiquidSoap came back up with an empty queue and nothing playing underneath it.

**Fix:** `process.pid()`, captured once at LiquidSoap script load, rides on every webhook payload (`on_track`, `on_end`) and every query response (`/live-status`, the new `/now-playing` from Decision 82), rather than depending on one dedicated "just booted" notification (which could itself be lost in exactly the startup race this is meant to catch). The Supervisor remembers the last pid it saw; any arrival carrying a different one is unambiguous, retroactive proof of a restart, caught by the next ordinary event even if a dedicated boot signal is missed.

**On detection:** treat it exactly like `Invalid`/no-confident-ground-truth (Decision 84) and immediately re-run Decision 85's full cold-start three-way evaluation — do not trust whatever the Supervisor currently believes is playing or queued. Since a freshly-restarted LiquidSoap has nothing queued, this should trigger an immediate push, rather than waiting on the existing minutes-scale silence alert to eventually notice.

**Also fixed in the same pass, since it's the same "ask reality, not a shadow belief" principle:** the queue-depth cap ("at most 1 playing + 1 pre-queued") is enforced today by counting `plan_items` marked `'playing'` in the Supervisor's own database, not by querying LiquidSoap's actual queue. If that count is ever wrong, an extra push doesn't error — it just sits appended in the real queue and plays later, confusing plan activation well after the fact (confirmed real risk, not hypothetical, per Decision 82's findings). Once `/now-playing` exposes `queue()`/`length()` directly, the cap should be enforced against that, not the internal count.

**Confirmed still open, not part of this decision's scope:** whether `live-started`/`live-ended` webhooks actually fire in production — the receiving-side handling exists, but nothing in the generated LiquidSoap script appears to wire `input.harbor`'s connect/disconnect callbacks to trigger them (Decision 82's finding, unconfirmed by live testing). Worth verifying directly against the running instance before or during implementation, not a design question to resolve here.

---

### Decision 89 — The tick loop collapses to a heartbeat plus one reality-check-and-dispatch; nearly everything else becomes event- or timer-triggered

**Status: design decided 2026-07-14. This is the concrete mechanism Decision 82's Decision 1 called for but didn't fully specify. Not yet implemented.**

Today's `tick()` runs roughly a dozen independently-polled concerns every 500ms, almost all assumption-based (arithmetic on stored timestamps, never a live check against LiquidSoap). The redesigned loop:

**What stays periodic:** a heartbeat write, plus one reality check — query `/now-playing` (Decisions 82/88), compare against Decision 83's playhead resolver, and dispatch to exactly one outcome if they disagree: push (queue starved), correct the current plan (Decision 85 branch 2), or run the LS-restart recovery path (Decision 88). If they agree, do nothing.

**Recommended interval: 3 seconds**, operator-configurable in a 1–10 second range (following the same hardcoded-constant → `station_settings` column → settings-page field pattern as the drift-recovery cap, Decision 78). The check itself is near-free (a single local HTTP call, sub-5ms per Decision 82's own testing), so the interval should be chosen purely by "how much genuine dead air is tolerable before the safety net notices a silent failure," not by any resource-cost tradeoff. 3 seconds is a 10x improvement over today's 30-second first silence-alert threshold, without trying to compete with the sub-100ms event-driven path that already handles all normal operation.

**Moved out of the periodic loop, now event- or timer-triggered:**
- Segment/plan transition bookkeeping and next-plan drafting — already activation-triggered today (Decision 61), unchanged.
- The T-30s finalize gate — becomes a one-shot timer scheduled at the moment a plan activates (its expected end time is known then); rescheduled only if a later replan changes that expected end time. No more per-tick "is it T-30s yet" comparison.
- The hard-start fill/trim gate (Decision 66) — re-evaluated at every track-started/track-ending event, the only moments new information about consumed runway actually exists, rather than on a fixed interval regardless of whether anything changed.

**Cold start, orphan-plan recovery, and LS-restart recovery stop being three separate special-case code paths.** All three are the same underlying situation — the Supervisor has no confident belief about what's currently happening — and all three are now just the reality check's first comparison finding a mismatch ("nothing is happening, and something should be"), dispatching to Decision 85's full three-way cold-start evaluation. There is no dedicated cold-start branch anymore, no dedicated orphan-recovery branch; one mechanism, three ways of arriving at the same starting condition.

---

### Decision 90 — Boundary drift is measured from the activated plan's own scheduled bounds; the hand-carried reference dies

**Status: decided 2026-07-16. Root-cause fix for the phantom drift readings observed live 2026-07-15 (sawtooth −1261…+1336 within minutes, physically impossible as real lateness).**

At activation, boundary drift was computed against a remembered scalar (`nextPlanScheduledEndMs`) that only the ordinary draft-request path ever set. Every other activation path — adopted existing drafts (`DRAFT_SKIPPED_EXISTING`), reconcile-created plans, restarts (never rehydrated), empty-plan skip cascades, exhausted-plan advances — left it null or stale, and the fallback used the *outgoing* segment's end as if it were the incoming segment's. For adjacent segments that inflates measured drift by exactly +nominal(incoming) in one step. Live log values match this signature precisely (+722 on an 840s-nominal segment ≈ real −118 + phantom 840).

**Fix:** `activatePlanById` already resolves the activated plan's own segment bounds (`resolveActivePlanSegment`, Decision 61) for bookkeeping. Boundary drift is now derived from that same resolution — `(activatedAt − segmentStartMs) / 1000` — and the `nextPlanScheduledEndMs` field, its fallback chain, and every site that maintained it are deleted. There is no scenario in which the plan's own scheduled start is the wrong reference: it is by definition the schedule slot this plan was built for. If the segment no longer resolves (deleted mid-flight), drift keeps its previous value and the existing `ACTIVATE_PLAN_SEGMENT_UNRESOLVED` warning covers it.

Also fixed under the same "report reality, not bookkeeping" principle: `SEGMENT_SUMMARY.actual_duration_seconds` now sums real airtime from `play_history` (`ended_at − started_at`, confirmed rows; planned duration only as fallback for unconfirmed rows) instead of summing planned durations and calling them actual.

---

### Decision 91 — Predicted boundary lateness replaces the drift-credit ledger

**Status: decided 2026-07-16. Completes Decisions 83/85; removes the `plannedOvershootSeconds` term from target sizing and with it the sign-inverted abandoned-plan credit shipped in c8e47fc.**

The first-pass formula `nominal − (boundaryDrift + plannedOvershoot)` tried to *predict* lateness at the next boundary by summing two snapshots taken at activation. Every event after activation — mid-flight replans, top-ups, hard-start fills, skipped empty segments, stalls — invalidated the snapshots, and each got (or needed) its own hand-maintained credit. The abandoned-plan credit added 2026-07-15 had an inverted sign: skipping a segment makes the station arrive *early* at what follows, but the credit shrank the next plan as if it were arriving late — provably inconsistent with the force-activated-empty-plan path, which computes the same physical event with the opposite sign.

**Fix: predicted lateness is derived fresh at the moment it's needed, never carried:**

```
predicted_drift(next) = (now + estimated_remaining(active_plan)) − scheduled_start(next segment)
```

`estimated_remaining` is the existing Decision 66 accounting (confirmed elapsed time on the airing item + pending planned durations). `scheduled_start` comes from the target segment's own resolved bounds. Both inputs are ground truth at call time, so every scenario is automatically accounted with no ledger:

- **Skipped empty stop-set:** active plan's content ends ≈ at the stop-set's scheduled start, so predicted drift vs. the *following* segment is ≈ −nominal(stop-set) — the next plan is sized longer by exactly the hole, and the hour re-lands on schedule.
- **Mid-flight replan/top-up/fill:** `estimated_remaining` re-reads the plan's actual current content; nothing to credit.
- **Stall/dead air:** `now` advances; the prediction moves with it.

`plannedOvershootSeconds` remains as an observability value (status page) but no longer participates in sizing. The T-30s finalize gate re-derives the same prediction fresh (Decision 86 — same routine, later moment); its reassembly trigger compares the fresh target against assembled content exactly as before. Drift-delta between draft and finalize is now `predicted_at_finalize − predicted_at_draft`, same semantics, honest inputs.

---

### Decision 92 — Correction authority: comfort band below a threshold, full authority above it; fill texture rule; cut only what is genuinely on air

**Status: decided 2026-07-16. Extends Decisions 71/78/85/87; supersedes the fixed 0.6–1.4× proportional clamp as the only regime. Operator requirement: organic drift stays within ~±200s, and any |drift| > ~100s is corrected to near zero by the very next plan.**

**Two regimes, one formula.** `correction = clamp(predicted_drift, ±drift_recovery_cap_seconds)` as today (Decision 71/78). Then:
- `|correction| ≤ drift_full_authority_threshold_s` (new `station_settings` column, default 100, Scheduling settings page): target = `clamp(nominal − correction, [0.6×, 1.4×] nominal)` — the familiar comfort band; at ≤100s the band almost never binds.
- Above the threshold: target = `max(30, nominal − correction)` — the plan is allowed to shrink far below the comfort floor (or grow up to nominal + cap), because at that magnitude landing the boundary matters more than one segment's fullness. Planning remains the *only* strategic recovery mechanism (Decision 87 unchanged); no segment skipping, no wall-clock realignment lever.

**Stop-sets still bypass entirely** (Decision 73): target = nominal, correction = 0. `applied_correction` is recorded as `nominal − target` (what was actually applied after all clamps), fixing the old reporting flaw where the pre-clamp value was recorded.

**Fill texture rule (extends Decision 70 from one pair to the general principle).** Music is the fabric; promo/station-ID/jingle are single stitches. In every fill path: never two items of the same non-music type adjacent (no promo→promo), never three non-music items in a row (promo→ID is the ceiling; then music must intervene). Spots are never fill/skip material in any path (contractual — `mandatory` + Decision 36 defaults already say so; the texture rule is planner-side placement discipline on top). Stop-set internal assembly is exempt — consecutive spots/promos are the normal sound of an ad break.

**Fill/skip policy is station-wide, not per-segment.** The per-segment `catching_up_order`/`coasting_order` lists (Decision 27) are retired from all drift-adjacent paths — confirmed by code survey: `catching_up_order` was never read anywhere, and `coasting_order` only drives rundown-segment content fill, which it remains scoped to (that use is content assembly, not drift). Eligibility lives in `supervisor_config`'s per-content-type cut/skip columns (Decision 36), which already encode the operator's rules: music unrestricted, promo/ID/jingle skippable-not-cuttable, spots and envelopes untouchable.

**Cut only what is genuinely on air.** The hard-start trim treated any `status='playing'` item as on-air, but queue-ahead marks an item 'playing' at *push* time — so the trim could mark a pre-queued item skipped while `queue.skip()` cut whatever was actually airing (potentially a mandatory spot), corrupting drift accounting and billing at once. Fix: an item is on-air iff its `play_history_id` equals the supervisor's confirmed `current_play_history_id`. Pre-queued items are committed content — LiquidSoap's queue can't be unpushed — so the trim leaves them alone and only skips genuinely `pending` items or cuts the genuinely airing one.

---

### Decision 93 — The drift ledger lives on `plans`; the Supervisor page shows the whole measure→correct→predict loop

**Status: decided 2026-07-16. Implements the operator requirement "I want to look at the supervisor page and see how the algorithm works and how it recovers drift."**

The `plans` table gains the sizing story as first-class columns, written by the planner at draft/finalize (values computed by the Supervisor and carried on the existing bus messages) and by the Supervisor at activation:

```sql
ALTER TABLE plans ADD COLUMN nominal_duration_seconds real;    -- segment nominal at draft time
ALTER TABLE plans ADD COLUMN target_duration_seconds real;     -- what the plan was sized to (finalize overwrites draft)
ALTER TABLE plans ADD COLUMN predicted_drift_seconds real;     -- Decision 91 prediction that sizing responded to
ALTER TABLE plans ADD COLUMN applied_correction_seconds real;  -- nominal − target, post-clamp truth
ALTER TABLE plans ADD COLUMN boundary_drift_seconds real;      -- measured at activation (Decision 90)
ALTER TABLE plans ADD COLUMN activated_at integer;             -- unix ms
```

Every activated plan is thereby one ledger row: *we predicted X, sized the plan to nominal−Y, and actually arrived Z late* — no log archaeology. A new `GET /supervisor/v2/drift-ledger` returns the last N activated plans joined with segment name/type; `/supervisor/v2/status` additionally reports the live prediction for the active plan's next boundary and the next plan's recorded sizing.

The Supervisor page gains a **Drift recovery panel**: measured boundary drift per transition over the last hours (chart), each row showing measured → correction applied to the following plan → predicted landing, plus a live "predicted arrival at next boundary" figure. The acceptance criteria become directly observable: the chart should show a sawtooth bounded by roughly ±one track length around zero, and any excursion past 100s should return to near zero within one transition.

---

## Build Plan — Locked 2026-05-27

Six phases. Optimized for clean code and developer efficiency — no compatibility with V1 during construction, no safety fallbacks until the feature is actually built.

### Phase 1 — Teardown + Infrastructure

Delete V1 entirely on day one. No telnet, no legacy supervisor code, no compatibility shims.

**Tasks:**
- Delete the entire `apps/api/src/services/supervisor/` directory (TelnetClient, scheduler, picker, metadataWatcher, stopSetPicker, snapshot, predictor, clockResolver)
- DB migrations: `plans`, `plan_items`, `stop_set_estimates`, `supervisor_state`, `live_events`; add `plan_item_id` FK to `play_history`
- `bus.ts` — EventEmitter wrapper with typed message discriminants; Level 1 implementation
- LS script — add harbor HTTP endpoints (`/push`, `/queue`, `/skip`) + webhooks (`on_track`, `on_end`) with `thread.run` wrapping
- `HarborClient` — stateless `fetch()` wrapper; replaces TelnetClient
- Webhook receiver routes: `POST /internal/ls/track-started`, `POST /internal/ls/track-ending`
- Process module stubs: empty classes with correct bus interface, no logic yet

**Milestone:** No V1 code anywhere. LS speaks harbor. Webhook routes receive and log events. `pnpm type-check` passes.

---

### Phase 2 — Content Processes

All four processes are independent and implement the same protocol. Build in any order.

**Protocol every content process implements:**
`REQUEST_CANDIDATES` → return pool (no state change) → `CONFIRM_USED` → update state → `RETURN_UNUSED` / `DROP_COMMITTED`

**Tasks:**
- **Music process** — rotation pool, hot-play injection cadence, heavy rotation / music campaign pacing
- **Campaign process** — eligible spot + promo candidates, pacing at global / per-show / per-interval, break space estimate computation
- **Branding process** — jingle pool, station ID pool, segment/show envelopes; round-robin and random only
- **Rundown process** — reads calendar-assigned news/bulletin clips, returns ordered list + gap estimate

**Milestone:** All four processes respond correctly to `REQUEST_CANDIDATES`. No side effects before `CONFIRM_USED`. Verified via unit tests against the bus (LS not required).

---

### Phase 3 — Planner

Consumes content process pools, assembles plans, writes to SQLite.

**Tasks:**
- Draft plan at segment start; finalization pass 30–60s before boundary
- Music segment assembly: rotation sequence + branding interstitials + gap fill via `coasting_order`
- Stop-set assembly: advertiser separation, competing exclusions, first-in-slot competition, slot-1 per-day relaxation
- Rundown segment assembly: mandatory rundown items first, gap fill second
- `stop_set_estimates` insert + upsert at finalization
- Every `plan_item` gets a `reason` string — mandatory
- Offline operation: planner runs without LS

**Milestone:** Given a segment type + duration, Planner produces correct `plan` + `plan_items` in SQLite with reasoning strings. Verified via offline tests.

---

### Phase 4 — Supervisor + Queue Feeder + Drift

The execution layer. Wires everything together.

**Tasks:**
- Supervisor outer loop: receives `on_track` / `on_end` webhooks; tracks segment boundaries; drives Planner at segment start and 30–60s before boundary
- Queue Feeder: `on_end`-triggered, reads next `pending` plan_item, `POST /push` to harbor, queue depth = 1
- Drift accumulation: `drift_seconds` updated on each `on_track` against `planned_start_at`
- `catching_up_order` correction: skip pending items by content type, re-evaluate after each drop
- `coasting_order` correction: request short candidate with `max_duration_seconds = gap − 2s`, inject, re-evaluate
- Replan drive: signal Planner to rebuild remaining segment when drift exceeds threshold
- Live takeover: suspend queue feeding on live connect webhook; replan on disconnect; write to `live_events`

**Milestone:** Station plays a fully planned schedule. Supervisor handles operator skips and drift. Logs show per-event reasoning and drift values with structured fields.

---

### Phase 5 — Operator Visibility UI

**Tasks:**
- Active plan list: current + next segment items (content type, title, planned duration, status, reason)
- Drift panel: running `drift_seconds`, trend indicator, next correction action when over threshold
- Campaign pacing dashboard: target vs. actual per campaign, pacing score, projected end-of-day
- Process health panel: last heartbeat per process, LS harbor last-success timestamp
- Supervisor log feed: structured log tail, filterable by event type and process

**Milestone:** Operator can observe the engine's reasoning and state in the web UI without opening log files.

---

### Phase 6 — Dry Run

**Tasks:**
- Planner runs over a synthetic future window advancing time without LS
- Simulated pacing state carries forward between segments
- `sim_plans` / `sim_plan_items` tables tagged with `simulation_id`
- API: `POST /simulation {start_at, end_at}`
- UI: timeline view with per-segment drill-down and pacing projections; oversubscribed breaks highlighted

**Milestone:** Operator can preview 24 hours of scheduling before it airs, with per-item reasoning and projected campaign pacing.
