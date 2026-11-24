# Station Timezone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every clock time and calendar day in the backend is read in a configurable station timezone (default `Europe/Bucharest`) instead of the API container's UTC.

**Architecture:** One new column on `station_settings`. The API applies it to its own process (`process.env.TZ`) at startup, before the supervisor starts, and again on save, then requests a reconcile. The ~57 existing local-time call sites follow with no rewrite; the handful of places that assume a day is always 24 hours, or mix local and UTC dates, are corrected and pinned by tests.

**Tech Stack:** Node 20, Fastify, Drizzle + libsql (migration via `drizzle-kit generate`), Zod (`apps/shared`), React + React Query, vitest (`apps/api` only).

**Spec:** `docs/station-timezone-design.md`

## Global Constraints

- Default timezone is exactly `Europe/Bucharest`.
- The setting is a zone **name**, never a numeric offset.
- No `TZ` for the API in `docker-compose.yml`, `.env` or a Dockerfile.
- Nothing about storage changes: clock times stay plain `HH:MM`, moments stay absolute timestamps. No existing schedule rows are shifted.
- Web pages keep displaying times in the browser's timezone. Do not convert them.
- Migrations are created with `cd apps/api && pnpm drizzle-kit generate` — never by hand (`CLAUDE.md`).
- No `any`, no `console.log`, no `// TODO`; contrast rules in `CLAUDE.md` apply to any new text (`text-zinc-400` minimum for hints).
- `apps/shared` resolves to its `dist/` — run `pnpm --filter @soono/shared build` after changing it and before running API tests or type-check.
- Tests that depend on the zone set `process.env.TZ = 'Europe/Bucharest'` at the top of the test file, before any `Date` is created.
- Do not commit, push or deploy unless Daniel asks; each task's commit step is "stage and report", per the project's rule that he triggers commits.

## Review Focus

1. **The API is started with a `TZ` already in its environment** (someone adds it to `.env` later): the stored setting must still win, and startup logs which zone is in force. → Task 3.
2. **The `station_settings` row does not exist yet on first boot**: startup must apply the default, not crash or stay on UTC. → Task 3.
3. **A PATCH with an invalid or offset-style zone** (`"Bucharest"`, `"+02:00"`, `""`): rejected with 400 and the running zone unchanged. → Task 3.
4. **A slot inside the hour that does not exist** (03:00–04:00 on the last Sunday of March): yields an empty window, not a negative one or a crash. → Task 1.
5. **A campaign spanning the October clock change**: day counts must not gain a day because that day is 25 hours long. → Task 1.

---

### Task 1: Local-day arithmetic that survives clock changes

Today the resolver builds a slot's time as "local midnight + N minutes" and steps days by adding 24 hours. Both are wrong on the two clock-change days once the process runs in a zone that has them: every slot after the change is an hour off. This task moves the resolver's private date helpers into one tested module and fixes them.

**Files:**
- Create: `apps/api/src/services/supervisor2/localDay.ts`
- Create: `apps/api/src/services/supervisor2/localDay.test.ts`
- Modify: `apps/api/src/services/supervisor2/clockResolver.ts` (helpers at ~86–117 removed and imported; day stepping at ~257 and ~271; template-clock hours at ~246–248)
- Modify: `apps/api/src/services/spotBudget.ts` (`daysBetween`, ~89–93)
- Modify: `apps/api/src/services/supervisor2/processes/campaign.ts` (private helpers `daysInclusive` and `startOfIsoWeekMs`, ~762–836)

**Interfaces:**
- Produces, all exported from `localDay.ts`, all reading the process's local zone, no imports beyond the standard library:
  - `isoDayOfWeek(d: Date): number` — 1 = Mon … 7 = Sun
  - `isoDateString(d: Date): string` — local `YYYY-MM-DD`
  - `timeToMinutes(hm: string): number`
  - `localMidnightMs(atMs: number): number`
  - `localTimeOnDayMs(dayMidnightMs: number, minutes: number): number` — the wall-clock time `minutes` after midnight on that local day; `1440` is the next local midnight
  - `addLocalDaysMs(dayMidnightMs: number, days: number): number` — local midnight `days` calendar days away (negative allowed)
  - `windowOnDay(dayMidnightMs: number, timeStart: string, timeEnd: string): { startMs: number; endMs: number }` — an end at or before the start still means "to end of day"
  - `calendarDaysBetween(start: Date, end: Date): number` — whole local calendar days from start to end, never negative
  - `daysInclusive(fromYmd: string, toYmd: string): number` — inclusive count between two `YYYY-MM-DD` dates (same day = 1)
  - `startOfIsoWeekMs(nowMs: number): number` — local midnight of the Monday of that week

