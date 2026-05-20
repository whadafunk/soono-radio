# Clocks & Rotations — Redesign Notes

Captures the design decisions reached for the rotations + clocks + sweepers + handover model. Companion to `scheduling.md`.

---

## 1. Rotations are first-class documents with a `kind`

A rotation document defines **how** a pool is drawn from — never **what** the pool contains. Two kinds:

| Kind | Used by | Sources of the pool | Extra params |
|------|---------|---------------------|--------------|
| `music` | Show playlists, music-segment playlist sources | Defined by the consumer (playlist) | Track separation, artist separation, pool size, order-by, weights |
| `sweeper` | Clock sweep config sources | Derived from sweeper type + clock-assignment state (see §4) | Song-position firing (`any` \| `song_start` \| `song_end`) |

Algorithms (`random_separation`, `least_recently_played`, `round_robin`, `weighted`) apply to both kinds; UI filters params per kind.

Rotation documents are selectable everywhere a rotation is needed. The simple `round_robin / random` enum (`SimpleRotationType`) survives only for non-rotatable contexts (e.g. a live segment with a bed playlist, where a full rotation document is overkill).

## 2. Clocks have a show-assignment hint

`clocks.show_id` is nullable.

- `null` → **unassigned** clock. Music segments must each provide at least one specific `playlist` source (validation gate on Save).
- non-null → clock is **designed for** that show. Music segments may use `show_playlist` / `show_jingles` / `show_beds` sources.

This is a **design-time hint**, not a runtime constraint. At runtime the scheduler reads `show_id` from the **calendar slot**, never from the clock. An assigned clock placed in any show's slot will pull that slot's show content. The clock's own `show_id` only drives:

1. UI label ("Unassigned" vs the show name)
2. Allowed source types in the editor
3. Save-time validation

A clock is **used** when it appears in any `calendar_entries` or `template_entries` (or `template_clock_entries`) row. The clocks list shows a `Used / Not used` badge; this is derived per request, not stored.

## 3. Source rules per segment type

### Music segments — two mutually exclusive modes

Music segments operate in exactly one of two modes. Switching modes replaces all sources.

#### Mode A: Show Playlist

The segment draws from the playlists configured on the **assigned show**. The show's own rotation document governs playback order.

