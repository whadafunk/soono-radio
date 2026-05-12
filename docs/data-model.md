# Data Model

Schema source of truth: `apps/api/src/db/schema.ts`  
Zod validation schemas: `packages/shared/src/schemas/`

---

## Entity Map

```
media ◄────────────── playlist_media ◄──── playlists
  │                                            │
  │                                       show_playlists ──► rotations
  │                                            │
  │                              shows ────────┘
  │                                │
  │                         default_clock_id
  │                                │
  │                             clocks ◄── clock_segments
  │                                │
  │                    template_entries
  │                    template_clock_entries
  │                    calendar_entries
  │
  ├──────────────── campaign_media ◄──── campaigns ◄── customers ◄── users
  │                                                                (account_manager)
  │
  └──────────────── play_history
                    ingest_jobs
```

---

## Tables

### `media`
Audio files. Core content unit of the system.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `sha256` | text UNIQUE | Deduplication key; filename in /media/ dir |
| `title` | text | |
| `artist` | text | |
| `album` | text | |
| `duration` | int | Seconds |
| `bitrate` | int | kbps |
| `sample_rate` | int | Hz |
| `channels` | int | 1=mono, 2=stereo |
| `category` | enum | `music`, `jingle`, `promo`, `intro`, `outro`, `bed`, `spot`, `recording` |
| `loudness_lufs` | real | Integrated loudness (EBU R128) |
| `loudness_lra` | real | Loudness range |
| `loudness_peak` | real | True peak (dBTP) |
| `cue_in` | real | Seconds from start (skip silence) |
| `cue_out` | real | Seconds from start (fade before end) |
| `play_count` | int | Incremented on each completed play |
| `last_played_at` | int | Unix timestamp |
| `favorite` | bool | Operator-flagged |
| `created_at` | int | Upload timestamp |

### `playlists`
Named collections of media.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `name` | text | |
| `type` | enum | `music`, `jingle`, `bed`, `promo`, `spot` |
| `created_at` | int | |

### `playlist_media`
Junction: playlist ↔ media with ordering and weight.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `playlist_id` | int FK | → playlists |
| `media_id` | int FK | → media |
| `sort_order` | int | Manual ordering (for round_robin) |
| `weight` | int | Relative probability (for weighted rotation) |

### `rotations`
Selection algorithm configurations.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `name` | text | |
| `type` | enum | `random_separation`, `least_recently_played`, `round_robin`, `weighted`, `campaign` |
| `params` | JSON | Type-specific config (see [scheduling.md](./scheduling.md)) |
| `created_at` | int | |

### `shows`
Radio programs.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `name` | text | |
| `type` | enum | `live`, `automated`, `prerecorded` |
| `host` | text | |
| `producer` | text | |
| `duration_minutes` | int | 30–720 |
| `default_clock_id` | int FK | → clocks |
| `intro_media_id` | int FK | → media |
| `outro_media_id` | int FK | → media |
| `color` | enum | UI color: `indigo`, `violet`, `cyan`, `emerald`, `amber`, `rose`, `orange`, `teal` |
| `notes` | text | |
| `active` | bool | |
| `created_at` | int | |

### `show_playlists`
Associates a show with playlists at specific rotation tiers.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `show_id` | int FK | → shows |
| `playlist_id` | int FK | → playlists |
| `rotation_tier` | text | `hot`, `medium`, `cold`, or custom name |
| `rotation_id` | int FK | → rotations (algorithm to use for this tier) |
| `fallback_tier` | text | Tier to try when this one is exhausted |

### `clocks`
Named hour templates.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `name` | text | |
| `sweep_config` | JSON | Optional commercial sweep timing config |
| `created_at` | int | |

### `clock_segments`
Ordered content blocks within a clock.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `clock_id` | int FK | → clocks |
| `sort_order` | int | Position in clock |
| `type` | enum | `music`, `commercial`, `jingle`, `promo`, `news`, `live`, `silence` |
| `duration` | int | Seconds |
| `source_type` | enum | `show_playlist`, `rotation`, `campaign`, `live_input`, `media` |
| `source_id` | int? | FK to specific source |
| `filler_sources` | JSON | Ordered fallback sources |
| `fallback_source` | JSON | Last-resort source |
| `delay_policy` | JSON | `{type: 'hard'}` or `{type: 'soft', plus_seconds, minus_seconds}` or `{type: 'postpone', max_plus_seconds}` |
| `recovery_tactics` | JSON | Ordered array: `['trim_outro', 'skip_song', 'drop_queued']` |
| `start_clip_id` | int? | → media (plays before segment) |
| `end_clip_id` | int? | → media (plays after segment) |
| `bed_id` | int? | → media (background during live) |
| `blocks_live_override` | bool | Prevents DJ takeover |