- [ ] **Step 1: Write the failing tests** in `localDay.test.ts`, first line `process.env.TZ = 'Europe/Bucharest';`

```ts
const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

describe('ordinary day (EET, UTC+2)', () => {
  it('finds local midnight', () => {
    expect(localMidnightMs(utc(2026, 11, 25, 10))).toBe(utc(2026, 11, 24, 22));
  });
  it('reads the local date and weekday either side of midnight', () => {
    expect(isoDateString(new Date(utc(2026, 11, 24, 21, 30)))).toBe('2026-11-24');
    expect(isoDayOfWeek(new Date(utc(2026, 11, 24, 21, 30)))).toBe(2);
    expect(isoDateString(new Date(utc(2026, 11, 24, 22, 30)))).toBe('2026-11-25');
    expect(isoDayOfWeek(new Date(utc(2026, 11, 24, 22, 30)))).toBe(3);
  });
  it('places a slot at wall-clock time', () => {
    expect(windowOnDay(utc(2026, 11, 24, 22), '08:00', '09:00'))
      .toEqual({ startMs: utc(2026, 11, 25, 6), endMs: utc(2026, 11, 25, 7) });
  });
  it('treats an end at or before the start as end of day', () => {
    expect(windowOnDay(utc(2026, 11, 24, 22), '22:00', '00:00'))
      .toEqual({ startMs: utc(2026, 11, 25, 20), endMs: utc(2026, 11, 25, 22) });
  });
});

describe('clocks go forward — Sunday 2027-03-28, 03:00 becomes 04:00', () => {
  const midnight = utc(2027, 3, 27, 22);
  it('keeps slots after the change at wall-clock time', () => {
    expect(windowOnDay(midnight, '08:00', '09:00'))
      .toEqual({ startMs: utc(2027, 3, 28, 5), endMs: utc(2027, 3, 28, 6) });
  });
  it('gives a 23-hour day', () => {
    expect(addLocalDaysMs(midnight, 1)).toBe(utc(2027, 3, 28, 21));
    expect(addLocalDaysMs(midnight, -1)).toBe(utc(2027, 3, 26, 22));
    expect(windowOnDay(midnight, '22:00', '00:00').endMs).toBe(utc(2027, 3, 28, 21));
  });
  it('makes a slot inside the skipped hour empty, not negative', () => {
    const w = windowOnDay(midnight, '03:00', '04:00');
    expect(w.startMs).toBe(utc(2027, 3, 28, 1));
    expect(w.endMs).toBe(utc(2027, 3, 28, 1));
  });
});

describe('clocks go back — Sunday 2027-10-31, 04:00 becomes 03:00', () => {
  const midnight = utc(2027, 10, 30, 21);
  it('keeps slots after the change at wall-clock time', () => {
    expect(windowOnDay(midnight, '08:00', '09:00').startMs).toBe(utc(2027, 10, 31, 6));
    expect(localTimeOnDayMs(midnight, 5 * 60)).toBe(utc(2027, 10, 31, 3));
  });
  it('gives a 25-hour day', () => {
    expect(addLocalDaysMs(midnight, 1)).toBe(utc(2027, 10, 31, 22));
  });
  it('stretches the repeated hour', () => {
    expect(localTimeOnDayMs(midnight, 4 * 60) - localTimeOnDayMs(midnight, 3 * 60)).toBe(2 * 3_600_000);
  });
});

describe('campaign day and week boundaries', () => {
  it('starts the week at local Monday midnight', () => {
    // Wed 25 Nov 2026, 00:30 local
    expect(startOfIsoWeekMs(utc(2026, 11, 24, 22, 30))).toBe(utc(2026, 11, 22, 22));
    // Sunday of the March change still belongs to the week that began Mon 22 Mar
    expect(startOfIsoWeekMs(utc(2027, 3, 28, 12))).toBe(utc(2027, 3, 21, 22));
    // Monday after the October change starts its own week at EET midnight
    expect(startOfIsoWeekMs(utc(2027, 11, 1, 12))).toBe(utc(2027, 10, 31, 22));
  });
  it('counts campaign days inclusively across both clock changes', () => {
    expect(daysInclusive('2026-11-25', '2026-11-25')).toBe(1);
    expect(daysInclusive('2027-03-22', '2027-03-28')).toBe(7);
    expect(daysInclusive('2027-10-25', '2027-11-01')).toBe(8);
  });
});

describe('calendarDaysBetween', () => {
  it('counts calendar days, not 24-hour blocks', () => {
    expect(calendarDaysBetween(new Date(2027, 9, 31), new Date(2027, 10, 1))).toBe(1);  // 25h day
    expect(calendarDaysBetween(new Date(2027, 2, 28), new Date(2027, 2, 29))).toBe(1);  // 23h day
    expect(calendarDaysBetween(new Date(2026, 10, 25), new Date(2026, 11, 2))).toBe(7);
  });
  it('is zero for the same day and never negative', () => {
    expect(calendarDaysBetween(new Date(2026, 10, 25), new Date(2026, 10, 25))).toBe(0);
    expect(calendarDaysBetween(new Date(2026, 10, 26), new Date(2026, 10, 25))).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter api test -- localDay`
