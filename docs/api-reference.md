# API Reference

Base URL: `http://localhost:3000`  
All request/response bodies are JSON unless noted.  
All input is validated against Zod schemas from `packages/shared/`.

---

## Supervisor / Playback

### `GET /supervisor/status`
Current playback state.

Response:
```json
{
  "running": true,
  "reachable": true,
  "queue_depth": 1,
  "on_air_source": "auto",
  "current_play_id": 42
}
```

### `GET /supervisor/now-playing`
Currently airing track with joined media metadata.

Response: `NowPlaying` — play_history row joined with media fields.

### `GET /supervisor/recent-plays?limit=20`
Last N played tracks.

Response: `RecentPlay[]`

### `POST /supervisor/skip`
Skip currently playing track. Status: 501 (not yet implemented).

### `GET /supervisor/config`
Read supervisor tuning parameters.

Response: `SupervisorConfig`
```json
{
  "scheduler_tick_ms": 5000,
  "metadata_poll_ms": 5000,
  "queue_depth_threshold": 1,
  "separation_minutes": 30,
  "mid_hour_handoff": "finish_clock"
}
```

### `POST /supervisor/config`
Save supervisor config. Does not restart automatically.

Body: `SupervisorConfig`

### `POST /supervisor/restart`
Apply config changes and restart scheduler + watcher loops.

---

## Shows

### `GET /shows?active=true`
List shows. `active` filter is optional.

### `POST /shows`
Create show.

Body:
```json
{
  "name": "Morning Drive",
  "type": "live",
  "host": "Jane Smith",
  "producer": "Bob Jones",
  "duration_minutes": 240,
  "default_clock_id": 3,
  "color": "indigo",
  "notes": ""
}
```

### `GET /shows/:id`
Get single show.

### `PATCH /shows/:id`
Update show fields (partial).

### `DELETE /shows/:id`
Delete show. Fails if referenced by template or calendar entries.

---

## Clocks

### `GET /clocks`
List all clocks with segment count.

### `POST /clocks`
Create clock.

Body: `{ "name": "Morning Standard", "sweep_config": null }`

### `GET /clocks/:id`
Get clock with all segments.

### `PATCH /clocks/:id`
Update clock name or sweep_config.

### `DELETE /clocks/:id`
Delete clock. Fails if referenced by shows or schedule entries.

### `GET /clocks/:id/segments`
Get ordered segments for a clock.

### `PUT /clocks/:id/segments`
Replace all segments for a clock (full reorder/rebuild). Atomic — deletes existing, inserts all provided.

Body: `ClockSegment[]` (without ids; sort_order assigned by array position)

---

## Rotations

### `GET /rotations`
List all rotations.

### `POST /rotations`
Create rotation.

Body:
```json
{
  "name": "Hot Hits",
  "type": "random_separation",
  "params": { "separation_minutes": 60, "artist_separation_minutes": 30 }
}
```

Params by type:
- `random_separation`: `{ separation_minutes, artist_separation_minutes? }`
- `least_recently_played`: `{ pool_size? }`
- `round_robin`: `{ order_by: "added_date" | "title" | "artist" | "manual" }`
- `weighted`: `{}`
- `campaign`: `{ distribution: "even_spread" | "priority_first" | "pacing" }`

### `PATCH /rotations/:id`
Update name or params.

### `DELETE /rotations/:id`
Delete rotation.

---

## Schedule — Template Entries

### `GET /template-entries`
List all weekly template entries.

### `POST /template-entries`
Create entry.

Body:
```json
{
  "day_of_week": 1,
  "time_start": "06:00",
  "time_end": "10:00",
  "show_id": 5,
  "clock_id": null
}
```

### `PATCH /template-entries/:id`
Update entry fields.

### `DELETE /template-entries/:id`
Delete entry.

---

## Schedule — Template Clock Entries

### `GET /template-clock-entries`
List all hourly clock overrides.

### `PUT /template-clock-entries`
Upsert by `(day_of_week, hour)`. Creates or replaces.

Body: `{ "day_of_week": 1, "hour": 7, "clock_id": 4 }`

### `DELETE /template-clock-entries/:id`
Delete override.

---

## Schedule — Calendar Entries

### `GET /calendar-entries?week_start=2026-05-12`
List calendar entries for a week (7 days from `week_start`).

### `POST /calendar-entries`
Create one-off override.

Body:
```json
{
  "date": "2026-12-25",
  "time_start": "06:00",
  "time_end": "10:00",
  "show_id": 8,
  "clock_id": null,
  "is_override": true,
  "notes": "Holiday Special"
}
```

