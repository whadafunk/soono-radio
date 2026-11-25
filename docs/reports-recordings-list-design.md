# Reports → Recordings: list, bulk download and flags

**Status: design approved 2026-11-25; built per `plans/05-recordings-list.md`.**

Second round on the Recordings tab. Builds on `docs/reports-recordings-design.md`
(recording, retention, off-air history, health warning — all unchanged).

## Intent

Getting a week of recordings out of the app today means opening each day and
downloading file by file. The operator needs to pick recordings across many
days and take them in one go, and to mark recordings so they can be found and
kept.

## Goals

- One list over any period, with filters, where recordings are selected with
  checkboxes (per recording and per day).
- Download the selection as one archive of the original recordings, named so
  they can be identified outside the app.
- Flags on recordings, replacing "Keep a period". Flags are filter conditions.
- Missing time stays visible in every view.

## Non-goals

- Detecting silent audio inside a recording.
- Storing recordings on a network share (Gitea issue #6). Recordings stay on
  the local disk; compose is not touched.
- Splitting recordings on show or clock-template boundaries.
- User-defined flags. The set is fixed in code.
- Any automatic behaviour for "Marked for deletion". It is a label.

## Anti-goals

- A filtered view that hides missing recording time.
- A download or delete that can touch the file being recorded.
- Anything that changes the mix engine or its script.

## Approaches considered

1. **Extend the list API to a date range; filter in the browser; stream a zip
   built on the fly; flags in a small table keyed by file name.** — chosen.
   No temporary disk space, no background jobs, the folder stays the only
   source of truth for which recordings exist.
2. **Index recordings in a database table and filter with SQL.** Faster for
   very long periods, but adds a second source of truth that can disagree with
   the folder. Not needed at this size (60 days is about 1,500 files).
3. **Prepare the archive as a background job, then offer it for download.**
   Allows resuming a broken download, but needs temporary space as large as
   the archive (a month is about 21 GB) and a job queue. Too much for the gain.

## Design

### The list

```
[25 Nov – 01 Dec] [Hours 06–22] [Mon–Fri] [Flag: any ▾] [☐ No recording only]
☑ Tue 25 Nov   23 h 53 m recorded · 7 m no recording          690 MB   ▸
   ☑ 10:00–11:00   28.8 MB   ▶  ⚑ Protect · Review "check the 10:20 spot"
   ☐ 11:00–12:00   28.8 MB   ▶
   —  12:00–12:07  No recording
☐ Wed 26 Nov   24 h recorded                                   691 MB   ▸
[ 31 selected · 893 MB ]  [Download]  [Flag ▾]  [Delete]      [Cut exact time…]
```

- **Period:** a from–to date pair in station time. Opens on the last 7 days.
- **Days** are station-time days, collapsed to a summary line (recorded time,
  missing time, size); today is expanded. The day checkbox selects every
  recording of that day that passes the filters.
- **Gaps** (off air, interruption, no recording) are rows without a checkbox,
  as today. A day with no-recording time shows it on its summary line in the
  warning colour, so it is visible while collapsed.
- **Filters:** hours from–to (a recording is shown if it overlaps the hours),
  weekdays, flag (any / one flag / unflagged), and "No recording only", which
  shows only the no-recording rows and the days that contain them.
- Play in the page and single-file download stay on each row.

### Download

- The selection downloads as one zip, stored without compression, built while
  it downloads.
- Archive name: `soono-recordings_<first day>_to_<last day>.zip`.
- Inside: one folder per station day, files named in station time,
  `2026-11-25/2026-11-25_10-00-00.mp3`. On the one hour a year that repeats
  (autumn clock change) both files get the offset appended
  (`…_03-00-00+0300.mp3`, `…_03-00-00+0200.mp3`).
- Single-file downloads use the same name. Files on disk keep their UTC names.
- The archive carries `listing.csv`: from the start of the first selected
  recording to the end of the last, one row per recording (start, end, length,
  file name, included yes/no, flags, notes) and one row per gap (off air,
  interruption, no recording).
- The bar shows the selection's total size before download. A broken download
  starts again from zero.
- The recording in progress is left out; the page says so.

### Flags

- Fixed set: **Protect**, **Review**, **Incident**, **Sent to authority**,
  **Marked for deletion**. A recording can carry several; each has an
  optional note.
- **Protect** is the only one with an effect: automatic clean-up, Delete and
  "delete everything before" all skip a protected recording and report how
  many they skipped. To delete one, remove the flag first.
- "Flag ▾" sets or clears a flag on the whole selection.
- Flags live in a new table keyed by recording file name. Deleting a recording
  removes its flags.

### Delete

- "Delete" removes the selection after a confirmation that states count and
  size. Protected recordings and the one in progress are skipped and reported.

### Cut exact time

- The existing merged cut ("14:20 to 14:35 as one file") stays, behind
  "Cut exact time…". It takes a date and time at both ends, so it can cross
  midnight. Same maximum length as today.

## Controls removed or replaced

- **"Keep a period" panel** → Protect flag. Lost: protecting time that has not
  been recorded yet. The live station has no kept periods (checked
  2026-11-25), so the old table is dropped without a conversion; the deploy
  re-checks this first.
- **Single-day date picker** → period from–to.
- **"Delete this day" button** → day checkbox + Delete.
- **Unchanged:** retention settings, "delete everything before a date",
  recording quality settings, status line, Dashboard warning.

## My calls (correct any of them)

- Opens on the last 7 days; period capped at 366 days per view.
- Filters run in the browser on the loaded period.
- New API dependency `archiver` for the zip (streams, handles archives over
  4 GB).
- `listing.csv` rather than plain text, so it opens in a spreadsheet.
- Notes are optional on every flag (today's "Keep a period" requires one).
- Two deferred minors from the first round are closed by this work: the range
  that could not cross midnight, and the unclear "Delete this day".

## Left to the builder

- Shape of the range list response and the selection requests.
- How the zip request carries a long selection (form post or similar).
- Wording of confirmations and skipped-item messages.