Expected: FAIL — `localDay.js` cannot be resolved.

- [ ] **Step 3: Implement `localDay.ts`**

Build every time from the local `Date` constructor (`new Date(year, month, day, 0, minutes)`), never from "midnight + milliseconds" — that is the whole fix. `calendarDaysBetween` compares the two dates' local year/month/day (via `Date.UTC` of those parts), so day length cannot matter.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter api test -- localDay`
Expected: PASS, all tests.

- [ ] **Step 5: Use the module in `clockResolver.ts`**

Delete the five private helpers and import them. Replace `localMidnightMs(tMs) - dayOffset * 86_400_000` and `+ dayOffset * 86_400_000` with `addLocalDaysMs(localMidnightMs(tMs), ∓dayOffset)`. In `scheduleWindowsOnDay`, template-clock rows become `{ startMs: localTimeOnDayMs(dayMidnightMs, row.hour * 60), endMs: localTimeOnDayMs(dayMidnightMs, (row.hour + 1) * 60) }`. Then check the rest of the file for any other `dayMidnightMs + <something>` and convert it the same way.

- [ ] **Step 6: Use `calendarDaysBetween` in `spotBudget.ts`**

`daysBetween` becomes a call to it (or is replaced by it at its call sites). Leave `addDays`, `dateToString` and `isoDay` alone — they already use local date parts.

- [ ] **Step 6b: Use `daysInclusive` and `startOfIsoWeekMs` in `campaign.ts`**

Delete its two private copies and import the tested ones. The file's other private helpers (`midnightMs`, `ymdFromMs`, `hhmmFromMs`, `isoDayOfWeek`, `dateStringToMs`, `minutesOfDay`) already build from local date parts — leave them.

- [ ] **Step 7: Verify nothing else assumes a 24-hour day in day-boundary code**

Run: `grep -rnE "86_?400_?000" apps/api/src --include='*.ts' | grep -v test`
Expected: remaining hits are only durations that are genuinely "N × 24 hours" (retention windows, `Math.round` day counts in `campaign.ts:765` and `routes/customers.ts:392`, which are already safe). Read each hit and say so in the report; convert any that steps from one local midnight to another.

- [ ] **Step 8: Full check, then stage**

Run: `pnpm --filter api test && pnpm --filter api exec tsc --noEmit`
Expected: all tests pass, no type errors. Stage the changed files and report.

---

### Task 2: Dates that mix local and UTC

Three places produce a `YYYY-MM-DD` string through `toISOString()`, which is the UTC date. They agree with the local date today only because the container is UTC.

