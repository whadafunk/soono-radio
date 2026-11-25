# Recordings — List, Bulk Download and Flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Recordings tab shows one filterable list over any period, where recordings are selected across days and then downloaded as one archive, flagged, or deleted.

**Architecture:** The folder on disk stays the only source of truth for which recordings exist. The list route returns a period grouped by station day; filtering runs in the browser through pure functions kept in `apps/shared`. The archive is a zip stored without compression and streamed while it is built. Flags live in one small table keyed by file name and replace the kept-period table.

**Tech Stack:** Fastify, Drizzle + libsql (`drizzle-kit generate`), Zod (`apps/shared`), `archiver` (new API dependency), React + React Query, vitest (`apps/api`).

**Spec:** `docs/reports-recordings-list-design.md` (builds on `docs/reports-recordings-design.md`, deployed)

## Global Constraints

- Nothing in this plan touches the mix engine, its script template, `docker-compose.yml`, or where recordings are stored.
- Files on disk keep their UTC names (`/recordings/<UTC date>/<UTC start>Z.mp3`). Everything the operator sees, types or downloads is **station time**. Follow "Time and timezone" in `CLAUDE.md`; station-time tests start with `process.env.TZ = 'Europe/Bucharest'`.
- Flag set, fixed in code, in this order: `protect`, `review`, `incident`, `sent_to_authority`, `marked_for_deletion`. Labels: Protect, Review, Incident, Sent to authority, Marked for deletion. Notes optional, max 200 characters.
- **Protect** is the only flag with an effect: the automatic clean-up, Delete (single and selection) and "delete everything before" all skip a protected recording and report the count.
- The recording in progress is never deleted and never put in an archive.
- A filtered view never hides no-recording time.
- Nothing from a request reaches the disk without passing `isSafeRecordingRef`.
- A period is at most **366** station days. A selection is at most **10,000** recordings.
- Archive: zip, stored without compression. Name `soono-recordings_<first day>_to_<last day>.zip`. Entries `<station day>/<YYYY-MM-DD_HH-MM-SS>.mp3`. Contains `listing.csv`.
- No browser pop-ups: every confirmation is inline. Contrast: `text-zinc-400` minimum for hints, `text-zinc-300` for content.
- Migrations only via `cd apps/api && pnpm drizzle-kit generate`.
- `apps/shared` resolves to `dist/`: run `pnpm --filter @soono/shared build` after changing it.
- No `any`, no `console.log`, no `// TODO`, no unused exports.
- Do not commit, push or deploy unless Daniel asks; each task ends "stage and report".
- The live station is never touched. API checks run on a scratch copy (`RADIO_DB_PATH`, `RECORDINGS_DIR`, `RECORDINGS_CONFIG` pointing into the scratchpad).

## Rulings made while planning

- **Kept periods are dropped, not converted.** The design says existing kept periods become Protect flags. The live station has none (checked 2026-11-25: `GET /recordings/holds` → `[]`), so the table is dropped and no conversion code is written. Task 6 re-checks before any deploy; if one exists by then, stop and ask.
- **Days are listed newest first**, hours oldest first inside a day.
- **Changing a filter drops hidden rows from the selection**, so the count in the action bar always matches what is on screen.
- **The row-level Delete stays.** The design removes only "Delete this day".
- **`listing.csv` starts with a UTF-8 byte-order mark** so spreadsheet programs read the notes correctly.
- Web type-check is red between Task 1 and Task 5 (the old page uses the removed kept-period types). Tasks 1–4 verify with shared build, API type-check and API tests.

## Review Focus

