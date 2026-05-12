# Audio Ingest Pipeline

Handles uploading audio files and processing them into the media library.

## Pipeline Steps

```
Upload (multipart) → Analyze (ffprobe) → [Transcode (ffmpeg)] → Move to Library → Insert DB Row → Complete
```

### 1. Upload
`POST /library/upload` — multipart form data with `category` + `files[]`.

Files are streamed to a staging directory (temp location). An `ingest_job` row is created per file with `status = 'queued'`.

### 2. Analyze
Worker dequeues the job and runs `ffprobe` against the staged file.

Extracts:
- Duration (seconds)
- Bitrate (kbps)
- Sample rate (Hz)
- Channels (mono/stereo)
- Integrated loudness (LUFS) — EBU R128
- Loudness range (LU)
- True peak (dBTP)

Job status → `'analyzing'`

### 3. Transcode Decision
If the file is not MP3 or exceeds target bitrate, it's marked for transcoding. `ffmpeg` is invoked with:
- Loudness normalization (target -16 LUFS, max true peak -1 dBTP)
- Output: MP3, configurable bitrate (CBR/VBR)
- Channel handling: stereo preserved or folded to mono based on config

Job status → `'transcoding'`

If no transcode needed, the original file is used directly.

### 4. Move to Library
Final file is moved (or copied from transcode output) to:
```
/media/<sha256>.mp3
```

SHA256 hash is computed for deduplication. If a file with the same hash already exists, the upload is associated with the existing media row.

### 5. Database Insert
A `media` row is created with all analyzed metadata. `ingest_job.media_id` is set.

### 6. Complete
Job status → `'completed'`. The UI polls `ingest_jobs` every 2s while jobs are pending, and stops once all are complete.

On failure at any step: status → `'failed'`, `error_message` set.

---

## Key Files

```
apps/api/src/services/ingest/
  queue.ts       Job queue, worker management
  transcode.ts   ffmpeg invocation + options
  loudnorm.ts    EBU R128 loudness measurement + normalization
  paths.ts       Staging dir, media dir, path construction
  hash.ts        SHA256 computation
```

---

## Cue Points

After ingest, operators can set cue points in LibraryBrowse:
- `cue_in` — seconds from start to skip silence/intro
- `cue_out` — seconds from start to begin fade (avoids silence at end)

LiquidSoap uses these via the `annotate:` mechanism:
```
annotate:liq_cue_in="1.5",liq_cue_out="178.2":/media/abc123.mp3
```

---

## Loudness & Normalization

All media is measured at EBU R128 standard:
- **Integrated loudness (LUFS)**: overall perceived loudness
- **Loudness range (LU)**: dynamic variation
- **True peak (dBTP)**: highest sample value

Stored in `media.loudness_lufs/lra/peak`. LiquidSoap uses these for broadcast-grade normalization across tracks.

Operators can re-measure (`POST /library/:id/re-measure`) if they edit cue points or suspect incorrect values.