### `template_entries`
Weekly recurring schedule.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `day_of_week` | int | 1=Monday … 7=Sunday |
| `time_start` | text | HH:MM (24h) |
| `time_end` | text | HH:MM |
| `show_id` | int? FK | → shows (mutually exclusive with clock_id) |
| `clock_id` | int? FK | → clocks |

### `template_clock_entries`
Per-hour clock overrides within a weekly template.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `day_of_week` | int | 1–7 |
| `hour` | int | 0–23 |
| `clock_id` | int FK | → clocks |

### `calendar_entries`
One-off date-specific overrides.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `date` | text | YYYY-MM-DD |
| `time_start` | text | HH:MM |
| `time_end` | text | HH:MM |
| `show_id` | int? FK | → shows |
| `clock_id` | int? FK | → clocks |
| `is_override` | bool | True = explicitly overriding a template entry |
| `notes` | text | |

### `recordings`
Date-indexed show recordings (future phase).

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `show_id` | int FK | → shows |
| `broadcast_date` | text | YYYY-MM-DD |
| `media_id` | int FK | → media |
| `status` | enum | `pending`, `ready`, `played` |

### `customers`
Advertisers / sponsors.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `name` | text | |
| `email` | text | |
| `phone` | text | |
| `address` | text | |
| `account_manager_id` | int? FK | → users |
| `notes` | text | |
| `created_at` | int | |

### `campaigns`
Ad buys with delivery constraints.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `customer_id` | int FK | → customers |
| `name` | text | |
| `starts_on` | text | YYYY-MM-DD |
| `ends_on` | text | YYYY-MM-DD |
| `plays_per_month` | int | Target monthly plays |
| `plays_per_day` | int? | Optional daily cap |
| `sweeps_per_month` | int? | Sweep-specific target |
| `time_window_start` | text? | HH:MM — earliest allowed airtime |
| `time_window_end` | text? | HH:MM — latest allowed airtime |
| `days_of_week` | JSON | Array of ints (1–7), null = all days |
| `priority` | enum | `hard` (guaranteed) or `best_effort` |
| `first_in_slot` | bool | Must be first spot in commercial block |
| `competing_exclusions` | JSON | Array of campaign_ids — can't air in same break |
| `advertiser_separation` | int? | Min spots between same advertiser |
| `active` | bool | |
| `notes` | text | |
| `created_at` | int | |

### `contacts`
Individual contacts (people) associated with customers.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `customer_id` | int? FK | → customers (nullable; set null on customer delete) |
| `name` | text | |
| `email` | text | |
| `phone` | text | |
| `role` | text | |
| `notes` | text | |

### `customer_contacts`
Many-to-many junction: customer ↔ contacts with primary flag.

| Column | Type | Notes |
|--------|------|-------|
| `customer_id` | int FK | → customers (composite PK) |
| `contact_id` | int FK | → contacts (composite PK) |
| `is_primary` | bool | Primary contact for this customer |

### `campaign_media`
Specific ad spots or sweeps assigned to a campaign.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `campaign_id` | int FK | → campaigns |
| `media_id` | int FK | → media |
| `play_as_spot` | bool | Play as individual spot |
| `play_as_sweep` | bool | Play as part of sweep sequence |
| `sort_order` | int | Order within sweep |

### `play_history`
Record of every aired segment.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `media_id` | int? FK | → media (null for live) |
| `source` | enum | `auto`, `live`, `manual` |
| `pushed_at` | int | Unix timestamp when pushed to LS queue |
| `started_at` | int? | Actual on-air time (from LS metadata) |
| `ended_at` | int? | When track finished or was cut |
| `aborted` | bool | True if cut short (< 95% played) |
| `listener_count` | int? | Snapshot at start time |
| `pick_reason` | text? | Debug annotation from picker (e.g. "LRP eligible=47") |

### `ingest_jobs`
Tracks audio file upload and processing.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `status` | enum | `queued`, `analyzing`, `transcoding`, `completed`, `failed` |
| `uploaded_filename` | text | Original filename |
| `category` | enum | Pre-selected category |
| `media_id` | int? FK | → media (set on completion) |
| `error_message` | text? | Set on failure |
| `created_at` | int | |

### `users`
Operator accounts.

| Column | Type | Notes |
|--------|------|-------|
| `id` | int PK | |
| `first_name` | text | |
| `last_name` | text | |
| `email` | text UNIQUE | |
| `account_name` | text | Display name / login handle |
| `title` | text | Job title |
| `created_at` | int | |