1. **An archive over 4 GB or over 65,535 entries** must open in an ordinary unzip tool. → Task 3.
2. **The browser goes away mid-download**: the API stops reading files and frees them; no error-level log, no leftover work. → Task 3.
3. **A selected recording disappears before it is archived** (clean-up ran, someone deleted it): it is skipped, the archive is still valid, `listing.csv` does not claim it is included. → Task 3.
4. **A selection entry that is not a recording** (`../../data/radio.db`, an absolute path, a day that does not match the name, 10,001 entries): 400, nothing read, flagged or deleted. → Tasks 3, 4.
5. **The two clock-change days**: the repeated autumn hour gives two different entry names; a 23- or 25-hour day sums to its real length; the hours filter does not shift by an hour. → Tasks 2, 3.

---

### Task 1: Flags replace kept periods

**Files:**
- Modify: `apps/shared/src/schemas/recordings.ts`, `apps/api/src/db/schema.ts`, `apps/api/src/services/recordings/sweepPlan.ts` (+ `.test.ts`), `apps/api/src/services/recordings/recordingSweep.ts`, `apps/api/src/routes/recordings.ts`
- Create: `apps/api/src/services/recordings/recordingFlags.ts`, one generated migration in `apps/api/drizzle/`

**Interfaces — Produces:**
- shared: `RECORDING_FLAGS` (const tuple above), `type RecordingFlag`, `RECORDING_FLAG_LABELS: Record<RecordingFlag, string>`, `interface RecordingFlagEntry { flag: RecordingFlag; note: string }`, `RecordingRefSchema` (`{ day, name }`, both strings), `RecordingSelectionSchema` (`{ files: RecordingRef[] }`, 1–10,000), `RecordingFlagChangeSchema` (`{ files, flag, set: boolean, note?: string ≤ 200 }`).
- shared: `RecordingDeleteResult` becomes `{ deleted, skipped_protected, skipped_active }`. Removed: `RecordingHoldCreateSchema`, `RecordingHoldCreate`, `RecordingHold`.
- `schema.ts`: `recordingFlags` = table `recording_flags` (`id`, `name` text, `flag` text enum, `note` text default `''`, `created_at_ms`), unique on (`name`, `flag`). `recordingHolds` removed.
- `sweepPlan.ts`: `planSweep` input `holds: HoldRange[]` → `protectedNames: ReadonlySet<string>`. `isHeld` and `HoldRange` removed.
- `recordingFlags.ts`: `loadFlags(): Promise<Map<string, RecordingFlagEntry[]>>` (entries in `RECORDING_FLAGS` order), `protectedNames(): Promise<Set<string>>`, `setFlag(names: string[], flag, note: string): Promise<number>` (upsert; replaces the note), `clearFlag(names: string[], flag): Promise<number>`, `removeFlagsFor(names: string[]): Promise<void>`. Names are chunked so no statement carries more than 500 values.

- [ ] **Step 1: Failing tests** in `sweepPlan.test.ts` — replace the hold cases with:
  - `keeps a protected recording past retention` — file 90 days old, name in `protectedNames`, retention 60 → no deletion.
  - `disk floor skips a protected recording and takes the next oldest` — two files 40 and 35 days old, the older protected, floor unmet → only the 35-day one is deleted.
  - `a protected recording does not stop the disk-floor pass` — oldest protected, floor met after deleting the second → `floorUnmet` false.
- [ ] **Step 2:** `pnpm --filter api test sweepPlan` → FAIL (unknown property `protectedNames`).
- [ ] **Step 3:** Change `planSweep` as above. `pnpm --filter api test sweepPlan` → PASS.
- [ ] **Step 4:** Shared schemas as above; `pnpm --filter @soono/shared build`.
- [ ] **Step 5:** `schema.ts` as above; `cd apps/api && pnpm drizzle-kit generate`. Expected: one new `.sql` with `CREATE TABLE recording_flags`, its unique index, and `DROP TABLE recording_holds`. Read the file; nothing else may be in it.
- [ ] **Step 6:** Write `recordingFlags.ts`. In `recordingSweep.ts` use `protectedNames()` and call `removeFlagsFor` for what the sweep deleted. In `routes/recordings.ts`: delete the three `/recordings/holds` routes and `loadHolds`; `deleteAllowed(files, protectedNames)` counts `skipped_protected` and calls `removeFlagsFor` for what it deleted; the day listing drops `held` and `holds` from its response and otherwise stays as it is (Task 2 replaces it).
- [ ] **Step 7:** `pnpm --filter api type-check && pnpm --filter api test` → green.
- [ ] **Step 8:** Stage and report.

