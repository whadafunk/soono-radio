# Rundown Editor

The rundown editor lets operators pre-assign specific audio files to `news`,
`bulletin`, and `voice_track` clock segments — the three segment types whose
content is known in advance (a recorded bulletin, a voiced tracking bed, etc.)
rather than drawn live from a rotation.

---

## Concepts

### Rundown segment types

| Type | Typical use |
|------|-------------|
| `news` | Live or pre-recorded news read |
| `bulletin` | Short news or traffic bulletin |
| `voice_track` | Pre-recorded DJ link or tracker |

These segment types still live inside clocks and are scheduled through the
normal calendar/template machinery. The rundown layer sits on top: before the
supervisor picks from a segment's source list it first checks whether a
specific file has been assigned via the rundown.

### Slot identity

A *slot* is uniquely identified by four fields:

```
(date, time_start, clock_id, segment_index)
```

`time_start` is the start of the clock *instance* (e.g. `08:00`), not the
start of the segment within that instance. `segment_index` is the 0-based
position in the clock's segment list.

There is no pre-materialised "rundown entry" table — slots are computed on the
fly from the live schedule.

---

## Data model

### `rundown_assignments`

Stores a per-slot content assignment.

| Column | Type | Notes |
|--------|------|-------|
| `id` | integer PK | |
| `date` | text | `YYYY-MM-DD` |
| `time_start` | text | `HH:MM` — clock instance start |
| `clock_id` | integer FK → clocks | `ON DELETE CASCADE` |
| `segment_index` | integer | 0-based index within clock |
| `media_id` | integer FK → media | nullable, `ON DELETE SET NULL` |
| `notes` | text | nullable operator note |
| `assigned_at` | timestamp | set on every upsert |

Unique constraint: `(date, time_start, clock_id, segment_index)`.

### `rundown_duration_overrides`

Overrides the template duration of a specific segment in a specific clock
instance. Affects both the supervisor's timing and the rundown UI mini-timeline.

| Column | Type | Notes |
|--------|------|-------|
| `id` | integer PK | |
| `date` | text | `YYYY-MM-DD` |
| `time_start` | text | `HH:MM` — clock instance start |
| `clock_id` | integer FK → clocks | `ON DELETE CASCADE` |
| `segment_index` | integer | 0-based |
| `duration_seconds` | integer | must be ≥ 1 |

Unique constraint: `(date, time_start, clock_id, segment_index)`.

### `clock_segments.fallback_playlist_id`

Nullable FK added in migration 0039. If set for a `news`, `bulletin`, or
`voice_track` segment, the supervisor picks a random track from this playlist
when no rundown assignment exists — before falling through to the segment's
regular `sources` config.

### `rundown_show_content`

Assigns a **playlist** (rather than a single file) to all segments of a given
type within a clock instance. One row per `(date, time_start, clock_id,
segment_type)`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | integer PK | |
| `date` | text | `YYYY-MM-DD` |
| `time_start` | text | `HH:MM` — clock instance start |
| `clock_id` | integer FK → clocks | `ON DELETE CASCADE` |
| `segment_type` | text | `'news'` or `'bulletin'` |
| `playlist_id` | integer FK → playlists | `ON DELETE CASCADE` |

Unique constraint: `(date, time_start, clock_id, segment_type)`.

This is distinct from per-slot file assignments in `rundown_assignments`. The
supervisor reads show-content at air time and sequences tracks from the playlist
in order, advancing a cursor (`rundown_playback_cursors`) between segments.

### `rundown_playback_cursors`

Tracks sequential playback position through a show-content playlist.

| Column | Type | Notes |
|--------|------|-------|
| `id` | integer PK | |
| `date` | text | `YYYY-MM-DD` |
| `time_start` | text | `HH:MM` |
| `clock_id` | integer FK → clocks | |
| `segment_type` | text | `'news'` or `'bulletin'` |
| `next_track_index` | integer | 0-based; advances after each pick |

---

## API endpoints

All endpoints live in `apps/api/src/routes/rundown.ts`.

### `GET /rundown?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD`

Returns an array of `RundownSlot` objects, one per assignable segment per
clock instance in the date range.

**Slot enumeration** (the expensive part):

1. Find all `clock_id`s that contain at least one `news`/`bulletin`/`voice_track`
   segment.
2. Compute each clock's total duration by summing its segment `duration_seconds`
   (there is no `duration_seconds` column on the `clocks` table itself).
