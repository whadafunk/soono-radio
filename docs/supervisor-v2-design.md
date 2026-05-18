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

- **Operator modification of the draft plan.** If an operator modifies the draft via the UI, how that write reaches the planner process (bus message, or planner polls SQLite on finalization pass).
- **`catching_up_order` / `coasting_order` exact semantics.** Schema exists and is now actionable — exact values and how the deviation monitor maps them to replan instructions to be designed during implementation.
- **`stop_set_estimates` persistence.** Whether the space estimate is written to its own table or embedded in the `plans` table — to be decided at implementation.