---

### Task 2: A period, grouped by day, and its filters

**Files:**
- Create: `apps/api/src/services/recordings/periodList.ts` (+ `.test.ts`), `apps/shared/src/recordingFilters.ts`, `apps/api/src/services/recordings/recordingFilters.test.ts`
- Modify: `apps/shared/src/schemas/recordings.ts`, `apps/shared/src/index.ts`, `apps/api/src/routes/recordings.ts`

**Interfaces — Consumes:** `describeWindow`, `buildRecordingFiles`, `utcFoldersForWindow` (`recordingIndex.ts`); `offAirPeriods`; `loadFlags` (Task 1); `parseLocalYmd`, `addLocalDaysMs`, `daysInclusive` (`localDay.ts`).

**Interfaces — Produces:**
- shared types:
  - `RecordingListItem` = `{ kind: 'file'; day; name; start_ms; end_ms; size_bytes; recording_now: boolean; flags: RecordingFlagEntry[] }` | `{ kind: 'gap'; start_ms; end_ms; label: RecordingGapLabel }`
  - `RecordingPeriodDay` = `{ date: string; recorded_ms: number; no_recording_ms: number; size_bytes: number; items: RecordingListItem[] }`
  - `RecordingPeriodResponse` = `{ from: string; to: string; timezone: string; days: RecordingPeriodDay[] }`
  - Removed: `RecordingDayItem`, `RecordingDayResponse`.
- `periodList.ts`: `dayItems(files: RecordingFile[], offAir, dayStartMs, dayEndMs): RecordingItem[]` — `describeWindow` for the day, minus file items that started before `dayStartMs` (a recording belongs to the station day it starts in, so it is never listed twice). `summariseDay(items): { recordedMs; noRecordingMs; sizeBytes }`.
- `recordingFilters.ts` (shared, no imports beyond types):
  - `interface RecordingFilter { hourFrom: number | null; hourTo: number | null; weekdays: number[]; flag: 'any' | 'unflagged' | RecordingFlag; noRecordingOnly: boolean }` — hours 0–24, `weekdays` ISO 1–7, empty = every day.
  - `filterPeriodDays(days: RecordingPeriodDay[], filter: RecordingFilter): RecordingPeriodDay[]`
  - Rules: a day is dropped when its weekday is not chosen. With both hours set and `hourTo > hourFrom`, an item is kept when it overlaps `[hourFrom:00, hourTo:00)` of that day, built with the local `Date` constructor from the day's date (not "midnight + N hours"). The flag filter applies to recordings; while it is not `any`, off-air and interruption rows are hidden but **no-recording rows stay**. `noRecordingOnly` keeps only no-recording rows. A day left with no rows is dropped. `recorded_ms`, `no_recording_ms` and `size_bytes` are never changed by filtering.
- Route: `GET /recordings?from=YYYY-MM-DD&to=YYYY-MM-DD` replaces `?date=`. 400 when either is not a date, `to` is before `from`, or the period is over 366 days. Days that have not started are left out; today is cut at now. Days newest first.

- [ ] **Step 1: Failing tests** `periodList.test.ts` (`TZ` line first):
  - `a recording crossing midnight is listed only on the day it starts`.
  - `summarises a day` — two one-hour files of 100 and 200 bytes, a 10-minute no-recording gap, a 3-hour off-air gap → `{ recordedMs: 7_200_000, noRecordingMs: 600_000, sizeBytes: 300 }`.
  - `a 25-hour day sums to 25 hours` — 2026-10-25, fully recorded in one-hour files → `recordedMs === 25 * 3_600_000`.
