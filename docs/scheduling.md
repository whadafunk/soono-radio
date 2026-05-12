# Scheduling System

This is the most complex part of the project. Read this before touching anything in `apps/api/src/services/supervisor/` or the clocks/schedule UI.

## Mental Model

A **Clock** is a named hour template — an ordered list of segments. Each segment says: "play this type of content, from this source, for this long." The Supervisor executes the clock in real time, pushing tracks to LiquidSoap to fill each segment.

The schedule decides *which* clock runs at any given time. The clock decides *what* plays within that time. The supervisor makes it happen.

---

## Clocks & Segments

### Clock
A reusable template, e.g. "Morning Drive Standard", "News Heavy Hour", "Overnight Music".

Fields:
- `name` — operator-visible label
- `sweep_config` (JSON) — config for sweep overlays (see Sweeps section below)

### Clock Segment
An ordered slot within a clock. Fields:

| Field | Type | Purpose |
|-------|------|---------|
| `sort_order` | int | Position in clock (0-based) |
| `duration` | int (seconds) | How long this segment should run |
| `type` | enum | `music`, `commercial`, `jingle`, `promo`, `news`, `live`, `silence` |
| `source_type` | enum | Where to get content (`show_playlist`, `rotation`, `campaign`, `live_input`, `media`) |
| `source_id` | int? | FK to the specific source (show_playlist_id, rotation_id, etc.) |
| `filler_sources` | JSON | Ordered fallback sources if primary is exhausted |
| `fallback_source` | JSON | Last-resort source (e.g. generic music rotation) |
| `start_policy` | JSON | How this segment starts relative to whatever is currently playing (see below) |
| `end_policy` | enum | Whether this segment can be cut short: `fixed` or `flexible` (see below) |
| `recovery_tactics` | JSON | Ordered tactics for recovering drift on flexible-end segments (see below) |
| `start_clip_id` | int? | Media to play at segment start (e.g. "and now the news...") |
| `end_clip_id` | int? | Media to play at segment end (e.g. stinger) |
| `bed_id` | int? | Background audio for live segments |
| `blocks_live_override` | bool | Prevents DJ takeover during this segment (e.g. hard news) |

## Sweeps — Overlays, Not Segments

**Critical distinction:** A sweep (jingle, promo, spot) plays DUCKED OVER currently running base content. It is NOT a segment break — it's an overlay using LiquidSoap's ducking mechanism. Configured at the clock level via `sweep_config`:

```json
{
  "per_hour": 3,
  "over": ["music"],
  "min_gap_minutes": 8,
  "sources": ["jingle", "promo", "spot"]
}
```

This means sweeps don't interrupt the segment timeline. A music segment keeps running; the sweep audio plays on top, ducking the music.

---

### Example Clock: Morning Drive

```
sort  type        source         duration  start_policy    end_policy
  0   jingle      show_jingles   30s       hard            flexible
  1   music       hot_tier       480s      soft ±30s       flexible
  2   commercial  campaigns      180s      hard            fixed
  3   news        live_input     120s      hard            fixed
  4   music       medium_tier    480s      soft ±30s       flexible
  5   jingle      show_jingles   30s       soft ±15s       flexible
  [repeat 1-5 until clock end]
```

---

## Schedule Resolution

When the Supervisor needs to know "what clock runs right now?", it resolves in this priority order:

