# Scheduling Logic — Design Decisions

Captures decisions and invariants that are not obvious from the code alone.
Companion to `docs/clocks-rotations-redesign.md` (which documents the original
design). Where this document contradicts that one, **this document wins**.

---

## 1. Clock assignment

A clock can be assigned to a show via `shows.default_clock_id`. This is a
**design-time hint** — it drives UI source options and save-time validation but
does not constrain runtime scheduling. At runtime the scheduler reads the
show_id from the calendar/template slot, not from the clock.

A single clock can be assigned to multiple shows.

### What assignment changes

| | Unassigned clock | Assigned clock |
|---|---|---|
| Music segment source mode | Segment Playlist (explicit playlists + rotation) | Show Playlist (draws from assigned show's playlists) |
| Jingles playlist | `clock.jingle_playlist_id` | Show's own jingle playlist |
| Source badge (UI) | Indigo "Segment" | Emerald "Show" |
| Save-time validation | Playlist sources must have a rotation_id | show_playlist sources always valid |

Switching a clock from unassigned to assigned (or vice versa) clears all
existing segment sources so the operator is forced to reconfigure them for the
new mode. Mixing source modes is not allowed within a single clock.

---

## 2. Clock structure lock

When a clock is actively scheduled (appears in any `calendar_entries`,
`template_entries`, or `template_clock_entries` row), its **structure** is
frozen:

- Segment count cannot change.
- Segment order cannot change.
- Segment types cannot change.
- Segment durations cannot change.

**What is NOT locked:** internal segment configuration — source playlists,
rotation IDs, sweep config, interstitial settings, start/end clips, etc. These
can always be edited. Show assignment alone does not lock structure; it is a
design-time hint, not a scheduling commitment.

The lock is enforced at the API level in `PUT /clocks/:id/segments`. The UI
shows a "structure locked" banner and disables the add/remove/reorder controls.

---

## 3. Start policy

`start_policy` replaces the old `soft` / `hard` + `plus_seconds` /
`minus_seconds` model. It is a discriminated union:

```ts
type StartPolicy =
  | { type: 'hard' }
  | { type: 'flexible'; late_seconds: number | null; early_seconds: number | null }
```

### Field semantics

| Field | Value | Meaning |
|---|---|---|
| `late_seconds` | `null` | Natural end — segment plays until content runs out |
| `late_seconds` | `0` | Late start disabled — segment must start on time |
| `late_seconds` | `N` | Segment may start up to N seconds late; cut at N |
| `early_seconds` | `null` | Fill gap — segment fills any available time before the next boundary |
| `early_seconds` | `0` | Early start disabled — segment starts exactly at boundary |
| `early_seconds` | `N` | Segment may start up to N seconds early |

### Auto-revert rule

If the operator unchecks both "Allow late start" and "Allow early start" (i.e.,
both `late_seconds = 0` and `early_seconds = 0`), the policy auto-reverts to
`{ type: 'hard' }`. A `flexible` policy with both values at 0 is semantically
identical to `hard` and the UI collapses it to avoid confusion.

### Badge states

| Badge | Policy shape | Color |
|---|---|---|
| **fixed** | `hard`, or flexible with both 0 | Red |
| **flexi-late** | flexible, `late_seconds ≠ 0`, `early_seconds = 0` | Amber |
| **flexi-early** | flexible, `late_seconds = 0`, `early_seconds ≠ 0` | Blue |
| **flexible** | flexible, both `late_seconds ≠ 0` and `early_seconds ≠ 0` | Green |

Default for new segments: `{ type: 'flexible', late_seconds: null, early_seconds: 0 }` (flexi-late).

---

## 4. Finish policy — removed

`finish_policy` was removed from both the `clocks` table and the supervisor
config. It was redundant with segment `start_policy`:

- A "hard cut" at a clock boundary is already expressed by the successor
  segment having `start_policy.type = 'hard'`.
- A "finish segment" boundary is expressed by `start_policy.type = 'flexible'`.

The column still exists in the database (libsql cannot drop columns) but is
not read or written by the application.

---

## 5. End policy: can_skip / can_fill

`can_skip` (catching up) and `can_fill` (coasting) are stored in the DB but
are **derived fields in the UI** — they are not exposed as independent
checkboxes. Instead:

- `can_skip = catching_up_order.length > 0`
- `can_fill = coasting_order.length > 0`

Whenever the operator modifies `catching_up_order` or `coasting_order`, the UI
syncs the corresponding flag. This avoids the previous UI state where a
`can_skip = true` flag could be set with an empty `catching_up_order`, which
would have no effect at runtime.

The `catching_up_order` and `coasting_order` arrays are **priority-ordered**
lists of event types the supervisor is allowed to skip or insert when recovering
from drift. Items at the front of the list are targeted first. An empty array
means no drift handling for that direction.

---

## 6. slot_count — what it counts

`slot_count` is a derived field returned on every clock response. It counts
how many times the clock is actively scheduled across all scheduling surfaces:

```sql
  -- template_entries without a show: standalone clock slots, each counts once
  (SELECT COUNT(*) FROM template_entries WHERE clock_id = ? AND show_id IS NULL)
  -- template_entries with a show: count distinct shows, not per-slot rows
  -- (a show with Mon/Wed/Fri slots all pointing to this clock counts as 1)
+ (SELECT COUNT(DISTINCT show_id) FROM template_entries WHERE clock_id = ? AND show_id IS NOT NULL)
  -- per-hour station grid assignments (template_clock_entries), each row = one slot
+ (SELECT COUNT(*) FROM template_clock_entries WHERE clock_id = ?)
  -- one-off calendar overrides, each row = one appearance
+ (SELECT COUNT(*) FROM calendar_entries WHERE clock_id = ?)
```

`slot_count` is distinct from `assigned_shows.length`. A show can have this
clock as its `default_clock_id` without the clock appearing in any template or
calendar entry, and vice versa.

**In the UI:**

- `slot_count > 0` → amber "Scheduled (N)" badge
- `slot_count = 0` → badge hidden (but layout space preserved so list items
  stay aligned)
- `assigned_shows` → shown as a list in the "Used by shows" panel, not as a
  count

---

## 7. Clock playlists

Two playlists live at the clock level:

| Field | Used when |
|---|---|
| `jingle_playlist_id` | Clock is **unassigned** — sweepers of type `jingle` draw from here |
| `station_id_playlist_id` | All clocks — sweepers of type `station_id` draw from here |

When a clock is assigned to a show, `jingle_playlist_id` is ignored at runtime;
the supervisor uses the show's `jingle_playlist_id` instead. The field is
retained on the clock for when the assignment is later removed.

---

## 8. Running early into a fixed successor (supervisor)

When a segment is running early and the next segment has
`start_policy.type = 'hard'`, the supervisor must fill the gap rather than
idle. The supervisor should detect the hard boundary in advance (using the
existing `hard_cut_warning` lookahead, which fires when remaining time drops
below 120 seconds) and begin scheduling filler content against the gap.

The filler strategy is determined by the **current** segment's `can_fill` flag
and `coasting_order` — the same drift-recovery path used when the segment is
running long. The difference is that this filler run is bounded: it stops when
wall-clock reaches the hard boundary, not when the segment's nominal end is
reached.

This is fully documented in `docs/supervisor-v2-design.md` under "Decision 8:
Running-early into a fixed successor."

---

## 9. Outdated fields in docs/clocks-rotations-redesign.md

The following items in the original design doc are superseded:

| Item | Status |
|---|---|
| `finish_policy` on clock and supervisor config | Removed — see §4 above |
| `show_id` on `clocks` table | Was part of early design; superseded by `assigned_shows` (derived from `shows.default_clock_id`). The DB column does not exist; assignment is tracked on the show, not the clock. |
| Clock-level `sweep_config` with `over[]` array | Per-segment `sweeper_config` replaces clock-level sweep config |
| `SweepSourceEntry.rotation` (SimpleRotationType) | Replaced by `rotation_id` pointing to a sweeper rotation document |
| Old `soft`/`hard` + `plus_seconds`/`minus_seconds` start policy | Replaced by §3 above |