- [ ] **Step 2: Failing tests** `recordingFilters.test.ts` (`TZ` line first; imports from `@soono/shared`):
  - `drops days whose weekday is not chosen` — 2026-11-23 (Mon) and 2026-11-28 (Sat), `weekdays: [1,2,3,4,5]` → only the 23rd.
  - `keeps items overlapping the hours` — hours 6–8: a 05:00–06:00 file is out, 06:00–07:00 in, a 07:30–09:00 gap in.
  - `hours on the autumn clock-change day are wall-clock hours` — 2026-10-25, hours 4–5 → exactly the file that starts at 04:00 station time.
  - `a flag filter keeps no-recording rows and hides off-air rows`.
  - `unflagged keeps only recordings without flags`.
  - `noRecordingOnly keeps only no-recording rows and drops days without any`.
  - `filtering never changes a day's totals`.
- [ ] **Step 3:** `pnpm --filter @soono/shared build && pnpm --filter api test periodList recordingFilters` → FAIL (modules missing).
- [ ] **Step 4:** Implement both modules, export from `apps/shared/src/index.ts`, rebuild shared → tests PASS.
- [ ] **Step 5:** Rewrite the list route as above. One listing of the folders for the whole period, one `offAirPeriods` call, one `loadFlags` call; then per day `dayItems` + `summariseDay`.
- [ ] **Step 6: Check on a scratch copy.** Boot the API on a copy of the dev database with a scratch `RECORDINGS_DIR` holding a few small fake recordings on two UTC dates. `GET /recordings?from=<yesterday>&to=<today>` → 200, two days newest first, totals match the fixture. `?from=2026-01-01&to=2027-06-01` → 400. `?from=x` → 400. Empty or missing folder → 200 with days that contain only gaps.
- [ ] **Step 7:** `pnpm --filter api type-check && pnpm --filter api test` → green. Stage and report.

---

### Task 3: Station-time names and the archive

**Files:**
- Create: `apps/api/src/services/recordings/archiveNames.ts` (+ `.test.ts`), `apps/api/src/services/recordings/archiveListing.ts` (+ `.test.ts`), `apps/api/src/services/recordings/archiveStream.ts`
- Modify: `apps/api/package.json` (`archiver`, `@types/archiver`), `apps/shared/src/schemas/recordings.ts`, `apps/api/src/routes/recordings.ts`

**Interfaces — Consumes:** `RecordingSelectionSchema`, `loadFlags` (Task 1); `describeWindow`, `RecordingFile`.

**Interfaces — Produces:**
- `archiveNames.ts`:
  - `stationFileName(startMs: number): string` → `2026-11-25_10-00-00.mp3`
  - `archiveEntryPaths(files: Array<{ name: string; startMs: number }>): Map<string, string>` — file name → `2026-11-25/2026-11-25_10-00-00.mp3`; when two files map to the same path, **both** get their UTC offset before the extension (`…_03-00-00+0300.mp3`, `…_03-00-00+0200.mp3`).
  - `archiveFileName(firstStartMs: number, lastStartMs: number): string` → `soono-recordings_2026-11-25_to_2026-12-01.zip`
