# Reports — Recordings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The station's output is recorded continuously to MP3 files the operator can find by date and time, play, download, protect and purge, from a new Reports page.

**Architecture:** The mix engine writes the files itself through a second, guarded output next to the Icecast one. The files on disk are the only source of truth: the API lists, serves, joins and deletes them, and two small tables hold what the files cannot (holds, and when the station was off air). An hourly sweep enforces retention and a disk floor. The web app gets a Reports page with three tabs, of which Recordings is built.

**Tech Stack:** LiquidSoap 2.2.5 (`output.file`), Fastify, Drizzle + libsql (`drizzle-kit generate`), Zod (`apps/shared`), ffmpeg (already in the API image), React + React Query, vitest (`apps/api`).

**Spec:** `docs/reports-recordings-design.md` (depends on `docs/station-timezone-design.md`, already deployed)

## Global Constraints

- Format is always MP3. Defaults: **64 kbps, 22.05 kHz, mono**, one file per **60** minutes. Recording is **on by default**.
- File length options: **15, 30 or 60** minutes only. No size-based rotation.
- Offered bitrates: 32 / 48 / 64 / 96 / 128 / 192. Sample rates: 22050 / 32000 / 44100. Combinations MP3 cannot encode are not offered: at 22050 Hz the bitrate must be ≤ 160; at 32000 and 44100 Hz it must be ≥ 32.
- Files live in `/recordings/<UTC date>/<UTC start>Z.mp3`, e.g. `/recordings/2026-11-24/2026-11-24T23-00-00Z.mp3`. The mix engine container runs with `TZ=UTC`.
- Everything the operator sees or types (day listing, `?date=`, hold ranges, "older than a date", download names) is **station time** — `station_settings.timezone` via the process's local time and the helpers in `apps/api/src/services/supervisor2/localDay.ts` and `@soono/shared` (`localYmd`, `addDaysYmd`). Follow the "Time and timezone" rules in `CLAUDE.md`.
- Retention defaults: `retention_days` 60, `min_free_gb` 10, `protected_days` 30 (never above `retention_days`).
- **Recording must never take the stream down, never fail silently, and automatic deletion must never remove a held recording.**
- No browser pop-ups: every confirmation is inline in the page.
- Text contrast: `text-zinc-400` minimum for hints, `text-zinc-300` for content (`CLAUDE.md`).
- Migrations only via `cd apps/api && pnpm drizzle-kit generate`.
- `apps/shared` resolves to `dist/`: run `pnpm --filter @soono/shared build` after changing it.
- No `any`, no `console.log`, no `// TODO`, no unused exports.
- Do not commit, push or deploy unless Daniel asks; each task ends "stage and report".
- The live station is never touched by this plan. LiquidSoap experiments run in throwaway `savonet/liquidsoap:v2.2.5` containers.

## What the gate test already established (2026-11-25, throwaway container)

The design made stream safety a gate. It was run while writing this plan; Task 1 re-runs it against the real generated script. Findings, all on LiquidSoap 2.2.5:

- `output.file` does **not** expand `%Y…` in a plain string file name. The name must be a getter: `{time.string("/recordings/%Y-%m-%d/%Y-%m-%dT%H-%M-%SZ.mp3")}`.
- `reopen_when={0m0s}` rotates on the predicate; `reopen_delay` (default 120 s) only limits how often, so the default is fine for 15-minute files.
- `%mp3(bitrate=64, samplerate=22050, stereo=false)` fed by `mean(radio)` produces 64 kbps / 22.05 kHz / mono files (checked with ffprobe).
- **A plain recording output kills the whole mix engine if the folder is unwritable at start** (`Source output_file failed while starting` → exit). `fallible=true` and `reopen_on_error` do not cover a failure at start.
- The guarded form survives all three failure cases with the main output still running: **(a)** folder read-only at start → recording off, stream unaffected; **(b)** disk fills mid-run → write errors, retry every few seconds, stream unaffected; **(c)** normal → rotation works.

```
def recordings_writable() =
  try
    file.write(data="", "/recordings/.write-test")
    true
  catch _ do
    false
  end
end

if recordings_writable() then
  output.file(
    <encoder>, {time.string("/recordings/%Y-%m-%d/%Y-%m-%dT%H-%M-%SZ.mp3")},
    reopen_when=<predicate>, fallible=true,
    reopen_on_error=fun (_) -> begin log.important(label="recording", "recording write failed; retrying in 10s"); 10. end,
    <radio, or mean(radio) for mono>
  )
else
  log.severe(label="recording", "recordings folder is not writable; recording is OFF, the stream is unaffected")
end
```

Known limit, accepted: if the folder is unwritable at start and becomes writable later, recording stays off until the mix engine restarts. The health warning (Task 5) is what makes that visible.

## Review Focus

1. **A file or day parameter that tries to leave the recordings folder** (`../../data/radio.db`, an absolute path, a name that is not a recording): refused with 400, nothing read or deleted. → Task 4.
2. **The recordings folder is missing, empty or unreadable** (first boot, volume not mounted): listing returns an empty day, status says recording is not happening, nothing returns 500 and the sweep does nothing. → Tasks 2, 3, 5.
3. **A station day is not a UTC day**: 24 November in Bucharest runs 22:00Z on the 23rd to 22:00Z on the 24th and reads from two folders; on the two clock-change days it is 23 or 25 hours. → Task 2.
4. **Stray files in the folder** (`.write-test`, a half-copied file, something a person dropped there): never listed, never counted, never deleted by the sweep or a purge. → Tasks 2, 3.
5. **A range download that is empty, backwards, enormous, or crosses a quality change or the file being written**: backwards/empty/over 24 hours → 400; otherwise a playable MP3 and an honest list of the gaps inside it. → Task 4.

