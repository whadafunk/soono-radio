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

**Status: decided — 2026-05-28**

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