- `archiveListing.ts`: `buildListingCsv(input: { files: RecordingFile[]; included: ReadonlySet<string>; offAir: Array<{ fromMs: number; toMs: number | null }>; flags: Map<string, RecordingFlagEntry[]>; entryPaths: Map<string, string> }): string` — spans from the start of the first included file to the end of the last. Header `start,end,length,type,file,included,flags,notes`. One row per recording in the span (`type` `recorded`, `included` `yes`/`no`, `file` = entry path when included, else the station-time name) and one per gap (`type` `off air` / `interruption` / `no recording`). Times `YYYY-MM-DD HH:MM:SS` station time; length `H:MM:SS`; flags as labels joined with `; `; notes joined with `; `. Fields with a comma, quote or line break are quoted, quotes doubled. Begins with a UTF-8 byte-order mark.
- `archiveStream.ts`: `streamArchive(input: { entries: Array<{ path: string; entryPath: string }>; listingCsv: string }, out: NodeJS.WritableStream): { done: Promise<void>; abort: () => void }` — `archiver('zip', { store: true })`, `listing.csv` appended first. Read the current `archiver` documentation (Context7) for the exact options and events before writing it.
- shared: `RecordingArchivePreview` = `{ files: number; size_bytes: number; skipped_active: number; skipped_missing: number }`.
- Routes:
  - `POST /recordings/archive/preview` — JSON `RecordingSelectionSchema` → `RecordingArchivePreview`. 404 with a plain message when nothing would be included.
  - `POST /recordings/archive` — an HTML form post with one field `selection` holding the same JSON. Register an `application/x-www-form-urlencoded` parser scoped to this plugin (`URLSearchParams`; no new dependency). Responds `application/zip` with `Content-Disposition: attachment; filename="<archiveFileName>"`.
  - Both resolve the selection the same way: every entry must pass `isSafeRecordingRef` (else 400 for the whole request); files are then looked up through `listRawFiles` + `buildRecordingFiles`; missing ones and the one in progress are left out and counted.
  - `GET /recordings/file/:day/:name?download=1` now names the file with `stationFileName`.

- [ ] **Step 1: Failing tests** `archiveNames.test.ts` (`TZ` line first):
  - `names a recording in station time` — `2026-11-25T08-00-00Z` → `2026-11-25_10-00-00.mp3`.
  - `puts a recording in its station day's folder` — `2026-11-24T22-00-00Z` → `2026-11-25/2026-11-25_00-00-00.mp3`.
  - `the repeated autumn hour gets two different names` — `2026-10-25T00-00-00Z` and `2026-10-25T01-00-00Z` → `2026-10-25/2026-10-25_03-00-00+0300.mp3` and `…+0200.mp3`.
  - `names the archive after its first and last station day`.
- [ ] **Step 2: Failing tests** `archiveListing.test.ts` (`TZ` line first):
  - `lists included, not-included and gaps in time order` — three hourly files, the middle one not selected, then a 10-minute no-recording gap before a fourth → rows `recorded yes`, `recorded no`, `recorded yes`, `no recording`, `recorded yes`.
  - `the span starts and ends at the selection` — files before the first selected and after the last do not appear.
  - `quotes a note with a comma and a quote` — note `said "live", twice` → `"said ""live"", twice"`.
  - `starts with the byte-order mark and the header`.
- [ ] **Step 3:** `pnpm --filter api test archiveNames archiveListing` → FAIL (modules missing). Implement both → PASS.
- [ ] **Step 4:** `pnpm --filter api add archiver && pnpm --filter api add -D @types/archiver`. Write `archiveStream.ts` and the two routes. When the response closes before the archive is finished, call `abort()` and log at info level (`RECORDING_ARCHIVE_ABORTED`); a finished archive logs `RECORDING_ARCHIVE` with file count and bytes.
- [ ] **Step 5: Check on the scratch copy** (fixture: six small fake recordings over two station days, one touched within the last minute):
  - Preview of all six → `files: 5`, `skipped_active: 1`, size = sum of the five.
  - `curl` the form post to a file → `unzip -l` shows `listing.csv` plus five entries under two day folders with station-time names; `unzip -t` → no errors; `listing.csv` opens with the header and marks the live one `no`.
  - Selection naming one deleted file → it is left out, `skipped_missing: 1`, archive valid.
  - Selection with `{"day":"..","name":"../../data/radio.db"}` → 400. 10,001 entries → 400. Empty selection → 400.
  - Single-file download → `Content-Disposition` carries the station-time name.
