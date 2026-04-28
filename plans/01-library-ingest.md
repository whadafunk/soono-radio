# Plan: Library & Ingest Pipeline

**Status:** Phases 1, 2, 3, 4 shipped. Phase 5 next.
**Last reviewed:** 2026-04-28
**Depends on:** Liquidsoap integration (shipped in commit `76fc39e`).
**Unblocks:** supervisor + scheduler, clocks/schedules, ad rotation, reports.

---

## Goal

Operators upload audio files. The system stores them, normalises loudness
non-destructively, makes them searchable, and exposes them to the playout
engine for scheduled and live use.

---

## Locked decisions

- **ORM**: Drizzle (TypeScript-first, SQLite + Postgres compatible, Zod-friendly).
- **DB location**: `data/radio.db` at repo root, gitignored, mounted into API container later.
- **Storage layout**: content-addressed, `media/<sha256>.mp3`, all files stored as MP3.
- **Storage format**: always MP3. Re-encode only if the input is non-MP3 (FLAC/WAV/etc.) or MP3 > 256 kbps. Cap is **MP3 256 kbps CBR**. Original MP3 ≤ 256 is moved through unmodified.
- **Loudness target**: −23 LUFS integrated (EBU R128 broadcast standard).
- **Normalisation method**: **ReplayGain-style.** Measure once at ingest, store gain + measurements in DB. Apply gain in Liquidsoap at playout. **Zero re-encoding for loudness purposes.** Re-encoding only happens for the bitrate cap.
- **Loudness measurement tool**: ffmpeg `loudnorm` filter, single pass for measurement, parsing JSON output.
- **Categories**: `music`, `jingle`, `ad`, `intro`, `promo`, `voice`, `bed`, `recording`.
- **Sidebar**: Library gets its own top-level entry (peer to Dashboard, Settings, Certificates).
- **AcoustID/MusicBrainz**: deferred to Phase 6.

---

## Architecture

```
                    operator browser
                          │
                          │  multipart upload
                          ▼
                ┌─────────────────────┐
                │   /library/upload   │
                │   (Fastify route)   │
                └──────────┬──────────┘
                           │ writes file to data/incoming/<job-id>
                           │ inserts ingest_jobs row, status=queued
                           │ returns { job_id }
                           ▼
                ┌─────────────────────┐
                │  Ingest worker      │
                │  (in-process,       │
                │   tickless queue)   │
                │  - ffprobe          │
                │  - ffmpeg loudnorm  │
                │   (measure only)    │
                │  - sha256(file)     │
                │  - transcode if     │
                │    needed → mp3 256 │
                │  - move to          │
                │    media/<sha>.mp3  │
                │  - write media row  │
                │  - mark job done    │
                └─────────────────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │   data/radio.db     │
                │   (SQLite WAL)      │
                └─────────────────────┘
                           │
                           ▼
                  /library/* routes
                   (browse, search,
                    filter, edit)
```

**Key design points:**

- **Single in-process worker** — not Redis/BullMQ. Phase 2+ may move to a queue when uploads scale, but a serialised in-process worker is enough today and adds zero ops overhead.
- **`data/incoming/<job-id>`** is the staging area; files only land in `media/` after successful ingest. On failure, the staging file is kept for debugging and can be requeued.
- **Hash deduplication** — if a file with the same sha256 already exists, the upload short-circuits to "already in library" without re-encoding. Saves disk and time.
- **Idempotent retries** — re-running a failed job picks up from the staging file, doesn't re-upload.

---

## DB schema (Drizzle, SQLite)