**Files:**
- Modify: `apps/shared/src/schemas/scheduling.ts` (campaign `starts_on` refine, ~408) and `apps/shared/src/index.ts` if helpers need exporting
- Create: `apps/shared/src/localDate.ts`
- Modify: `apps/api/src/routes/schedule.ts` (week window, ~313–315)
- Create: `apps/api/src/services/localDate.test.ts`

**Interfaces:**
- Produces, exported from `@soono/shared`:
  - `localYmd(d?: Date): string` — the local calendar date of `d` (default now) as `YYYY-MM-DD`, from `getFullYear/getMonth/getDate`
  - `addDaysYmd(ymd: string, days: number): string` — pure string-date arithmetic, independent of any timezone

- [ ] **Step 1: Write the failing test** in `apps/api/src/services/localDate.test.ts`, first line `process.env.TZ = 'Europe/Bucharest';`, importing from `@soono/shared`

```ts
it('localYmd is the local date, not the UTC date, just after local midnight', () => {
  // 00:30 on 26 Nov in Bucharest is still 25 Nov in UTC
  expect(localYmd(new Date(Date.UTC(2026, 10, 25, 22, 30)))).toBe('2026-11-26');
});
it('addDaysYmd steps calendar days across month, year and clock-change boundaries', () => {
  expect(addDaysYmd('2026-11-25', 7)).toBe('2026-12-02');
  expect(addDaysYmd('2026-12-29', 7)).toBe('2027-01-05');
  expect(addDaysYmd('2027-03-27', 2)).toBe('2027-03-29');
  expect(addDaysYmd('2027-10-30', 2)).toBe('2027-11-01');
  expect(addDaysYmd('2026-11-25', -25)).toBe('2026-10-31');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @soono/shared build && pnpm --filter api test -- localDate`
Expected: FAIL — `localYmd` is not exported.

- [ ] **Step 3: Implement `apps/shared/src/localDate.ts`** and export both functions from the package index. `addDaysYmd` does its arithmetic in UTC on the parsed parts so the result never depends on the running zone.

- [ ] **Step 4: Use them**

In `scheduling.ts`, the `starts_on` refine compares against `localYmd()`. In `routes/schedule.ts`, the week window's end becomes `addDaysYmd(week_start, 7)` (drop the `new Date(week_start)` / `setDate` / `toISOString` lines). Leave the date enumeration at ~711–716 as it is: it is already consistently UTC-noon based.

- [ ] **Step 5: Verify, and sweep for others**

Run: `pnpm --filter @soono/shared build && pnpm --filter api test -- localDate && pnpm type-check`
Expected: PASS, no type errors.
Run: `grep -rnE "toISOString\(\)\.(slice|split|substring)" apps/api/src apps/shared/src --include='*.ts' | grep -v test`
Expected: only `routes/schedule.ts` ~714 (the UTC-noon enumeration). Any other hit that produces a calendar date gets the same treatment; say which in the report. Stage and report.

---

### Task 3: The setting, applied at startup and on save

**Files:**
- Create: `apps/shared/src/timeZone.ts` (and export from the package index)
- Modify: `apps/shared/src/schemas/scheduling.ts` (`StationSettingsSchema`, ~1148)
- Modify: `apps/api/src/db/schema.ts` (`stationSettings`, ~1142)
- Create: migration under `apps/api/drizzle/` via `drizzle-kit generate`
- Create: `apps/api/src/services/stationTimeZone.ts`
- Create: `apps/api/src/services/stationTimeZone.test.ts`
- Modify: `apps/api/src/routes/stationSettings.ts`
- Modify: `apps/api/src/index.ts` (`start()`, right after `runMigrations()`)

**Interfaces:**
- Produces from `@soono/shared`:
  - `DEFAULT_STATION_TIMEZONE = 'Europe/Bucharest'`
  - `isValidTimeZoneName(tz: string): boolean` — true only for a zone name the runtime accepts; false for empty strings and for anything starting with `+`, `-` or a digit
  - `StationSettingsSchema.timezone: string` validated with it
- Produces from `stationTimeZone.ts` (no database import — the caller passes the value):
  - `applyStationTimeZone(tz: string | null | undefined): string` — sets `process.env.TZ` to `tz` when valid, otherwise to the default; returns the zone now in force