- [ ] **Step 6: Large-archive check.** In the scratch folder create three sparse 2,500 MB files named as recordings (`truncate -s 2500M`), archive them to the scratchpad, then `unzip -l` and `unzip -t` → three entries of 2,500 MB each, no errors. Delete the archive and the fixtures afterwards.
- [ ] **Step 7: Abort check.** Start the same large download with `curl --max-time 2`; within a few seconds the API log shows `RECORDING_ARCHIVE_ABORTED`, no error-level line, and `lsof -p <api pid> | grep recordings` is empty.
- [ ] **Step 8:** `pnpm --filter api type-check && pnpm --filter api test` → green. Stage and report.

---

### Task 4: Flag and delete a selection

**Files:** Modify `apps/api/src/routes/recordings.ts`, `apps/shared/src/schemas/recordings.ts`.

**Interfaces — Consumes:** `RecordingFlagChangeSchema`, `RecordingSelectionSchema`, `setFlag`, `clearFlag`, `removeFlagsFor`, `protectedNames` (Task 1).

**Interfaces — Produces:**
- `POST /recordings/flags` — `RecordingFlagChangeSchema` → `{ changed: number }`. Only recordings that exist on disk are flagged; setting an already-set flag replaces its note.
- `POST /recordings/delete` — `RecordingSelectionSchema` → `RecordingDeleteResult`.
- Removed: `DELETE /recordings/day/:date`. Kept: `DELETE /recordings/file/:day/:name`, `POST /recordings/purge`.
- Every delete path (single, selection, purge, sweep) skips protected recordings and removes the flags of what it deleted.

- [ ] **Step 1:** Write the two routes and remove the day route. Selection entries that fail `isSafeRecordingRef` → 400 for the whole request, nothing changed.
- [ ] **Step 2: Check on the scratch copy:**
  - Flag two files `protect` with a note → `changed: 2`; the list shows both flags with the note.
  - Add `review` to one → it carries both, in the fixed order.
  - `POST /recordings/delete` with those two plus one unflagged and the live one → `{ deleted: 1, skipped_protected: 2, skipped_active: 1 }`; the protected files are still on disk.
  - `POST /recordings/purge` far in the future → protected files survive, counted.
  - Clear `protect` on one, delete it → deleted, and `recording_flags` holds no row for that name.
  - Flag a name that does not exist → `changed: 0`. Unknown flag → 400. Note of 201 characters → 400.
  - `DELETE /recordings/day/2026-11-25` → 404.
- [ ] **Step 3:** `pnpm --filter api type-check && pnpm --filter api test` → green. Stage and report.

---

### Task 5: The page

**Files:**
- Modify: `apps/web/src/pages/reports/RecordingsTab.tsx` (becomes the shell: status, settings, messages, data, selection state), `apps/web/src/api.ts`
- Create in `apps/web/src/pages/reports/`: `RecordingFilterBar.tsx`, `RecordingDayGroup.tsx`, `RecordingSelectionBar.tsx`, `RecordingCutPanel.tsx`, `recordingFormat.ts` (the `formatTime` / `formatBytes` / duration helpers shared by them)

**Interfaces — Consumes:** `filterPeriodDays`, `RecordingFilter`, `RECORDING_FLAGS`, `RECORDING_FLAG_LABELS`, the Task 2–4 routes.