3. For each date in the range, resolve the schedule using a 1440-slot
   minute-granularity array with three precedence layers:

   | Priority | Source |
   |----------|--------|
   | 0 (lowest) | `template_entries` span |
   | 1 | `template_clock_entries` per-hour override |
   | 2 (highest) | `calendar_entries` explicit entry |

   Higher-priority entries overwrite lower in the minute array, then
   non-overlapping spans are reconstructed.

4. For each span whose clock has at least one assignable segment, tile clock
   instances end-to-end across the span at the clock's duration interval.
5. For each instance, emit one slot per `news`/`bulletin`/`voice_track` segment.

**Response fields per slot** (key ones):

| Field | Description |
|-------|-------------|
| `date`, `time_start`, `clock_id`, `segment_index` | Slot key |
| `clock_name`, `segment_name`, `segment_type` | Display |
| `template_duration_seconds` | From clock segment |
| `fallback_playlist_id` | From segment template |
| `assignment` | null or `{ id, media_id, media_title, … }` |
| `duration_override_id`, `duration_override_seconds` | null or override |
| `is_assigned` | `assignment.media_id != null` |
| `effective_duration_seconds` | override → assignment media duration → template |
| `clock_segments` | All segments in this clock (for the mini timeline) |

### `PUT /rundown/assignments`

Upsert body (validated by `RundownAssignmentUpsertSchema`):

```json
{
  "date": "2026-05-20",
  "time_start": "08:00",
  "clock_id": 3,
  "segment_index": 1,
  "media_id": 42,
  "notes": "optional"
}
```

Conflict target: `(date, time_start, clock_id, segment_index)`. Sets
`assigned_at` on every upsert.

### `DELETE /rundown/assignments/:id`

Deletes a single assignment by primary key.

### `PUT /rundown/duration-overrides`

Upsert body (validated by `RundownDurationOverrideUpsertSchema`):

```json
{
  "date": "2026-05-20",
  "time_start": "08:00",
  "clock_id": 3,
  "segment_index": 1,
  "duration_seconds": 180
}
```

### `DELETE /rundown/duration-overrides/:id`

Deletes a single override by primary key.

### `GET /rundown/slot-content?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD`

Returns all `rundown_show_content` rows for the date range, joined with the
playlist name:

```json
[
  {
    "id": 7,
    "date": "2026-05-22",
    "time_start": "08:00",
    "clock_id": 3,
    "segment_type": "news",
    "playlist_id": 12,
    "playlist_name": "Morning News"
  }
]
```

### `PUT /rundown/show-content`

Upsert body (validated by `RundownShowContentUpsertSchema`):

```json
{
  "date": "2026-05-22",
  "time_start": "08:00",
  "clock_id": 3,
  "segment_type": "news",
  "playlist_id": 12
}
```

Conflict target: `(date, time_start, clock_id, segment_type)`.

### `DELETE /rundown/show-content/:id`

Deletes a single show-content assignment by primary key.

---

## Supervisor integration

### Picker (`apps/api/src/services/supervisor/picker.ts`)

When the current segment is `news`, `bulletin`, or `voice_track`, `pickNext`
calls `pickFromRundownSegment` instead of `pickFromSegment`. The lookup chain:

1. **Rundown assignment** — query `rundown_assignments` by
   `(date, time_start, clock_id, segment_index)` where `time_start` and `date`
   come from `scheduled.clock_instance_started_at`. If a `media_id` exists and
   the file is in the library, return it.

2. **Fallback playlist** — if `scheduled.segment.fallback_playlist_id` is set,
   pick a random track from `playlist_media` for that playlist.

3. **Segment source config** — fall through to `pickFromSegment`, which runs
   the normal weighted-draw / rotation algorithm over the segment's `sources`.

### Clock resolver (`apps/api/src/services/supervisor/clockResolver.ts`)

`materialize()` now loads `rundown_duration_overrides` for the current clock
instance and uses override durations when walking segment boundaries to find
which segment is on air. This means a 3-minute news segment overridden to 5
minutes will hold the supervisor's "current segment" state for those extra
2 minutes.

**Tiling caveat**: clock instance tiling (how many times a clock repeats within
a span) still uses template durations. If per-instance duration overrides
change the effective clock length significantly, subsequent tiles within the
same span may drift slightly from wall-clock boundaries. This is acceptable for
V1 — tiling precision matters more for music segments than for rundown content.