### 1. Calendar Entry (highest priority)
Specific date override: `calendar_entries` table. If today matches a calendar entry's date and current time falls in its time range, use that entry's `clock_id` (or `show_id` → show's `default_clock_id`).

### 2. Template Clock Entry (hourly override)
`template_clock_entries` table maps `(day_of_week, hour)` → `clock_id`. If the current day+hour has an entry, use that clock.

### 3. Template Entry (weekly default)
`template_entries` table maps `(day_of_week, time_start, time_end)` → show or clock. Use the show's `default_clock_id`.

### 4. No match → silence / fallback
If nothing matches, the supervisor idles (no pushes) or uses a configured fallback.

---

## The Supervisor

Three processes run inside the Supervisor, all polling on timers:

### scheduler.ts — Queue Manager

Runs every `scheduler_tick_ms` (default 5000ms).

```
1. Telnet → LS: request auto.queue
2. Parse queue depth (number of pending requests)
3. If depth < queue_depth_threshold (default 1):
   a. Call picker.pickNext() → { media, reason }
   b. INSERT play_history row → get row id
   c. Telnet → LS: auto.push annotate:play_history_id="<id>":/media/<sha>.mp3
4. Record LS request id against play_history row
```

**Why keep queue depth shallow (1)?**
To minimize latency for live DJ takeovers. If 3 tracks are queued, the DJ has to wait through them. With depth=1, LiquidSoap starts the next track almost immediately after the current one ends.

### picker.ts — Track Selector

Current implementation (Phase 1 — basic):
```
1. Load all media WHERE category = 'music'
2. Load recent play_history rows within last separation_minutes
3. Exclude media_ids in recent history
4. Random pick from eligible set
5. Return { media, reason: "random pick separation=30min eligible=47/200" }
```

**Future implementation** will integrate clocks:
1. Resolve current clock segment
2. Determine source type (show_playlist, rotation, campaign)
3. Apply rotation algorithm (LRP, weighted, round_robin, etc.)
4. Apply tier fallback (hot → medium → cold)
5. Apply campaign pacing constraints
6. Apply separation constraints per rotation config

### metadataWatcher.ts — Play History Tracker

Runs every `metadata_poll_ms` (default 5000ms).

```
1. Telnet → LS: live.status
2. If live connected AND was auto:
   - Close current auto play_history row (aborted=true)
   - Open new live play_history row (source='live', media_id=null)
3. If live disconnected AND was live:
   - Close live row
4. Regardless:
   - Telnet → LS: request.on_air
   - Telnet → LS: request.metadata <request_id>
   - Parse play_history_id from annotation
   - If changed from previous:
     - Close previous row (ended_at=now, aborted = played_pct < 0.95)
     - Update current row: started_at = actual on_air time, listener_count
```

**Why two timestamps?** `recordPushed()` stamps the queue push time. `recordStarted()` stamps the actual airtime (which differs when LS crossfades or when a track was queued long ahead). Accurate airtime is needed for delay measurement.

### Boot Recovery (supervisor/index.ts)

On startup, stale open play_history rows may exist (process crash, restart):
```
1. Telnet → LS: fetch all alive request IDs currently in queue/playing
2. For each alive request: fetch metadata → extract play_history_id annotation
3. Call closeStaleOpenRows(liveIds)
   → For any open play_history row whose ID is not in liveIds:
      set ended_at=now, aborted=true
```

This prevents ghost rows from accumulating across restarts.

---

## Delay Policy

Each segment has two independent timing properties:

### start_policy — how this segment begins

```typescript
type StartPolicy =
  | { type: 'hard' }
  | { type: 'soft'; plus_seconds: number; minus_seconds: number }
```

**hard** — Cut whatever is currently playing at the scheduled time. No waiting. Used for: commercial breaks, news, top-of-hour stingers. The incoming segment's start_policy is what drives the cut — the outgoing segment doesn't decide this.

**soft** — Wait for the current event to reach a natural end point, within the ±window. If `minus_seconds` allows, can fire early if a natural cue point falls within that window (gap is filled from filler_sources).

### end_policy — whether this segment can be interrupted

```typescript
type EndPolicy = 'fixed' | 'flexible'
```

**fixed** — This segment cannot be cut short. The events playing inside it must complete. Used for: commercial blocks (paid, contractual), news, live segments. When the next segment has `start_policy: hard`, see the look-ahead algorithm below.

**flexible** — This segment can be trimmed or cut by the next segment's start_policy. Used for: music blocks, jingles, promos.

### Typical combinations by segment type

| Segment type | start_policy | end_policy |
|---|---|---|
| Commercial break | hard | fixed |
| News | hard | fixed |
| Live segment | hard | fixed |
| Music block | soft | flexible |
| Jingle | hard or soft | flexible |
| Promo | soft | flexible |
| Silence | hard | flexible |

---

## Look-ahead Algorithm (Fixed-End Segments)

The collision between `fixed` end and `hard` start is resolved **proactively**, not reactively.

When the scheduler is inside a `fixed` end segment and is about to queue the next event (e.g. a 60s spot), it first checks whether the event fits:

```
remaining_time = segment_end - now
candidate_duration = next_event.duration

if candidate_duration > remaining_time:
    skip this event
    pick something from filler_sources that fits
    if nothing fits: leave gap (silence)
```

This means:
- The `fixed` segment never gets a mid-event cut
- The next segment's `hard` start fires on time because the gap is already clean
- The collision never happens at runtime — it's prevented at queue time

**What fills the gap:** `filler_sources` on the segment — ordered list of shorter content (jingles, promos, shorter spots). The scheduler tries each in order, picking the longest one that still fits.

**Fit threshold:** Whether a candidate event needs to fit entirely, or can slightly overrun into soft-start territory, is configurable. Default: must fit entirely.

---

## Recovery Tactics (Flexible-End Segments)

When a `flexible` end segment is running behind and the next segment's `start_policy` is `hard`, recovery tactics are applied in order until the clock catches up:

```typescript
type RecoveryTactic = 'trim_outro' | 'skip_song' | 'drop_queued'
```

**trim_outro** — Shorten the current track using its `cue_out_seconds`. Fades out early. Least disruptive.

**skip_song** — Abort the current track and move to next pick.

**drop_queued** — Flush the entire LiquidSoap queue and re-pick fresh. Nuclear option.

Recovery should be **gradual** — trim a few seconds across several songs, not drop a whole song at once. The system should track and report drift history per clock so operators can identify structurally misaligned clock templates.

Tactics stored as ordered array on the segment:
```json
["trim_outro", "skip_song", "drop_queued"]
```

Note: recovery tactics are irrelevant on `fixed` end segments — the look-ahead algorithm handles those proactively.

---

## DJ Console: Two Timelines

The console (not yet built) operates on two independent timelines:

```
Segment timeline:  [music] → [commercial] → [music] → [news] → ...
                       ↑ here

Event timeline:    [song A 3:45] → [song B 4:12] → [song C 3:58] → ...
                                       ↑ here (2:14 / 4:12)
```

**DJ actions:**

| Action | Operates on | Description |
|--------|-------------|-------------|
| `hold` | Segment | Freeze segment succession; runs until manually released |
| `skip_to_next_segment` | Segment | Transition to next segment immediately |
| `skip_to_next_event` | Event | Jump to next track within current segment |
| `skip_to_selected_event` | Event | Jump to specific queued track |
| `natural_*` modifier | Either | Wait for current track's natural end first |

**Natural toggle**: persistent session ON/OFF preference (not a per-action dialog). When ON, all skip actions wait for track end. Avoids dialog fatigue mid-broadcast.

**Hold rules**: Only available on `soft` and `postpone` segments. Hard-cut segments cannot be held. Console shows a warning 2 minutes before a hard-cut segment fires.

**Lookahead**: Console shows next 2–3 events in current segment and next 1–2 segments.

---

## Intro/Outro — Show Lifecycle Events

`show.intro_media_id` and `show.outro_media_id` are NOT clock segments. They are one-time show lifecycle events:
- Supervisor plays intro once at show start, outro once near show end
- For multi-hour shows: intro/outro fire once regardless of how many clock hours run
- If live harbor connects mid-intro: live overrides and intro is skipped

---

## Rotation Algorithms

Used by clock segments with `source_type = 'rotation'` or `source_type = 'show_playlist'`.

| Algorithm | Behaviour | Config Params |
|-----------|-----------|--------------|
| `random_separation` | Random pick, min gap before repeat | `separation_minutes`, `artist_separation_minutes` |
| `least_recently_played` | Always pick the track played longest ago | `pool_size` (optional limit) |
| `round_robin` | Sequential cycle through playlist | `order_by`: added_date / title / artist / manual |
| `weighted` | Random with probability proportional to track weight | (none — uses `playlist_media.weight`) |
| `campaign` | Ad distribution with pacing constraints | `distribution`: even_spread / priority_first / pacing |
| `smart` | Separation + artist + tempo/energy rules | (future — not yet in schema) |

---

## Tier-Based Show Playlists

Shows associate multiple playlists with rotation tiers:

```
Show "Morning Drive"
  ├── hot tier    → Pop Hits playlist   (rotation: random_separation 30min)
  ├── medium tier → Classic Hits        (rotation: least_recently_played)
  └── cold tier   → Deep Cuts           (rotation: round_robin)
```

Each tier has a `fallback_tier`. When a tier's playlist is exhausted or all tracks are in separation, the picker falls back to the next tier.

The clock segment specifies which tier to draw from. Common pattern:
- Segment A: hot tier (plays ~80% of the time in practice)
- Segment B: medium tier (explicit medium-tier slot in clock)

---

## Weighted Multi-Source Selection (Music Segments)

A music segment's `sources` field is an array of source entries, each with an optional `weight`:

```json
[
  { "type": "show_playlist", "tier": "hot",    "weight": 60 },
  { "type": "show_playlist", "tier": "medium", "weight": 30 },
  { "type": "promos",                           "weight": 10 }
]
```

**How it works at pick time:**
1. Sum all weights → 100 in the example above
2. Roll a weighted random → e.g. 0–59 picks "hot", 60–89 picks "medium", 90–99 picks a promo
3. Ask the chosen source's rotation algorithm for the next eligible track
4. If that source has no eligible track (all tracks blocked by separation or exhausted), fall back proportionally to the remaining sources and retry

This gives operators blended output without strict sequencing — a segment plays mostly hot rotation but surfaces medium picks and the occasional promo in proportion to the configured weights.

**Stop sets do not use weights.** The `stop_set` segment type combines all its sources (campaigns, promos, playlist) into a single eligibility pool and selects from it using priority and pacing rules, not weighted random draws.

> **TODO — picker.ts implementation:**
> The weighted multi-source draw is designed and fully represented in the schema and UI (`sources` array with `weight` fields on music segments), but **not yet implemented in `picker.ts`**. The current picker ignores clocks entirely (Phase 1: flat random-with-separation). The clock-aware picker must:
> 1. Resolve which clock segment is active at the current time
> 2. For music segments: apply the weighted draw across `sources`
> 3. Per source: call the appropriate rotation algorithm (LRP, random-separation, round-robin, weighted)
> 4. Apply tier fallback if the chosen source is exhausted
> 5. For stop sets: build a combined pool from all sources, apply campaign pacing, enforce advertiser separation
>
> See Implementation Status table below.

---

## Supervisor Config

File: `data/supervisor-config.json`

```json
{
  "scheduler_tick_ms": 5000,
  "metadata_poll_ms": 5000,
  "queue_depth_threshold": 1,
  "separation_minutes": 30,
  "mid_hour_handoff": "finish_clock"
}
```

`mid_hour_handoff` — what to do when a clock boundary falls mid-track:
- `finish_clock` — let the current track finish, then switch clocks
- (future: `hard_cut`, `crossfade`)

API: `GET /supervisor/config`, `POST /supervisor/config`, `POST /supervisor/restart`

---

## Implementation Status

| Component | Status |
|-----------|--------|
| Clock + segment schema (v3) | Done — `sources[]`, `trailing_time[]`, `start_policy`, segment types: music/live/live_audience/stop_set/news/voice_track/bulletin |
| Clock editor UI | Done — accordion drawer, multi-source editor, per-type defaults |
| Schedule template + calendar | Done |
| Supervisor scheduler (push loop) | Done |
| Supervisor metadataWatcher | Done |
| Boot recovery | Done |
| Picker: random with separation | Done |
| Picker: clock-aware (segment resolution) | **TODO** |
| Picker: weighted multi-source draw (music) | **TODO** — schema/UI done; picker.ts not implemented |
| Picker: stop set pool + campaign pacing | **TODO** |
| Picker: rotation algorithms (LRP, round-robin, weighted) | **TODO** |
| Picker: tier fallback | **TODO** |
| Look-ahead algorithm (trailing time / gap management) | **TODO** |
| start_policy enforcement (hard/soft cut) | **TODO** |
| Recovery tactics (overflow handling) | **TODO** |