**`api.ts`:** `fetchRecordingPeriod(from, to)`, `previewRecordingArchive(files)`, `recordingArchiveUrl` (the form's action), `setRecordingFlag(change)`, `deleteRecordingSelection(files)`. Remove `fetchRecordingDay`, `deleteRecordingDay`, `createRecordingHold`, `removeRecordingHold`.

**Behaviour:**
- **Filter bar:** period from–to (opens on the last 7 days, `localYmd` / `addDaysYmd`; "to" cannot be after today; over 366 days shows the API's message), hours from–to (two selects 00–24; empty = all day), weekday toggles Mon–Sun, flag select (Any / Unflagged / the five), checkbox "No recording only".
- **Day group:** header with a three-state checkbox, the date with weekday, `recorded · no recording` (the no-recording part in `text-amber-300` when above zero), size, and an expand toggle. Today starts expanded, other days collapsed; with "No recording only" on, every day is expanded. The checkbox selects that day's recordings that pass the filters, never the one in progress.
- **Rows:** checkbox, time, size, Play, Download, flag chips (label and note; Protect with the lock icon), row Delete (hidden for protected and in-progress rows). Gap rows as today, without a checkbox.
- **Selection bar** (sticks to the bottom of the list, shown when something is selected): `N selected · size`, Download, Flag, Delete, Clear.
  - Download → `previewRecordingArchive`; show "N recordings, size" and what was left out (in progress, no longer there); then submit a hidden form to `recordingArchiveUrl`. A failed preview shows the API's message in the page.
  - Flag → inline panel: flag select, Set / Clear, optional note; applies to the selection.
  - Delete → inline confirmation stating count and size; the result line reports deleted / skipped (protected) / skipped (recording now).
- **Cut exact time…** opens `RecordingCutPanel`: two `datetime-local` inputs, the existing gap preview and "Download anyway". The API's 24-hour limit message is shown as is.
- **Purge section:** only "Everything older than" remains; its hint says protected recordings and the one in progress are skipped.
- Removed from the page: the "Keep a period" section, the single date input, "Delete this day".
- The list refetches every 30 s while the period includes today.

- [ ] **Step 1:** Build the above. Selection is a `Set` of `day/name`; after every filter or data change, drop entries no longer visible.
- [ ] **Step 2:** `pnpm type-check && pnpm --filter web build` → green.
- [ ] **Step 3: Headless check** (cached Playwright Chromium, API on the scratch copy with fixtures over 9 days including a no-recording gap and one in-progress file). Screenshot and assert:
  - Opens on 7 days, today expanded, a day with missing time shows it in amber while collapsed.
  - Weekday, hours, flag and "No recording only" each change the list as Task 2's rules say; the totals on day headers do not change.
  - Day checkbox selects that day; the bar shows the right count and size; changing a filter that hides rows lowers the count.
  - Download shows the preview line, then the browser receives a zip (assert the download event and file name).
  - Flag → Protect with a note shows the chip; Delete on a selection containing it reports one skipped.
  - Cut exact time across midnight (23:50 → 00:10) downloads an MP3.
  - No console errors; text contrast as in Global Constraints.
- [ ] **Step 4:** Stage and report.

---

### Task 6: Deploy readiness

**Files:** `docs/deployment.md`, `docs/reports-recordings-design.md` (one line pointing at the new design), `docs/reports-recordings-list-design.md` (the kept-period ruling).

- [ ] **Step 1: Document.** Replace any mention of kept periods with flags; note the archive download and that `listing.csv` is part of it.
- [ ] **Step 2: Whole-repo check.** `pnpm --filter @soono/shared build && pnpm type-check && pnpm test && pnpm build` → all green.
- [ ] **Step 3: Committed-tree check.** `git status --short` shows every new file as tracked or staged; then build from a clean export of the staged tree (`git checkout-index -a --prefix=<scratchpad>/tree/`, then `pnpm install --frozen-lockfile && pnpm build` there) → green. This is what catches a file an ignore rule hid.
- [ ] **Step 4: Image smoke test.** Build the API image and boot it in isolation on a copy of the dev database → the new migration applies, `Server listening`, `GET /recordings?from=…&to=…` → 200.
- [ ] **Step 5: Report for rollout**, plainly, for Daniel:
  - One migration: creates `recording_flags`, drops `recording_holds`. Before deploying, `GET /recordings/holds` on live must still return `[]`; if not, stop.
  - Only the API and web containers are recreated. The mix engine and the stream are not touched.
  - One new API dependency (`archiver`), so the image build installs packages.
  - Deploying is his call.