---

### Task 1: The mix engine records

**Files:**
- Modify: `apps/shared/src/schemas/liquidsoap.ts` (new `recording` block and constants)
- Create: `apps/api/src/services/recordingScript.ts`
- Create: `apps/api/src/services/recordingScript.test.ts`
- Modify: `apps/api/src/services/liquidsoapConfig.ts` (`renderScript` context)
- Modify: `liquidsoap/mix-engine.liq.hbs` (after the `output.icecast(...)` block)
- Modify: `docker-compose.yml` (liquidsoap: `TZ: UTC`, `./recordings:/recordings`; soono-api: `./recordings:/recordings`)
- Modify: `.gitignore` (`recordings/`)

**Interfaces:**
- Produces from `@soono/shared`:
  - `RECORDING_BITRATES = [32, 48, 64, 96, 128, 192] as const`, `RECORDING_SAMPLE_RATES = [22050, 32000, 44100] as const`, `RECORDING_SEGMENT_MINUTES = [15, 30, 60] as const`
  - `isValidRecordingQuality(bitrateKbps: number, samplerateHz: number): boolean` — both values must be in the offered lists, and the pair must satisfy the MP3 limits in Global Constraints
  - `LiquidsoapConfigSchema.recording`: `{ enabled: boolean (default true), bitrate_kbps (default 64), samplerate_hz (default 22050), channels: 'mono' | 'stereo' (default 'mono'), segment_minutes (default 60) }`, the whole block `.default({})`, refined with `isValidRecordingQuality`; type `RecordingConfig`
- Produces from `recordingScript.ts` (pure):
  - `recordingEncoder(r: RecordingConfig): string`
  - `recordingReopenPredicate(segmentMinutes: 15 | 30 | 60): string`
  - `recordingSource(r: RecordingConfig): string` — `'radio'` or `'mean(radio)'`

- [ ] **Step 1: Write the failing tests** in `recordingScript.test.ts`

```ts
const base = { enabled: true, bitrate_kbps: 64, samplerate_hz: 22050, channels: 'mono', segment_minutes: 60 } as const;

it('builds the default encoder', () => {
  expect(recordingEncoder(base)).toBe('%mp3(bitrate=64, samplerate=22050, stereo=false)');
});
it('builds a stereo encoder', () => {
  expect(recordingEncoder({ ...base, bitrate_kbps: 128, samplerate_hz: 44100, channels: 'stereo' }))
    .toBe('%mp3(bitrate=128, samplerate=44100, stereo=true)');
});
it('feeds mono from the mean of both channels', () => {
  expect(recordingSource(base)).toBe('mean(radio)');
  expect(recordingSource({ ...base, channels: 'stereo' })).toBe('radio');
});
it('rotates on clock boundaries', () => {
  expect(recordingReopenPredicate(60)).toBe('{0m0s}');
  expect(recordingReopenPredicate(30)).toBe('{0m0s or 30m0s}');
  expect(recordingReopenPredicate(15)).toBe('{0m0s or 15m0s or 30m0s or 45m0s}');
});
describe('isValidRecordingQuality', () => {
  it.each([[64, 22050], [128, 22050], [32, 44100], [192, 44100], [128, 32000]])('accepts %i kbps at %i Hz', (b, s) => {
    expect(isValidRecordingQuality(b, s)).toBe(true);
  });
  it.each([[192, 22050], [16, 44100], [64, 48000], [0, 22050]])('rejects %i kbps at %i Hz', (b, s) => {
    expect(isValidRecordingQuality(b, s)).toBe(false);
  });
});
it('defaults the recording block when the stored config has none', () => {
  const parsed = LiquidsoapConfigSchema.parse(existingConfigWithoutRecording);
  expect(parsed.recording).toEqual(base);
});
```