- Source array contains a single implicit `{ type: 'show_playlist' }` entry — no weight, no rotation_id on the entry.
- No segment-level rotation picker (the show's rotation applies, not a per-segment one).
- **Save-time block**: if the clock is not assigned to any show at save time, the API returns 400. The UI also shows a pre-save warning badge.
- The "Add source" button is disabled in this mode — there is only ever one implicit source.

#### Mode B: Segment Playlist

The segment owns its sources explicitly. The operator selects specific playlists and one rotation document for the segment.

- Source array contains one or more `playlist` entries, each with `playlist_id` and `weight`. All entries share a single `rotation_id` field at the segment level (one rotation picker for the whole segment, not per-row).
- The picker defaults to the station's default rotation when the first source is added.
- **Save-time block**: if the segment has playlist sources but `rotation_id` is null, the API returns 400. The UI shows a red border on the picker and a pre-save error badge.
- Multiple playlists can be added; the dropdown excludes playlists already used by sibling rows.
- `hot_play` / `heavy_rotation` fields remain in the schema (used by future rotation-document logic) but are not surfaced on the clock UI.

**Tier concept is dropped.** The old `tier` field on source entries is not used, not persisted, and not displayed anywhere.

**Switching modes** replaces all existing sources with a single default source for the new mode.

### Live / Live audience segments
- Default source is `live` (harbor). Additional sources are valid (beds playlist, etc.).
- The simple rotation dropdown appears only on non-`live` source rows.
- Bed source toggles between `show_beds` (assigned clock) and a specific `playlist` (unassigned clock).
- "Allow DJ to go live during this segment" (`accept_live`) lives in the **Content tab** for `music`, `news`, and `bulletin` segment types only. It is not shown for stop-set, voice-track, or live/live-audience segments.

### Stop-set segments — two fixed slots
Two independent slots, each storing one entry in the segment's `sources` array:

| Slot | Options | Rotation |
|------|---------|----------|
| Campaigns | none · campaigns · campaigns playlist (spot-category) | per-slot simple rotation |
| Promos | none · promos · promos playlist (promo-category) | per-slot simple rotation |

Schema-wise: `campaigns` and `promos` source entries gain an optional `rotation: SimpleRotationType`. `playlist` rows in stop-set continue to encode promo/spot variant by playlist category.

## 4. Sweepers — clock structure + rotation behavior

Sweeper configuration splits across two surfaces.

### On the clock's `sweep_config`
- `per_hour`: target count per hour
- `min_gap_minutes`: spacing constraint
- `over[]`: which segment types accept sweeps as overlays
- `station_id_playlist_id` *(new)*: playlist designated as station IDs
- `jingle_playlist_id` *(new, conditional)*: only used when the clock is **unassigned** — when assigned, sweepers of type `jingle` draw from the show's jingle playlist
- `sources[]`: which sweeper types fire and their rotation document

### Per-source rotation document
`SweepSourceEntry.rotation` (the old `SimpleRotationType`) is replaced by `rotation_id: number | null` pointing at a **sweeper-kind** rotation document.

**Sources are NOT in the rotation document.** They are derived deterministically:

| Sweeper type | Source pool |
|--------------|-------------|
| `commercial` (UI label: "Campaigns") | Campaign spots |
| `promo` | Promo documents *(future)* |
| `station_id` | `clock.sweep_config.station_id_playlist_id` |
| `jingle` | Show jingle playlist (assigned) OR `clock.sweep_config.jingle_playlist_id` (unassigned) |

Song-position firing (`song_start` / `song_end` / `any`) lives on the sweeper rotation document and tells the scheduler when in the underlying track to fire the overlay.

## 5. Handover model (replaces "mid-hour handoff")

Three independent settings on the clock control the boundary cases between a clock and the slot before/after it.

**Clock-level policies** (stored on the clock; null = inherit station default):

| Setting | Scope | Options | Default |
|---------|-------|---------|---------|
| `finish_policy` | What to do when a hard-cut deadline arrives | `hard_cut` \| `finish_segment` | `finish_segment` |
| `join_policy` | How to start a clock that's entered mid-way | `join_top` \| `join_mid` | `join_top` |

- `finish_segment` lets the active segment finish naturally rather than amputating it. Replaces the old `finish_clock` option which could overrun by up to an hour.
- `join_top` starts the clock at segment 0; `join_mid` skips ahead to the segment that would be playing at the current wall-clock minute (preserves wall-clock alignment of scheduled breaks).

**Show-level policy** (stored on the show):

| Setting | Scope | Options | Default |
|---------|-------|---------|---------|
| `extension_policy` | What to play when there is no clock assigned to cover part of the show's interval | `repeat_last_clock` \| `fall_through` | `repeat_last_clock` |

The supervisor tiles clocks across the full show interval, so this only fires if a DJ extends the show beyond the last assigned clock hour. `repeat_last_clock` tiles the last clock again; `fall_through` keeps playing content sources without clock structure.

The `overrun_policy` column remains in the DB (libsql cannot drop columns) but is no longer read or written by the application.

The previous `mid_hour_handoff` setting (if present in `supervisor_config`) is superseded by these three.

---

## Data shape summary (post-change)

```ts
// Rotation
type Rotation = {
  id: number;
  name: string;
  kind: 'music' | 'sweeper';
  type: 'random_separation' | 'least_recently_played' | 'round_robin' | 'weighted';
  song_position?: 'any' | 'song_start' | 'song_end';  // sweeper-only
  params: Record<string, unknown>;
};

// Clock
type Clock = {
  id: number;
  name: string;
  description: string | null;
  show_id: number | null;
  sweep_config: SweepConfig | null;
  finish_policy: 'hard_cut' | 'finish_segment';
  join_policy: 'join_top' | 'join_mid';
  used: boolean;          // derived; populated on read
  duration_seconds: number;
};

// SweepConfig (clock-level)
type SweepConfig = {
  per_hour: number;
  over: ClockSegmentType[];
  min_gap_minutes: number;
  station_id_playlist_id: number | null;
  jingle_playlist_id: number | null;        // used only when clock.show_id is null
  sources: SweepSourceEntry[];
};

type SweepSourceEntry = {
  type: 'commercial' | 'promo' | 'station_id' | 'jingle';
  weight: number;
  rotation_id: number | null;  // FK to a sweeper-kind rotation document
};

// Music segment sources — two mutually exclusive modes (see §3)

// Mode A: Show Playlist — single implicit entry, no weight, no rotation_id
type ShowPlaylistSource = { type: 'show_playlist' };

// Mode B: Segment Playlist — one or more explicit playlists, one shared rotation
type PlaylistSource = {
  type: 'playlist';
  playlist_id: number;
  weight: number;
  hot_play: boolean;        // kept in schema; not surfaced on clock UI
  heavy_rotation: boolean;  // kept in schema; not surfaced on clock UI
  rotation_id: number | null;  // shared across all playlist sources in the segment
};

// Campaign / Promo source — gain optional rotation
type CampaignsSource = { type: 'campaigns'; rotation?: SimpleRotationType };
type PromosSource    = { type: 'promos'; weight: number; rotation?: SimpleRotationType };
```

## 6. Silence detection

Silence detection is configured in two places.

### Mix Engine (global defaults)

Configured in **Settings → Mix Engine → Silence Detection**. Stored in `liquidsoap_config.silence_detection`:

```ts
type SilenceDetectionConfig = {
  threshold_seconds: number;  // 1–60; default 5
  fallback: 'none' | 'playlist';
  fallback_playlist_id: number | null;  // required when fallback === 'playlist'
};
```

When `fallback` is `'playlist'`, Liquidsoap switches to the specified playlist when silence exceeds `threshold_seconds` on the harbor input.

### Per-segment threshold override

Live segments (and any other segment type where `silence_threshold_seconds` is non-null) can override the global threshold. Stored as `clock_segments.silence_threshold_seconds: integer | null`. Null means "use the global default". Surfaced in the **Content tab** of live/live-audience segments.

The old `silence_detection_action` column remains in the DB (libsql cannot drop columns) but is not read or written by the application.

---

## Migration notes

- DB migration adds: `clocks.show_id`, `clocks.finish_policy`, `clocks.join_policy`, `clocks.overrun_policy`, `rotations.kind`, `rotations.song_position`.
- DB migration adds: `clock_segments.silence_threshold_seconds` (replaces the old `silence_detection_action` enum column, which is now inert).
- JSON columns (`sweep_config`, `sources`) absorb their new fields without migration. Old rows missing the new fields parse fine because the zod schema treats them as optional.
- The segment-level `rotation_type` column (`SimpleRotationType` on the segment as a whole) is retained for live / live_audience segments where a per-source rotation is overkill; stop-set ceases to use it (rotation moves into per-slot source entries).