- Consumes: `requestReconcile(trigger: string)` from `services/supervisor2/bus.js`

- [ ] **Step 1: Write the failing tests** in `stationTimeZone.test.ts`

```ts
describe('isValidTimeZoneName', () => {
  it.each(['Europe/Bucharest', 'UTC', 'America/Argentina/Buenos_Aires'])('accepts %s', (tz) => {
    expect(isValidTimeZoneName(tz)).toBe(true);
  });
  it.each(['', 'Bucharest', '+02:00', '-0300', '2', 'Europe/Nowhere'])('rejects %j', (tz) => {
    expect(isValidTimeZoneName(tz)).toBe(false);
  });
});

describe('applyStationTimeZone', () => {
  it('applies a valid zone and the process clock follows', () => {
    expect(applyStationTimeZone('Europe/Bucharest')).toBe('Europe/Bucharest');
    expect(new Date(Date.UTC(2026, 10, 25, 10)).getHours()).toBe(12);
    expect(new Date(Date.UTC(2026, 6, 1, 10)).getHours()).toBe(13);   // summer time
  });
  it('overrides a zone already present in the environment', () => {
    process.env.TZ = 'America/New_York';
    expect(applyStationTimeZone('Europe/Bucharest')).toBe('Europe/Bucharest');
    expect(process.env.TZ).toBe('Europe/Bucharest');
  });
  it.each([null, undefined, '', '+02:00', 'Nope/Nope'])('falls back to the default for %j', (tz) => {
    process.env.TZ = 'UTC';
    expect(applyStationTimeZone(tz)).toBe('Europe/Bucharest');
    expect(process.env.TZ).toBe('Europe/Bucharest');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @soono/shared build; pnpm --filter api test -- stationTimeZone`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `timeZone.ts` in shared and `stationTimeZone.ts` in the API.** Validity is "constructing an `Intl.DateTimeFormat` with that `timeZone` does not throw", plus the leading-character rule above (newer runtimes accept numeric offsets as zones; the spec forbids them).

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @soono/shared build && pnpm --filter api test -- stationTimeZone`
Expected: PASS.

- [ ] **Step 5: Add the column and generate the migration**

`timezone: text('timezone').notNull().default('Europe/Bucharest')` on `stationSettings`, with a comment pointing at the spec. Then `cd apps/api && pnpm drizzle-kit generate`.
Expected: one new `.sql` containing a single `ALTER TABLE station_settings ADD ... timezone ... DEFAULT 'Europe/Bucharest' NOT NULL` and a new journal entry. Read the file; it must not recreate the table.

- [ ] **Step 6: Schema and route**

Add `timezone` to `StationSettingsSchema`. In `routes/stationSettings.ts`: include `timezone` in both branches of `ensureRow()`; in the PATCH handler, when the parsed body carries a `timezone` different from the stored one, call `applyStationTimeZone`, log at `warn` the old and new zone, and call `requestReconcile('timezone_change')` after the update (`invalidateInventory()` already runs). An invalid zone is already a 400 from the schema — confirm the running zone is untouched in that case.

- [ ] **Step 7: Apply at startup**

In `start()` in `index.ts`, immediately after `runMigrations()` and before `ensureIcecastConfig()`: read `station_settings.timezone` (row may not exist), pass it to `applyStationTimeZone`, and log `{ timezone, environment_tz_was }` at `info` with the message `Station timezone applied`. Nothing that reads clock time runs before this line.

- [ ] **Step 8: Verify against a real boot**

Run: `pnpm --filter @soono/shared build && pnpm type-check && pnpm --filter api test`
Expected: clean.
Run the API locally with a foreign zone in the environment: `TZ=America/New_York pnpm --filter api dev`, then:
`curl -s localhost:3000/settings/station | grep -o '"timezone":"[^"]*"'` → `"timezone":"Europe/Bucharest"`; the startup log shows `Station timezone applied` with `environment_tz_was: "America/New_York"`.
`curl -s -X PATCH localhost:3000/settings/station -H 'content-type: application/json' -d '{"timezone":"+02:00"}' -o /dev/null -w '%{http_code}\n'` → `400`.
`curl -s -X PATCH ... -d '{"timezone":"UTC"}'` → 200, and the supervisor log shows `RECONCILE_START` with `trigger":"timezone_change"`. PATCH it back to `Europe/Bucharest`.
Stage and report.