`existingConfigWithoutRecording` is the repo's `liquidsoap/supervisor.json` read from disk — the test proves an old config file still loads.

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @soono/shared build; pnpm --filter api test -- recordingScript` → FAIL, module not found.
- [ ] **Step 3: Implement** the shared block and `recordingScript.ts`; add `recording_enabled`, `recording_encoder`, `recording_reopen_when`, `recording_source` to the `renderScript` context.
- [ ] **Step 4: Run to verify they pass** — same command → PASS.
- [ ] **Step 5: Template.** Append the guarded block from "What the gate test already established" to `mix-engine.liq.hbs`, inside `{{#if recording_enabled}}`, using the three context values. Comment it with why it is guarded.
- [ ] **Step 6: Compose and gitignore.** As listed under Files. The API's mount is read-write (it deletes files).
- [ ] **Step 7: Re-run the gate against the real script.** Generate the script from the repo's config (boot the API on a scratch DB copy with `RADIO_DB_PATH`, as in `plans/03`), then in a throwaway `savonet/liquidsoap:v2.2.5` container with `TZ=UTC`: `liquidsoap --check` on the generated file, and run it three ways with `/recordings` as (a) a writable tmpfs, (b) a read-only tmpfs, (c) a 400 KB tmpfs. The Icecast output will fail to connect there — replace only that block with a dummy `output.file(%mp3, "/main/main.mp3", radio)` on a tmpfs for the test copy.
  Expected: `--check` exits 0; in all three runs the container is still `running` after 35 s and `/main/main.mp3` keeps growing; (a) has a file named like `2026-…T…Z.mp3` that ffprobe reports as `mp3 / 22050 / 1 channel / 64000`; (b) logs `recording is OFF`; (c) logs `recording write failed`.
  **If any run stops the main output, stop and report to Daniel — that reopens the choice of approach.**
- [ ] **Step 8:** `pnpm type-check && pnpm --filter api test`; stage and report.

---

### Task 2: Reading the recordings folder

**Files:**
- Create: `apps/api/src/services/recordings/recordingIndex.ts` (pure)
- Create: `apps/api/src/services/recordings/recordingIndex.test.ts`
- Create: `apps/api/src/services/recordings/recordingStore.ts` (filesystem; the only module that touches `/recordings`)
- Modify: `apps/api/src/db/schema.ts` (table `station_air_events`) + generated migration
- Modify: `apps/api/src/routes/station.ts` (write an event on each switch)

**Interfaces:**
- Produces from `recordingIndex.ts`:
  - `interface RecordingFile { day: string; name: string; startMs: number; endMs: number; sizeBytes: number; recordingNow: boolean }`
  - `interface RecordingGap { startMs: number; endMs: number; label: 'off_air' | 'interruption' | 'no_recording' }`
  - `parseRecordingFileName(name: string): number | null` — UTC start in ms for `YYYY-MM-DDTHH-MM-SSZ.mp3`, else null
  - `isSafeRecordingRef(day: string, name: string): boolean` — `day` is `YYYY-MM-DD`, `name` parses, and the name's date equals `day`
  - `utcFoldersForWindow(fromMs: number, toMs: number): string[]` — the UTC dates from one hour before `fromMs` (the longest a file can be, so a file that started before the window is found) through `toMs`
  - `buildRecordingFiles(raw: Array<{ day: string; name: string; sizeBytes: number; mtimeMs: number }>, nowMs: number): RecordingFile[]` — sorted by start; drops names that do not parse; `endMs = min(mtimeMs, next file's startMs)`; the newest file is `recordingNow` when its `mtimeMs` is within 60 s of `nowMs`
  - `describeWindow(files: RecordingFile[], offAir: Array<{ fromMs: number; toMs: number | null }>, windowStartMs: number, windowEndMs: number): Array<({ kind: 'file' } & RecordingFile) | ({ kind: 'gap' } & RecordingGap)>` — files that overlap the window are returned whole, gaps are computed inside the window only; a gap overlapping an off-air period is `off_air`, otherwise under 120 000 ms is `interruption`, otherwise `no_recording`
- Produces from `recordingStore.ts`:
  - `RECORDINGS_DIR` (`process.env.RECORDINGS_DIR ?? '/recordings'`)
  - `listRawFiles(folders: string[]): Promise<Array<{ day; name; sizeBytes; mtimeMs }>>` — missing folders are skipped, never thrown
  - `listAllRawFiles(): Promise<…>`
  - `filePath(day: string, name: string): string` — throws unless `isSafeRecordingRef`
  - `deleteFile(day: string, name: string): Promise<void>`; removes the day folder when it becomes empty
  - `diskUsage(): Promise<{ freeBytes: number; totalBytes: number } | null>` (`fs.statfs`; null when the folder is missing)
- Produces: table `station_air_events(id, at_ms integer not null, state text 'off_air' | 'on_air')`, indexed on `at_ms`; and `offAirPeriods(db, fromMs, toMs): Promise<Array<{ fromMs: number; toMs: number | null }>>` in `recordingStore.ts`'s sibling `apps/api/src/services/recordings/airEvents.ts`

A file's length comes from its last-write time rather than size ÷ bitrate: it stays right when the quality setting changes between files, which the spec's formula would not. *(Plan decision; the spec's "or from the next file's start" is the same clamp.)*

- [ ] **Step 1: Write the failing tests** (`process.env.TZ = 'Europe/Bucharest'` on the first line)

```ts
const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);
const raw = (name: string, sizeBytes: number, mtimeMs: number) => ({ day: name.slice(0, 10), name, sizeBytes, mtimeMs });

describe('parseRecordingFileName', () => {
  it('reads the UTC start', () => {
    expect(parseRecordingFileName('2026-11-24T23-00-00Z.mp3')).toBe(utc(2026, 11, 24, 23));
  });
  it.each(['.write-test', 'notes.txt', '2026-11-24T23-00-00Z.mp3.part', '2026-13-40T99-00-00Z.mp3', '../x.mp3'])
    ('ignores %j', (n) => expect(parseRecordingFileName(n)).toBeNull());
});

describe('isSafeRecordingRef', () => {
  it('accepts a recording in its own day folder', () => {
    expect(isSafeRecordingRef('2026-11-24', '2026-11-24T23-00-00Z.mp3')).toBe(true);
  });
  it.each([
    ['..', '2026-11-24T23-00-00Z.mp3'], ['2026-11-24', '../../data/radio.db'],
    ['2026-11-24/..', '2026-11-24T23-00-00Z.mp3'], ['2026-11-25', '2026-11-24T23-00-00Z.mp3'],
    ['/etc', 'passwd'], ['2026-11-24', '.write-test'],
  ])('refuses %j / %j', (d, n) => expect(isSafeRecordingRef(d, n)).toBe(false));
});

describe('utcFoldersForWindow', () => {
  it('a Bucharest day spans two UTC folders', () => {
    expect(utcFoldersForWindow(utc(2026, 11, 23, 22), utc(2026, 11, 24, 22))).toEqual(['2026-11-23', '2026-11-24']);
  });
  it('includes the folder of a file that started before the window', () => {
    expect(utcFoldersForWindow(utc(2026, 11, 24, 0, 30), utc(2026, 11, 24, 1))).toEqual(['2026-11-23', '2026-11-24']);
  });
});

describe('buildRecordingFiles', () => {
  const now = utc(2026, 11, 24, 15, 20);
  const files = buildRecordingFiles([
    raw('2026-11-24T14-00-00Z.mp3', 28_800_000, utc(2026, 11, 24, 15, 0, 3)),
    raw('2026-11-24T13-00-00Z.mp3', 28_800_000, utc(2026, 11, 24, 14, 0, 2)),
    raw('2026-11-24T15-00-00Z.mp3', 9_600_000, utc(2026, 11, 24, 15, 19, 55)),
    { day: '2026-11-24', name: '.write-test', sizeBytes: 0, mtimeMs: now },
  ], now);
  it('sorts, drops strays, and clamps each end to the next start', () => {
    expect(files.map((f) => f.name)).toEqual(['2026-11-24T13-00-00Z.mp3', '2026-11-24T14-00-00Z.mp3', '2026-11-24T15-00-00Z.mp3']);
    expect(files[0].endMs).toBe(utc(2026, 11, 24, 14));
    expect(files[2].endMs).toBe(utc(2026, 11, 24, 15, 19, 55));
  });
  it('marks only a file still being written as recording now', () => {
    expect(files.map((f) => f.recordingNow)).toEqual([false, false, true]);
    expect(buildRecordingFiles([raw('2026-11-24T15-00-00Z.mp3', 1, utc(2026, 11, 24, 15, 10))], now)[0].recordingNow).toBe(false);
  });
  it('returns nothing for an empty folder', () => expect(buildRecordingFiles([], now)).toEqual([]));
});

describe('describeWindow', () => {
  const file = (h1: number, m1: number, h2: number, m2: number) => ({
    day: '2026-11-24', name: `2026-11-24T${String(h1).padStart(2, '0')}-${String(m1).padStart(2, '0')}-00Z.mp3`,
    startMs: utc(2026, 11, 24, h1, m1), endMs: utc(2026, 11, 24, h2, m2), sizeBytes: 1, recordingNow: false,
  });
  const window = [utc(2026, 11, 24, 13), utc(2026, 11, 24, 17)] as const;
  it('labels a gap that overlaps an off-air period', () => {
    const out = describeWindow([file(13, 0, 15, 20), file(16, 5, 17, 0)],
      [{ fromMs: utc(2026, 11, 24, 15, 20), toMs: utc(2026, 11, 24, 16, 5) }], ...window);
    expect(out.map((x) => x.kind === 'gap' ? x.label : 'file')).toEqual(['file', 'off_air', 'file']);
  });
  it('labels a short gap as an interruption and a long unexplained one as no recording', () => {
    const out = describeWindow([file(13, 0, 13, 59), file(14, 0, 15, 0), file(16, 0, 17, 0)], [], ...window);
    expect(out.map((x) => x.kind === 'gap' ? x.label : 'file')).toEqual(['file', 'interruption', 'file', 'no_recording', 'file']);
  });
  it('reports the whole window as one gap when there are no files', () => {
    expect(describeWindow([], [], ...window)).toEqual([{ kind: 'gap', startMs: window[0], endMs: window[1], label: 'no_recording' }]);
  });
  it('treats an off-air period that has not ended as running to the window end', () => {
    const out = describeWindow([file(13, 0, 14, 0)], [{ fromMs: utc(2026, 11, 24, 14), toMs: null }], ...window);
    expect(out[1]).toEqual({ kind: 'gap', startMs: utc(2026, 11, 24, 14), endMs: window[1], label: 'off_air' });
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter api test -- recordingIndex` → FAIL, module not found.
- [ ] **Step 3: Implement `recordingIndex.ts`.**
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: `recordingStore.ts` and `airEvents.ts`**, then the table: add `stationAirEvents` to `schema.ts`, `pnpm drizzle-kit generate` (expect one `CREATE TABLE` + index), and insert an event in both handlers of `routes/station.ts` right after the `paused` flag is written. `offAirPeriods` pairs each `off_air` with the next `on_air`; an unpaired last `off_air` yields `toMs: null`; an `off_air` before `fromMs` that is still open at `fromMs` is included.
- [ ] **Step 6:** `pnpm type-check && pnpm --filter api test`; stage and report.

---

### Task 3: Retention, disk floor and holds

**Files:**
- Create: `apps/api/src/services/recordings/sweepPlan.ts` (pure) and `sweepPlan.test.ts`
- Create: `apps/api/src/services/recordings/recordingSettings.ts` (reads/writes `data/recordings-config.json`, same shape of code as `services/logging/logConfig.ts`)
- Create: `apps/api/src/services/recordings/recordingSweep.ts` (runner; pattern of `startDbRetentionSweep`)
- Modify: `apps/api/src/db/schema.ts` (table `recording_holds`) + generated migration
- Modify: `apps/shared/src/schemas/` — new `recordings.ts`, exported from the index
- Modify: `apps/api/src/index.ts` (start the sweep next to `startDbRetentionSweep`)

**Interfaces:**
- Consumes: `RecordingFile`, `listAllRawFiles`, `buildRecordingFiles`, `deleteFile`, `diskUsage` (Task 2).
- Produces from `@soono/shared` (`recordings.ts`): `RecordingSettingsSchema` — `retention_days` int 1–3650 default 60, `min_free_gb` 0–10000 default 10, `protected_days` int 0–3650 default 30, refined `protected_days <= retention_days`; `RecordingHoldCreateSchema` — `{ from_ms, to_ms (> from_ms), note: string 1–200 }`; types.
- Produces: table `recording_holds(id, from_ms integer, to_ms integer, note text, created_at_ms integer)`.
- Produces from `sweepPlan.ts`:
  - `isHeld(file: { startMs: number; endMs: number }, holds: Array<{ fromMs: number; toMs: number }>): boolean` — any overlap
  - `planSweep(input: { files: RecordingFile[]; holds: Array<{ fromMs: number; toMs: number }>; nowMs: number; retentionDays: number; protectedDays: number; freeBytes: number; minFreeBytes: number }): { deletions: Array<{ day: string; name: string; reason: 'retention' | 'disk_floor' }>; floorUnmet: boolean }`
- Produces from `recordingSweep.ts`: `runRecordingSweep(logger): Promise<RecordingSweepResult>`, `startRecordingSweep(logger): void` (at boot, then hourly), `readLastRecordingSweep(): RecordingSweepResult | null` where the result is `{ at_ms, deleted_retention, deleted_disk_floor, floor_unmet }`.

- [ ] **Step 1: Write the failing tests** in `sweepPlan.test.ts`

```ts
const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 24, 12);
const f = (daysOld: number, sizeBytes = 100, recordingNow = false) => {
  const startMs = now - daysOld * DAY;
  return { day: 'd', name: `f${daysOld}`, startMs, endMs: startMs + 3_600_000, sizeBytes, recordingNow };
};
const base = { holds: [], nowMs: now, retentionDays: 60, protectedDays: 30, freeBytes: 1_000_000, minFreeBytes: 0 };

it('deletes only what is older than the retention', () => {
  const r = planSweep({ ...base, files: [f(61), f(59), f(1)] });
  expect(r.deletions).toEqual([{ day: 'd', name: 'f61', reason: 'retention' }]);
  expect(r.floorUnmet).toBe(false);
});
it('never deletes a held recording, however old', () => {
  const old = f(90);
  const r = planSweep({ ...base, files: [old], holds: [{ fromMs: old.startMs + 60_000, toMs: old.startMs + 120_000 }] });
  expect(r.deletions).toEqual([]);
});
it('never deletes the file being written', () => {
  expect(planSweep({ ...base, files: [f(90, 100, true)] }).deletions).toEqual([]);
});
it('frees space oldest-first until the floor is met', () => {
  const r = planSweep({ ...base, freeBytes: 50, minFreeBytes: 200, files: [f(50), f(45), f(40), f(35)] });
  expect(r.deletions).toEqual([{ day: 'd', name: 'f50', reason: 'disk_floor' }, { day: 'd', name: 'f45', reason: 'disk_floor' }]);
  expect(r.floorUnmet).toBe(false);
});
it('counts retention deletions toward the floor before deleting more', () => {
  const r = planSweep({ ...base, freeBytes: 50, minFreeBytes: 140, files: [f(61), f(50)] });
  expect(r.deletions).toEqual([{ day: 'd', name: 'f61', reason: 'retention' }]);
});
it('stops at the protected age and says the floor is unmet', () => {
  const r = planSweep({ ...base, freeBytes: 0, minFreeBytes: 1_000, files: [f(40), f(29), f(10)] });
  expect(r.deletions).toEqual([{ day: 'd', name: 'f40', reason: 'disk_floor' }]);
  expect(r.floorUnmet).toBe(true);
});
it('skips held files when freeing space and reports the floor unmet if that is all there is', () => {
  const held = f(50);
  const r = planSweep({ ...base, freeBytes: 0, minFreeBytes: 50, files: [held], holds: [{ fromMs: held.startMs, toMs: held.endMs }] });
  expect(r).toEqual({ deletions: [], floorUnmet: true });
});
it('does nothing with no files', () => {
  expect(planSweep({ ...base, files: [] })).toEqual({ deletions: [], floorUnmet: false });
});
```

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter api test -- sweepPlan` → FAIL.
- [ ] **Step 3: Implement `sweepPlan.ts`.** Age is measured from `endMs`. The floor pass walks the remaining files oldest-first, adding each deleted file's `sizeBytes` to free space.
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Settings, table, runner.** `recordingSettings.ts` (corrupt or missing file → defaults, never throws). `recording_holds` via `drizzle-kit generate`. `runRecordingSweep` gathers files, holds, disk usage and settings, calls `planSweep`, deletes, logs one line per deletion with its reason plus a summary, and stores the result in `data/recordings-config.json` under `last_sweep`. When `diskUsage()` is null (folder missing) it logs once at `warn` and deletes nothing. Start it in `index.ts` after the station timezone is applied.
- [ ] **Step 6:** `pnpm --filter @soono/shared build && pnpm type-check && pnpm --filter api test`; stage and report.

---

### Task 4: The API

**Files:**
- Create: `apps/api/src/routes/recordings.ts`; register it in `apps/api/src/index.ts`
- Create: `apps/api/src/services/recordings/rangeExport.ts` (ffmpeg) and `rangePlan.ts` (pure) + `rangePlan.test.ts`
- Modify: `apps/shared/src/schemas/recordings.ts` (response types)

**Interfaces:**
- Consumes: everything from Tasks 2 and 3; `parseLocalYmd`, `addLocalDaysMs` from `supervisor2/localDay.ts`; `localYmd`.
- Produces from `rangePlan.ts`:
  - `MAX_RANGE_MS = 24 * 3_600_000`
  - `planRange(files: RecordingFile[], fromMs: number, toMs: number): { parts: Array<{ day: string; name: string; skipMs: number; takeMs: number }>; gaps: Array<{ startMs: number; endMs: number }>; coveredMs: number } | { error: 'invalid_range' | 'too_long' | 'nothing_recorded' }`
- Produces (routes; all times in ms, all dates station-local `YYYY-MM-DD`):
  - `GET /recordings?date=` → `{ date, timezone, items: Array<file | gap>, holds }`, where each file item adds `held: boolean` and the window is that station day, ending at "now" for today
  - `GET /recordings/file/:day/:name` → the MP3, honouring `Range` (206) and `If-Range` not required; `?download=1` sets `Content-Disposition` with a station-time file name
  - `GET /recordings/range/preview?from=&to=` → `{ parts: number, covered_ms, gaps }`
  - `GET /recordings/range?from=&to=` → one MP3, `Content-Disposition` named `recording_<station from>_<station to>.mp3`
  - `DELETE /recordings/file/:day/:name`, `DELETE /recordings/day/:date`, `POST /recordings/purge { before: 'YYYY-MM-DD' }` → `{ deleted, skipped_held, skipped_active }`
  - `GET /recordings/status` → `{ enabled, on_air, mix_engine_running, healthy, newest_file_age_s | null, used_bytes, free_bytes | null, oldest_start_ms | null, last_sweep }`
  - `GET /recordings/settings`, `POST /recordings/settings`
  - `GET /recordings/holds`, `POST /recordings/holds`, `DELETE /recordings/holds/:id`

- [ ] **Step 1: Write the failing tests** in `rangePlan.test.ts`

```ts
const utc = (h: number, m = 0, s = 0) => Date.UTC(2026, 10, 24, h, m, s);
const file = (h1: number, m1: number, h2: number, m2: number) => ({
  day: '2026-11-24', name: `2026-11-24T${String(h1).padStart(2, '0')}-${String(m1).padStart(2, '0')}-00Z.mp3`,
  startMs: utc(h1, m1), endMs: utc(h2, m2), sizeBytes: 1, recordingNow: false,
});
const hours = [file(13, 0, 14, 0), file(14, 0, 15, 0), file(15, 0, 16, 0)];

it('trims the first and last file to the requested range', () => {
  const r = planRange(hours, utc(13, 30), utc(15, 15));
  expect(r).toEqual({
    parts: [
      { day: '2026-11-24', name: '2026-11-24T13-00-00Z.mp3', skipMs: 1_800_000, takeMs: 1_800_000 },
      { day: '2026-11-24', name: '2026-11-24T14-00-00Z.mp3', skipMs: 0, takeMs: 3_600_000 },
      { day: '2026-11-24', name: '2026-11-24T15-00-00Z.mp3', skipMs: 0, takeMs: 900_000 },
    ],
    gaps: [], coveredMs: 6_300_000,
  });
});
it('reports the gaps inside the range instead of hiding them', () => {
  const r = planRange([file(13, 0, 13, 40), file(14, 25, 15, 0)], utc(13), utc(15));
  expect('gaps' in r && r.gaps).toEqual([{ startMs: utc(13, 40), endMs: utc(14, 25) }]);
  expect('coveredMs' in r && r.coveredMs).toBe(75 * 60_000);
});
it('reports a missing start and a missing end as gaps too', () => {
  const r = planRange([file(14, 0, 15, 0)], utc(13), utc(16));
  expect('gaps' in r && r.gaps).toEqual([{ startMs: utc(13), endMs: utc(14) }, { startMs: utc(15), endMs: utc(16) }]);
});
it('takes a file that is still being written up to what exists', () => {
  const r = planRange([{ ...file(15, 0, 15, 20), recordingNow: true }], utc(15), utc(16));
  expect('parts' in r && r.parts).toEqual([{ day: '2026-11-24', name: '2026-11-24T15-00-00Z.mp3', skipMs: 0, takeMs: 1_200_000 }]);
});
it.each([[utc(15), utc(15)], [utc(16), utc(15)]])('refuses an empty or backwards range', (a, b) => {
  expect(planRange(hours, a, b)).toEqual({ error: 'invalid_range' });
});
it('refuses more than 24 hours', () => {
  expect(planRange(hours, utc(0), utc(0) + MAX_RANGE_MS + 1)).toEqual({ error: 'too_long' });
});
it('says so when nothing was recorded in the range', () => {
  expect(planRange(hours, utc(18), utc(19))).toEqual({ error: 'nothing_recorded' });
});
```

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter api test -- rangePlan` → FAIL.
- [ ] **Step 3: Implement `rangePlan.ts`.**
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: `rangeExport.ts`.** For each part run ffmpeg with `-ss <skip> -t <take> -i <file> -c copy -f mp3` into a temp file under `os.tmpdir()`, then join with the concat demuxer (`-f concat -safe 0 -c copy`) and stream the result; temp files are removed when the response ends or errors. Arguments are passed as an array to `spawn` — never through a shell. A range whose parts differ in quality is still joined with stream copy; if ffmpeg exits non-zero the route answers 500 with ffmpeg's last stderr line and the page shows it.
- [ ] **Step 6: Routes.** Every `:day/:name` and `:date` goes through `isSafeRecordingRef` / a strict `YYYY-MM-DD` check first → 400 on failure. `date`, `before`, `from`, `to` are validated with Zod. Deletes skip held files and the file being written and count both. The day delete and purge work on station days (`parseLocalYmd(date)` to `addLocalDaysMs(…, 1)`), selecting files whose `startMs` falls in the window.
- [ ] **Step 7: Verify against a real folder.** Boot the API on a scratch DB copy with `RECORDINGS_DIR` pointing at a scratch folder holding three real MP3s cut with ffmpeg (`ffmpeg -f lavfi -i sine -t 600 -b:a 64k -ar 22050 -ac 1 …`) named for the last three 10-minute marks of the current UTC hour, plus a `.write-test` and a `notes.txt`.
  Expected, with curl:
  - `GET /recordings?date=<today>` → exactly three file items, no stray names, gaps labelled.
  - `GET /recordings/file/<day>/<name>` with `Range: bytes=0-999` → `206`, `Content-Range: bytes 0-999/…`.
  - `GET /recordings/file/..%2F..%2Fdata/radio.db` and `GET /recordings/file/<day>/..%2F..%2Fdata%2Fradio.db` → `400`.
  - `GET /recordings/range?from=…&to=…` across two files → a file ffprobe reads as MP3 whose duration is within 1 s of the requested span.
  - `GET /recordings/range?from=X&to=X` → `400`.
  - `POST /recordings/holds` over the middle file, then `DELETE /recordings/day/<today>` → `skipped_held: 1`, the held file still on disk, `notes.txt` and `.write-test` untouched.
  - With `RECORDINGS_DIR` pointing at a path that does not exist: `GET /recordings?date=` → 200 with one `no_recording` gap; `GET /recordings/status` → 200 with `free_bytes: null`, `healthy: false`.
- [ ] **Step 8:** `pnpm type-check && pnpm --filter api test`; stage and report.

---

### Task 5: Knowing when recording has stopped

**Files:**
- Create: `apps/api/src/services/recordings/health.ts` (pure) + `health.test.ts`
- Modify: `apps/api/src/routes/recordings.ts` (`/recordings/status` uses it)
- Modify: `apps/web/src/pages/Dashboard.tsx`

**Interfaces:**
- Produces: `recordingHealth(input: { enabled: boolean; onAir: boolean; mixEngineRunning: boolean; newestFileMtimeMs: number | null; nowMs: number }): { healthy: boolean; reason: 'ok' | 'disabled' | 'off_air' | 'mix_engine_down' | 'not_recording' }` — `not_recording` when enabled, on air, mix engine running and the newest file is missing or has not grown for 60 000 ms.

- [ ] **Step 1: Write the failing tests**

```ts
const now = 1_000_000_000;
const base = { enabled: true, onAir: true, mixEngineRunning: true, newestFileMtimeMs: now - 5_000, nowMs: now };
it('is healthy while a file is growing', () => expect(recordingHealth(base)).toEqual({ healthy: true, reason: 'ok' }));
it('flags a file that stopped growing a minute ago', () =>
  expect(recordingHealth({ ...base, newestFileMtimeMs: now - 60_000 })).toEqual({ healthy: false, reason: 'not_recording' }));
it('flags no files at all', () =>
  expect(recordingHealth({ ...base, newestFileMtimeMs: null })).toEqual({ healthy: false, reason: 'not_recording' }));
it('is not a problem when the station is off air', () =>
  expect(recordingHealth({ ...base, onAir: false, newestFileMtimeMs: null })).toEqual({ healthy: true, reason: 'off_air' }));
it('is not a recording problem when the mix engine is down', () =>
  expect(recordingHealth({ ...base, mixEngineRunning: false, newestFileMtimeMs: null })).toEqual({ healthy: true, reason: 'mix_engine_down' }));
it('says so when recording is switched off', () =>
  expect(recordingHealth({ ...base, enabled: false, newestFileMtimeMs: null })).toEqual({ healthy: true, reason: 'disabled' }));
```

- [ ] **Step 2: Run to verify they fail**, **Step 3: implement**, **Step 4: run to verify they pass** (`pnpm --filter api test -- health`).
- [ ] **Step 5: Dashboard.** Poll `/recordings/status` every 30 s. When `healthy` is false, show a warning banner above the Now Playing card, exactly:

> **The broadcast is not being recorded.** No recording file has been written for over a minute. Check Reports → Recordings.

with a link to `/reports?tab=recordings`. Amber, same styling as the existing `restartToast` block. Nothing is shown for `disabled`, `off_air` or `mix_engine_down` — the existing cards already cover those.
- [ ] **Step 6:** `pnpm type-check && pnpm --filter api test`; stage and report.

---

### Task 6: The Reports page

**Files:**
- Modify: `apps/web/src/layouts/AppLayout.tsx` (nav entry **Reports**, path `/reports`, directly under Logs; icon `FileBarChart` from lucide-react)
- Modify: `apps/web/src/App.tsx` (route)
- Create: `apps/web/src/pages/reports/ReportsPage.tsx` (tabs), `RecordingsTab.tsx`, `RecordingSettingsPanel.tsx`
- Create: `apps/web/src/pages/settings/liquidsoap-sections/RecordingSection.tsx`; mount it in `LiquidSoapSettings.tsx`
- Modify: `apps/web/src/api.ts` (client functions for every Task 4 route)

**Interfaces:**
- Consumes: Task 4's routes and the shared types; `RECORDING_BITRATES`, `RECORDING_SAMPLE_RATES`, `RECORDING_SEGMENT_MINUTES`, `isValidRecordingQuality`; `<StationClock />`.

- [ ] **Step 1: Shell.** `ReportsPage` with three tabs — **Broadcast Log**, **Campaigns**, **Recordings** — the selected one in `?tab=` (default `recordings`). The first two render the existing `ComingSoon` component.
- [ ] **Step 2: Recordings tab**, following the spec's sketch:
  - Status line: `● Recording` (green) or `● Not recording` (amber, with the reason in words), disk used by recordings, how many days are kept (oldest recording to now), free disk. If the last sweep had `floor_unmet`, an amber line: *Disk space is below the floor and nothing more can be deleted: what remains is held or younger than the protected age.*
  - Date picker (station date, default today, not after today).
  - One row per item. File rows: station-time span `HH:MM–HH:MM`, size, a play button that opens an `<audio controls>` under the row (`src` = the file route — one player open at a time), download, delete; a held file shows a lock and its hold note instead of delete. The file being written shows `recording now…` and no delete. Gap rows: `— Off air —`, `Interruption (Ns)` in `text-zinc-400` at small size, or `No recording` in amber.
  - Download range: two time inputs on the chosen day and a button. Pressing it calls the preview first; if the range has gaps they are listed (`14:40–14:52 missing`) with **Download anyway** / **Cancel** inline; with no gaps it downloads at once. Errors (`too_long`, `nothing_recorded`, ffmpeg failure) are shown inline.
  - Delete is a two-step inline confirm on the row (**Delete** → **Confirm** / **Cancel**). **Delete this day** and **Delete everything older than…** (date input) sit in a "Purge" block with the same two-step confirm, and report `deleted / skipped (held) / skipped (recording)`.
  - Holds: "Keep a period" form (from, to as station date-times, note), validated with `RecordingHoldCreateSchema`, errors shown next to the button; a list of current holds with **Remove**.
- [ ] **Step 3: Retention settings panel** (`[ Settings ]` button on the tab): `retention_days`, `min_free_gb`, `protected_days`. React Hook Form + Zod with `RecordingSettingsSchema`, null-safe `setValueAs`, and an error summary beside Save (`collectErrorPaths` pattern from `LiquidSoapSettings.tsx`). A line under it: *Recording quality and file length are set in Settings → Mix Engine → Recording.* (link).
- [ ] **Step 4: Mix engine "Recording" section**: enabled toggle, bitrate, sample rate, mono/stereo, file length — selects built from the shared constants, the bitrate list filtered by `isValidRecordingQuality` for the chosen sample rate (changing the sample rate to one that excludes the current bitrate moves the bitrate to the nearest allowed value and says so). Hint, exactly:

> Recording runs inside the Mix Engine. Changes here take effect when the Mix Engine restarts — a few seconds off air. About {MB} MB per hour at this quality.

where MB = `bitrate_kbps × 0.45`, rounded.
- [ ] **Step 5: Verify in a headless browser** (cached Chromium, as in `plans/03`), API on a scratch DB copy with `RECORDINGS_DIR` set to the Task 4 scratch folder:
  - `/reports` opens on Recordings; the other two tabs show the placeholder; the sidebar shows Reports under Logs.
  - The day lists three files and their gaps in station time; play starts audio (`audio.currentTime` advances); single-file download returns 200.
  - A range with a gap shows the gap list before downloading; **Cancel** sends no download request.
  - Delete needs two clicks; the first click alone sends no `DELETE`.
  - Creating a hold over a file replaces its delete button with the lock; **Delete this day** then reports one skipped.
  - Saving retention with `protected_days` above `retention_days` shows the error beside Save and sends no request.
  - In Settings → Mix Engine, choosing 22.05 kHz removes 192 from the bitrate list.
  - Renaming the scratch folder away, the Dashboard shows the "not being recorded" banner only when the status reason is `not_recording`.
  - No console errors on any of these pages.
- [ ] **Step 6:** `pnpm type-check && pnpm build`; stage and report.

---

### Task 7: Deploy readiness

**Files:** `docs/deployment.md`, `CLAUDE.md` (short additions), `docs/reports-recordings-design.md` (status line only).

- [ ] **Step 1: Document.** In `docs/deployment.md`: the `./recordings` folder, how much disk the default quality uses (0.7 GB a day, about 42 GB for 60 days), and that it is not backed up anywhere else. In `CLAUDE.md`: the guarded-output rule (any new LiquidSoap output must be proven not to stop the stream on a write failure — point at this plan's gate section).
- [ ] **Step 2: Whole-repo check.** `pnpm --filter @soono/shared build && pnpm type-check && pnpm test && pnpm build` → all green.
- [ ] **Step 3: Image smoke tests.** Build the API image and boot it in isolation on an empty database (expect the two new migrations applied and `Server listening`); build the liquidsoap image and run `liquidsoap --check` on a script generated by that API image.
- [ ] **Step 4: Report for rollout**, plainly, for Daniel:
  - The compose file changes (a new volume on two services, `TZ=UTC` on the mix engine), so the deploy recreates the API **and** the mix engine; if the station is On Air that is a short interruption.
  - `mkdir recordings` on the server is not needed (Docker creates the bind mount), but the folder will be owned by root.
  - Recording starts with the first mix-engine start after the deploy; nothing earlier can be recovered.
  - Two migrations (`station_air_events`, `recording_holds`), both plain `CREATE TABLE`.
  - Deploying is his call.