### `PATCH /calendar-entries/:id`
Update calendar entry.

### `DELETE /calendar-entries/:id`
Delete calendar entry.

---

## Library (Media)

### `POST /library/upload`
Upload one or more audio files. Multipart form data.

Fields: `category` (enum), `files[]` (binary)

Response: `IngestJob[]`

### `GET /library?category=music&sort=title&dir=asc&q=beatles`
Search/filter media.

Params: `category`, `sort` (title/artist/duration/bitrate/play_count/created_at), `dir` (asc/desc), `q` (title/artist search)

Response: `Media[]`

### `GET /library/:id`
Get single media item.

### `PATCH /library/:id`
Update metadata.

Body (all optional): `{ "title", "artist", "album", "category", "cue_in", "cue_out", "favorite" }`

### `DELETE /library/:id`
Delete media and its file.

### `POST /library/:id/transcode`
Re-transcode file (e.g. format conversion).

### `POST /library/:id/re-measure`
Re-run loudness analysis.

### `POST /library/bulk/category`
Change category for multiple items.

Body: `{ "ids": [1,2,3], "category": "jingle" }`

### `POST /library/bulk/favorite`
Toggle favorite for multiple items.

Body: `{ "ids": [1,2,3], "favorite": true }`

---

## Customers

### `GET /customers`
List all customers.

### `POST /customers`
Create customer.

Body: `{ "name", "email?", "phone?", "address?", "account_manager_id?", "notes?" }`

### `PATCH /customers/:id`
Update customer.

---

## Campaigns

### `GET /campaigns?customer_id=5`
List campaigns. `customer_id` filter optional.

### `POST /campaigns`
Create campaign with all constraints.

Body:
```json
{
  "customer_id": 5,
  "name": "Summer Sale",
  "starts_on": "2026-06-01",
  "ends_on": "2026-08-31",
  "plays_per_month": 120,
  "plays_per_day": 5,
  "time_window_start": "06:00",
  "time_window_end": "22:00",
  "days_of_week": [1,2,3,4,5],
  "priority": "hard",
  "first_in_slot": false,
  "competing_exclusions": [12, 15],
  "advertiser_separation": 3
}
```

### `PATCH /campaigns/:id`
Update campaign. Automatically syncs bidirectional `competing_exclusions`.

### `POST /campaigns/:id/media`
Add a spot or sweep to campaign.

Body: `{ "media_id": 88, "play_as_spot": true, "play_as_sweep": false }`

### `DELETE /campaigns/:id/media/:media_id`
Remove spot/sweep from campaign.

### `GET /campaigns/:id/pacing`
Current delivery pacing.

Response: `{ "plays_this_month": 42, "target": 120, "pacing_ratio": 0.35, "on_track": false }`

---

## Icecast

### `GET /icecast/config`
Parsed Icecast config as structured JSON.

### `POST /icecast/config`
Save config and restart Icecast.

### `GET /icecast/config/raw`
Raw XML string.

### `POST /icecast/config/raw`
Save raw XML string.

### `GET /icecast/stats`
Live stats from Icecast admin API.

Response: `{ "listeners": 12, "bitrate": 128, "uptime": 3600, "mounts": [...] }`

### `POST /icecast/restart`
Restart Icecast daemon.

### `POST /icecast/mounts/kick`
Force-disconnect a stale source from a mount. Used for SSL source bug workaround.

Body: `{ "mount": "/radio" }`

---

## LiquidSoap

### `GET /liquidsoap/config`
Structured LiquidSoap config.

### `POST /liquidsoap/config`
Save config and regenerate radio.liq.

### `GET /liquidsoap/script/raw`
Raw radio.liq script.

### `POST /liquidsoap/script/raw`
Save raw script (bypasses structured config).

### `GET /liquidsoap/status`
`{ "on_air": true, "reachable": true }`

### `POST /liquidsoap/restart`
Restart LiquidSoap daemon.

---

## Users

### `GET /users`
List all users.

### `POST /users`
Create user.

Body: `{ "first_name", "last_name", "email", "account_name", "title?" }`

### `GET /users/:id`
Get single user.

### `PATCH /users/:id`
Update user.

### `DELETE /users/:id`
Delete user. Fails if referenced as account_manager on customers.

---

## Certificates

### `GET /certificates`
List certificate files in cert directory.

### `POST /certificates/upload`
Upload PEM file (cert or key).

### `GET /certificates/:name`
Inspect certificate details.

### `DELETE /certificates/:name`
Remove certificate file.