---

## UI

### Calendar popover — show content

Component: `CalEditSlotPopover` in `apps/web/src/pages/schedule/SchedulePage.tsx`

When a calendar entry's clock contains `news` or `bulletin` segments, the slot
popover shows a **Rundown Content** section at the bottom. One row per required
type; each row lets the operator assign or change the playlist for that type in
this specific clock instance.

Clicking **+ Assign playlist** opens a playlist search panel filtered to
playlists that have at least one track (`total_seconds > 0`) or are dynamic.
Selecting a playlist calls `PUT /rundown/show-content`. The × button calls
`DELETE /rundown/show-content/:id`.

The calendar block itself displays a coloured **RUNDOWN** badge based on
assignment state:

| State | Colour |
|-------|--------|
| All required types assigned | Emerald |
| Some assigned | Amber |
| None assigned | Rose |

#### Playlist vs slot duration validation

When a playlist is assigned, a compact validation row appears below the
playlist name:

```
5:34 playlist  ·  6:00 slot          -0:26
```

- **playlist** — `total_seconds` of the assigned playlist (sum of all track
  durations, computed via join in `GET /playlists`).
- **slot** — sum of `duration_seconds` for all segments of this type in the
  clock (`ClockSegmentSummary.duration_seconds`).
- **delta** — `playlist − slot`, displayed with sign. Amber when non-zero,
  emerald when exact.

A negative delta means the playlist is shorter than the allocated slot (risk of
dead air). A positive delta means the playlist overruns the slot (content will
be cut off mid-track). Both are warnings; neither blocks saving.

The delta is computed entirely on the frontend from cached data — no extra API
call. A configurable safe-margin threshold (`|delta| ≤ margin`) is planned to
suppress the amber warning for small acceptable divergences.

---

### Rundown editor page

Route: `/rundown`  
Component: `apps/web/src/pages/rundown/RundownPage.tsx`

### Layout

3-day lookahead (configurable via `DAYS_VISIBLE`). Each day column shows clock
instances as collapsible cards. Within each card, one row per assignable slot.

### Readiness indicators

| State | Colour |
|-------|--------|
| All slots assigned | Emerald dot |
| Some assigned | Amber dot |
| None assigned | Grey dot |

Shown at both the clock-instance card level and the individual slot level.

### Assigning content

Clicking "+ Assign content" opens a `MediaPickerModal`. Searching is powered
by the existing `GET /library` endpoint. Selecting a file calls
`PUT /rundown/assignments`. Clicking the × on an assigned slot calls
`DELETE /rundown/assignments/:id`.

### Duration overrides

Each slot shows its effective duration (amber + asterisk when overridden).
Clicking it opens an inline number input (in seconds). Press Enter or ✓ to
save via `PUT /rundown/duration-overrides`. The × next to it removes the
override via `DELETE /rundown/duration-overrides/:id`.

### Mini timeline

A horizontal bar spanning the full clock width, divided proportionally by
segment duration. The current slot's segment is highlighted sky-blue (assigned)
or amber (unassigned). Other segment type colours:

| Segment type | Colour |
|---|---|
| `music` | Indigo |
| `stop_set` | Orange |
| `live` | Emerald |
| `news` / `bulletin` / `voice_track` | Sky (neighbour) |

### Fallback playlist (clock segment editor)

In the Clocks page, the Content tab for `news`, `bulletin`, and `voice_track`
segments now includes a **Fallback playlist** dropdown. Set it to any playlist
in the library. The supervisor reads this at air time when no rundown
assignment exists for the slot.

---

## Key design decisions

**No pre-materialised slot rows** — slots are computed at query time from the
live schedule. This avoids stale data when the schedule changes after rundown
entries are already created. Assignments and overrides are stored by their
natural composite key; the API reconstructs the context around them.

**Uncapped duration overrides** — the API does not impose a ceiling on
`duration_seconds`. The UI warns visually (amber asterisk) but does not block
large divergences from the template. The operator is trusted to know what fits.

**Fallback chain is additive** — `fallback_playlist_id` does not replace the
segment's `sources` config; it inserts one extra step before it. Existing
clocks without a fallback configured continue to work unchanged.

**Tiling uses template durations** — see Supervisor integration / Clock resolver
above. Duration overrides only affect the boundary walk within the current
instance, not the tiling interval.