---

### Task 4: Showing and changing it in the app

**Files:**
- Modify: `apps/web/src/pages/settings/SchedulingSettings.tsx`
- Create: `apps/web/src/components/StationClock.tsx`
- Modify: `apps/web/src/pages/Dashboard.tsx` (header, ~183)
- Modify: `apps/web/src/pages/logs/LogsPage.tsx`

**Interfaces:**
- Consumes: `GET/PATCH /settings/station` with `timezone: string`; `StationSettings` type and `isValidTimeZoneName` from `@soono/shared`.
- Produces: `<StationClock />` — renders the current time in the station's zone and the zone name; reads the setting through the existing `['station-settings']`-style query used by `SchedulingSettings.tsx` (reuse its exact query key and fetch function so the two stay in sync).

- [ ] **Step 1: The setting field**

A new block at the top of `SchedulingSettings.tsx`, same label/hint styling as its neighbours: label **Station timezone**; a text input backed by a `<datalist>` of `Intl.supportedValuesOf('timeZone')`; saved on change through the page's existing mutation only when `isValidTimeZoneName` passes, otherwise an inline error under the field (`text-red-400`) — never a silent no-op. Beside it, the current station time (`<StationClock />`). Hint text, exactly:

> Every scheduled time — shows, calendar and template slots, campaign time windows and campaign dates — is read in this timezone. Changing it moves when things air; do it while the station is Off Air.

- [ ] **Step 2: `StationClock`**

Formats `new Date()` with `Intl.DateTimeFormat(undefined, { timeZone, hour: '2-digit', minute: '2-digit', hour12: false })`, re-rendering every 30 seconds; shows `HH:MM · <zone name>`; renders nothing while the setting is loading.

- [ ] **Step 3: Dashboard header**

Place `<StationClock />` on the right of the Dashboard's `<h1>` row, prefixed **Station time** in `text-zinc-400`.

- [ ] **Step 4: Logs page**

When the selected source is `liquidsoap`, `icecast-error` or `icecast-access`, show one hint line above the log text: `Timestamps in this log are in UTC.` (`text-zinc-400`). The `supervisor` and `api` sources are unchanged.

- [ ] **Step 5: Verify in the browser**

Run `pnpm dev`; open `http://localhost:5173`.
- Dashboard shows `Station time HH:MM · Europe/Bucharest` matching a Bucharest wall clock.
- Settings → Scheduling: typing `Europe/Lond` shows the error and sends no request (Network tab); choosing `Europe/London` saves, the clock on the page and on the Dashboard moves by two hours within 30 s; set it back.
- Logs: the hint appears for the mix engine and both Icecast sources only.
- No errors in the browser console. `pnpm type-check` clean. Stage and report.

---

### Task 5: Deploy readiness

**Files:** none new; `CLAUDE.md` (one paragraph).

- [ ] **Step 1: Document the gotcha.** Add to `CLAUDE.md` under Code Quality Standards a short "Time and timezone" note: clock times are read in the station timezone via the process zone; never build a calendar date with `toISOString()`; never step days by adding 24 hours — use `localDay.ts` / `localYmd` / `addDaysYmd`. Also correct the stale `packages/shared` paths in that file to `apps/shared` only if Daniel agrees when asked (it is outside this spec).

- [ ] **Step 2: Whole-repo check**

Run: `pnpm --filter @soono/shared build && pnpm type-check && pnpm test && pnpm build`
Expected: all green.

- [ ] **Step 3: Image smoke test (before any live container is touched)**

Build the API image on its own and confirm it boots through `Station timezone applied` — per the 2026-07-22 lesson in project memory (`docker compose build soono-api`, then run the image with empty data folders; expect the migration line and no `ERR_MODULE_NOT_FOUND`).

- [ ] **Step 4: Report for rollout.** State plainly for Daniel: the migration adds one column; on deploy the default applies at once, so the schedule moves two hours earlier in real terms; the station is expected to be Off Air when it lands; only the API container needs recreating (`docker compose up -d --no-deps soono-api`). Deploying is his call.
