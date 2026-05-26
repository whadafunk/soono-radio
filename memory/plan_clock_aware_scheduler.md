---
name: plan-clock-aware-scheduler
description: Architecture and build plan for the clock-aware scheduler — replacing the naive picker with a segment-position-aware, drift-correcting engine
metadata:
  type: project
---

## Goal

Replace the current naive `picker.ts` (random music pick, no clock awareness) and `scheduler.ts` (queue-depth poller) with a clock-aware scheduler that reads the active calendar slot, traverses clock segments in order, respects content rules per segment type, and actively corrects drift.

## Pre-conditions (do these first)

Before building the scheduler, two schema items must be in place:

1. **Campaign time intervals** — add `time_start` / `time_end` columns to `campaigns` so the campaign picker can filter by allowed broadcast window.
2. **Promo data model** — decide if promos are just `category='promo'` media files (model already exists) or need a first-class document with targeting/flight dates. Resolve this before wiring the stop-set picker.

## Architecture: hybrid A + B position tracking

Two positions are maintained simultaneously:

- **Ideal position (B — wall-clock derivation):** At any `now`, compute `offset = now - slot_start`, walk segment list summing `duration_seconds`, derive which segment should be playing and how far in. Pure math, no state, restart-safe.
- **Actual position (A — stateful tracking):** The segment currently playing, and its actual start timestamp. Persisted in the scheduler's in-memory state across ticks.
- **Drift** = `actual_segment_start − ideal_segment_start`. Positive = running late, negative = running early.

## Drift correction model

No new config needed — segment timing fields already encode operator intent:

| Field | Role in drift correction |
|-------|--------------------------|
| `start_policy: { type: 'hard' }` | Scheduler must cut to this segment at its scheduled wall-clock time regardless of what's playing |
| `start_policy: { type: 'soft', plus_seconds, minus_seconds }` | Scheduler may wait for a natural break point (track end, jingle end) within this window before transitioning |
| `recovery_tactics` | Ordered strategies applied when a segment overruns approaching a hard-start successor (e.g. skip next jingle, take early handover, truncate) |
| `trailing_time` | Strategies applied when a segment finishes early (e.g. insert filler track, fire early handover) |
| `filler_playlist_id` | Content pool for fill strategies |
| `interstitial_jingle_playlist_id` | Pool for jingle-skip recovery tactic |

At each track boundary: compute drift, check next segment's `start_policy`, decide whether to keep playing or transition, apply the appropriate tactic list.

## Scheduler state shape

```ts
{
  current_segment_index: number;       // stateful (A)
  segment_actual_start: Date;          // when this segment actually started
  clock_slot_start: Date;              // when the current calendar slot started
  clock_id: number;                    // active clock
  show_id: number | null;              // active show (from calendar entry)
  drift_seconds: number;               // derived: actual vs ideal, recomputed each tick
}
```

## Build order

1. Add campaign time interval columns + migration (15 min)
2. Decide promo model (conversation)
3. Build `resolvePosition(clock, segments, slotStart, now)` — pure function, returns `{ segmentIndex, idealSegmentStart, idealOffset }` — unit-testable
4. Build clock-aware picker: replaces `pickNext()`, receives the resolved segment, routes to the right content source per segment type
5. Wire stop-set segments: campaign picker (with time window + plays_per_show + flight date filters) + promo picker
6. Wire music segments: playlist/rotation-aware pick respecting `remaining_budget_seconds`
7. Wire jingle interstitials + filler tracks
8. Wire sweeper injection (requires LiquidSoap sweep overlay queue design)
9. Handover policies — `finish_segment`, `join_mid`, `overrun_policy` — handle edge cases last

## Key design constraint

`resolvePosition` derives segment boundaries from `duration_seconds` sums. Music segments use a **time budget** model (play tracks until budget is exhausted), not a track-count model. The picker receives `remaining_budget_seconds` and must not queue a track that would exceed it by more than the soft tolerance.

## What's already in place

- Telnet client, play history, queue-depth polling — all solid, keep them
- Calendar + template entries → active slot lookup is straightforward
- Clock + segment schema — complete, no structural changes needed
- Campaign schema (minus time intervals), show playlists, rotation documents — all queryable