```ts
// apps/api/src/db/schema.ts (sketch — finalised in code)

media = sqliteTable('media', {
  id:             integer('id').primaryKey({ autoIncrement: true }),
  sha256:         text('sha256').notNull().unique(),         // content address
  category:       text('category', {                         // enum
    enum: ['music', 'jingle', 'ad', 'intro', 'promo', 'voice', 'bed', 'recording']
  }).notNull(),

  // Display metadata (editable by operator)
  title:          text('title'),
  artist:         text('artist'),
  album:          text('album'),
  genre:          text('genre'),
  year:           integer('year'),
  notes:          text('notes'),

  // Technical metadata (immutable, set at ingest)
  original_filename: text('original_filename').notNull(),
  duration_seconds: real('duration_seconds').notNull(),
  bitrate_kbps:     integer('bitrate_kbps').notNull(),
  samplerate_hz:    integer('samplerate_hz').notNull(),
  channels:         integer('channels').notNull(),
  filesize_bytes:   integer('filesize_bytes').notNull(),
  was_transcoded:   integer('was_transcoded', { mode: 'boolean' }).notNull(),

  // Loudness (measured at ingest, applied at playout)
  loudness_lufs:    real('loudness_lufs'),                  // integrated
  loudness_lra:     real('loudness_lra'),                   // loudness range
  loudness_peak:    real('loudness_peak'),                  // true peak (dBFS)
  loudness_gain_db: real('loudness_gain_db'),               // target − measured
  loudness_warning: text('loudness_warning'),               // null or human msg

  // Cue points (Phase 4 — placeholder columns now, edited later)
  cue_in_seconds:   real('cue_in_seconds'),
  cue_out_seconds:  real('cue_out_seconds'),
  intro_seconds:    real('intro_seconds'),
  outro_seconds:    real('outro_seconds'),

  // Bookkeeping
  play_count:       integer('play_count').notNull().default(0),
  last_played_at:   integer('last_played_at', { mode: 'timestamp' }),
  favorite:         integer('favorite', { mode: 'boolean' }).notNull().default(false),
  created_at:       integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at:       integer('updated_at', { mode: 'timestamp' }).notNull(),
});

// Indexes:
//  - sha256 (unique, already implied)
//  - category (filter)
//  - title, artist (search — start with LIKE; add FTS later)
//  - last_played_at, play_count (rotation lookups)

ingest_jobs = sqliteTable('ingest_jobs', {
  id:               text('id').primaryKey(),                // ULID
  status:           text('status', {
    enum: ['queued', 'analyzing', 'transcoding', 'completed', 'failed']
  }).notNull().default('queued'),

  uploaded_filename: text('uploaded_filename').notNull(),
  uploaded_size_bytes: integer('uploaded_size_bytes').notNull(),
  staging_path:      text('staging_path').notNull(),         // data/incoming/<id>

  // Filled in as the job progresses
  category:         text('category').notNull(),
  detected_format:  text('detected_format'),                 // 'mp3', 'flac', etc.
  detected_bitrate: integer('detected_bitrate'),             // kbps
  needs_transcode:  integer('needs_transcode', { mode: 'boolean' }),

  measured_lufs:    real('measured_lufs'),
  measured_lra:     real('measured_lra'),
  measured_peak:    real('measured_peak'),

  // Outcome
  media_id:         integer('media_id'),                     // FK on success
  error_message:    text('error_message'),                   // on failure

  created_at:       integer('created_at', { mode: 'timestamp' }).notNull(),
  started_at:       integer('started_at', { mode: 'timestamp' }),
  completed_at:     integer('completed_at', { mode: 'timestamp' }),
});

// Foreign key: ingest_jobs.media_id → media.id (nullable)
```

**Reasoning for the splits:**

- `media` is the *content* table. It's what the rest of the system queries. Lots of indexes.
- `ingest_jobs` is the *workflow* table. Append-mostly, rarely indexed beyond `status`. Decoupled so failed/in-progress jobs don't pollute library queries.
- Separating measurements at job time vs final at media time means we can re-ingest the same file (different gain target?) without losing the audit of the original measurement.
- All audio-technical fields (`bitrate_kbps`, `samplerate_hz`, etc.) are *immutable at ingest* — display fields (`title`, `notes`, `favorite`) are editable. UI should reflect this.

---

## Loudness pipeline (the careful bit)

Per file, on ingest:

```
1. ffmpeg -i input -af loudnorm=I=-23:LRA=20:TP=-1:print_format=json -f null -
   → parse JSON output for: input_i, input_lra, input_tp, target_offset

2. gain_db = -23 - input_i        (signed; usually negative for modern content)

3. predicted_post_peak = input_tp + gain_db

4. if predicted_post_peak > -1 dBFS:
     warning = "would clip if linear-applied; loudnorm flagged"
   else:
     warning = null

5. Store in media row:
     loudness_lufs    = input_i
     loudness_lra     = input_lra
     loudness_peak    = input_tp
     loudness_gain_db = gain_db
     loudness_warning = warning
```

At playout time, Liquidsoap reads `loudness_gain_db` and applies it as a single
multiplier (`amplify(amp, source)`). No limiter, no compression. If the
warning is set, the operator sees a flag in the library UI and can either
accept the clipping risk or replace the file.

**Important:** we measure but **do not apply** at ingest. The MP3 file is
stored unmodified (or transcoded, if input was FLAC / >256 — but the transcode
preserves loudness). Gain is purely metadata until playout.

---

## Phases (each = one merge unit)

