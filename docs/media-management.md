# Media Management

This document covers the conceptual model behind the library and playlist system — what the categories mean, how playlists are organised, and how the two layers relate.

---

## Library: Media Categories

Every audio file in the library belongs to exactly one **media category**. The category determines where the file can be used in scheduling and which playlists it can appear in.

| Category | Label in UI | Meaning |
|---|---|---|
| `music` | Music | Songs played in music segments |
| `jingle` | Jingle | Short imaging clip played between tracks, at show open/close, or as a station ID |
| `showenv` | Show Envelope | Show intro/outro identity clips (played once per show lifecycle, not from a playlist) |
| `spot` | Spot | Commercial advertisement |
| `promo` | Promo | Station or show promotional clip |
| `bed` | Bed | Background music played under live/voice segments |
| `recording` | Recording | Pre-recorded show content |

The category is set at upload time and can be changed afterwards via the library detail drawer or bulk actions.

### Jingle vs Show Envelope (`showenv`)

`jingle` and `showenv` are the two imaging categories:

- **`jingle`** — any short clip that can be picked by the scheduler from a playlist: between-track stings, show openers, show closers, station IDs. Which role a jingle plays is determined by the **playlist subcategory** it lives in (see below), not by its media category.
- **`showenv`** — the unique opener and closer identity clips attached directly to a show record (`shows.intro_media_id`, `shows.outro_media_id`). These are played once per show lifecycle and are not held in playlists.

---

## Playlists: Two-Level Organisation

Playlists are curated or dynamically-generated collections of media files. They sit between the raw library and the scheduler: the scheduler picks from playlists, not directly from the library.

### Playlist type

Every playlist has a **type** that determines which media category it draws from:

| Playlist type | Draws from category | Notes |
|---|---|---|
| `music` | `music` | Main song playlists |
| `jingle` | `jingle` | Imaging clip playlists; subcategory determines the role |
| `spot` | `spot` | Commercial break content |
| `promo` | `promo` | Promotional clips |
| `bed` | `bed` | Background music beds |
| `recording` | `recording` | Pre-recorded shows |

### Playlist subcategory

Some playlist types support an optional **subcategory** that refines meaning:

**Music subcategories**

| Subcategory | Meaning |
|---|---|
| `standard` | Normal rotation pool |
| `hot_play` | Tracks injected more frequently via the hot-play mechanism on a rotation |
| `heavy_rotation` | Tracks promoted by active music campaigns |

**Jingle subcategories** — these describe when/how the clips are used, not what they contain (all draw from `jingle` media):

| Subcategory | Role |
|---|---|
| `show` | Between-track stings during a show |
| `opener` | Show opening sting played at the top of a show |
| `closer` | Show closing sting played at the end of a show |
| `stationid` | Station identification clips ("You're listening to…") |

Spot, promo, bed, and recording playlists have no subcategories.

### Playlist kind

Each playlist is either **static** or **dynamic**:

- **Static**: a manually curated ordered track list. The operator adds, removes, and reorders tracks by hand.
- **Dynamic**: a rule set (genre, artist, BPM, mood, tags, etc.) that is evaluated at play time to produce a filtered pool. Only available for music playlists.

### Default playlists

For types that support it (`music`, `jingle`, `bed`), one playlist per (type, subcategory) can be marked as **default**. The scheduler uses the default when a clock segment or show doesn't specify an explicit playlist. Setting a new default automatically demotes the previous one.

---

## How library and playlists connect

| Media category | Goes into playlist type | Default subcategory |
|---|---|---|
| `music` | `music` | `standard` |
| `jingle` | `jingle` | `show` |
| `showenv` | *(not in playlists — attached directly to the show)* | — |
| `spot` | `spot` | — |
| `promo` | `promo` | — |
| `bed` | `bed` | — |
| `recording` | `recording` | — |

The mapping is implemented in `playlistMediaCategory(type, subcategory)` in `packages/shared/src/schemas/playlists.ts`. All jingle subcategories map back to the `jingle` media category — the subcategory encodes the scheduling role, not the media type.

---

## File storage

Audio files are stored on disk at `data/media/<sha256>.mp3` (or the appropriate extension after transcoding). Deleting a library item removes both the database row and the file — there is no trash or soft-delete. The SHA256 hash serves as the filename, which provides natural deduplication: uploading the same audio file twice produces one file and one media row.