### Phase 1 — DB foundation ✅ shipped (commit 7f5fc84)
- Add Drizzle + better-sqlite3 deps to `apps/api`
- `apps/api/drizzle.config.ts`
- `apps/api/src/db/schema.ts` — `media` and `ingest_jobs` tables
- `apps/api/src/db/index.ts` — connection module (WAL mode, migrations on boot)
- First migration generated and committed
- Zod inference exported from `packages/shared/src/schemas/library.ts`
- `data/` dir created and gitignored
- **No application code yet.** Reviewable as just SQL/schema files.

### Phase 2 — ingest worker ✅ shipped (commit a1b8790)
- `apps/api/src/services/ingestWorker.ts` — single-flight queue
- ffprobe wrapper, ffmpeg loudnorm wrapper (both as small services)
- sha256 streaming hash
- transcode-if-needed logic
- file move to `media/<sha>.mp3`
- `media` row insert
- CLI driver for testing without the HTTP layer

### Phase 3 — upload endpoint ✅ shipped
- `POST /library/upload` — multipart, hands off to ingest worker, returns job ID
- `GET /library/ingest/:id` — job status polling
- Bare-bones upload page in UI (no fancy library UI yet — just "drop file, see status")

### Phase 4 — library browse API + UI ✅ shipped
- `GET /library` — list with category filter, search, sort, pagination
- `GET /library/:id` — full detail
- `PATCH /library/:id` — edit display metadata (title/artist/notes/favorite/category)
- New sidebar entry "Library"
- Browse page: filterable table, customisable columns, search, multi-select

### Phase 5 — library actions
- `DELETE /library/:id` — remove row + file
- `POST /library/:id/re-transcode` — re-run transcode at new target (rare)
- `POST /library/:id/re-measure` — re-run loudness measurement
- Bulk actions in UI (multi-select → delete, re-measure, change category)

### Phase 6 — public DB lookup (deferred)
- AcoustID `fpcalc` integration
- MusicBrainz lookup
- "Update from public DB" button per file
- Bulk re-tag

---

## Files to create / modify (Phase 1)

### Create
| File | Purpose |
|---|---|
| `apps/api/drizzle.config.ts` | Drizzle Kit config — points at `src/db/schema.ts` |
| `apps/api/src/db/schema.ts` | Drizzle table definitions |
| `apps/api/src/db/index.ts` | DB connection (better-sqlite3, WAL, migrate on boot) |
| `apps/api/drizzle/0000_initial.sql` | Generated initial migration |
| `apps/api/drizzle/meta/*.json` | Drizzle Kit metadata |
| `packages/shared/src/schemas/library.ts` | Zod schemas inferred from Drizzle |
| `data/.gitkeep` | Reserve the directory |

### Modify
| File | Change |
|---|---|
| `apps/api/package.json` | Add `drizzle-orm`, `better-sqlite3`; dev: `drizzle-kit` |
| `apps/api/src/index.ts` | Initialise DB connection on boot, run pending migrations |
| `packages/shared/src/index.ts` | Re-export library schemas |
| `.gitignore` | Add `data/radio.db`, `data/radio.db-*`, `data/incoming/`, `media/` |

---

## Phase 1 verification

1. `pnpm install` — new deps install cleanly.
2. `cd apps/api && pnpm exec drizzle-kit generate` — produces migration SQL; commit it.
3. Start the API (`pnpm dev`); on boot it creates `data/radio.db` and applies migrations.
4. `sqlite3 data/radio.db ".schema"` shows `media` and `ingest_jobs` tables with expected columns.
5. `pnpm type-check` passes across the workspace.
6. No new application routes are exposed yet — confirm `curl /library` returns 404.

---

## Out of scope for Phase 1

- Any HTTP route under `/library/*` — Phase 3.
- Any UI changes — Phase 3+.
- ffmpeg/ffprobe shell-out — Phase 2.
- AcoustID — Phase 6.
- Cue point editing — Phase 4 (columns reserved now).
- Per-track gain trim UI — Phase 5 (column reserved now via `loudness_gain_db`).

---

## Open questions (none currently blocking Phase 1)

- **Postgres migration trigger**: when do we move off SQLite? (See `00-architecture-overview.md` §9.)
- **Re-measurement strategy**: when target LUFS changes (e.g., we move from −23 to −16), do we batch-update all gains, or only on demand? (Phase 5 decision.)
- **Cue point auto-detection**: Phase 4 will face the question of silence-detection at the head/tail for `cue_in_seconds`/`cue_out_seconds`. Defer the call.
