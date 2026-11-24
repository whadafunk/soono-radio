// Calendar-day arithmetic in the station's timezone.
//
// "Local" here is the process's timezone, which the API sets to the station
// timezone at startup (see services/stationTimeZone.ts and
// docs/station-timezone-design.md). Dependency-free on purpose so it can be
// unit-tested under a fixed zone (localDay.test.ts).
//
// One rule runs through every function: a time on a local day is built with
// the local Date constructor, never as "midnight + N milliseconds", and days
// are stepped by calendar date, never by adding 24 hours. A local day is 23
// or 25 hours long on the two days a year the clocks change; the arithmetic
// shortcuts put every slot after the change an hour off for the rest of that
// day and miscounted days across it.

// ISO weekday in our schema: 1 = Mon … 7 = Sun. JS Date.getDay() returns
// 0 = Sun … 6 = Sat, so we translate.
export function isoDayOfWeek(d: Date): number {
  const js = d.getDay();
  return js === 0 ? 7 : js;
}

// Local calendar date as YYYY-MM-DD.
export function isoDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// "HH:MM" → minutes since local midnight.
export function timeToMinutes(hm: string): number {
  const [h, m] = hm.split(':').map((x) => parseInt(x, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

export function localMidnightMs(atMs: number): number {
  const d = new Date(atMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

// The wall-clock time `minutes` after midnight on the local day that starts
// at `dayMidnightMs`. 1440 is the next local midnight. A time inside the hour
// skipped in spring resolves to the instant the clocks jump; the hour repeated
// in autumn resolves to its first occurrence.
export function localTimeOnDayMs(dayMidnightMs: number, minutes: number): number {
  const d = new Date(dayMidnightMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, minutes, 0, 0).getTime();
}

// Local midnight `days` calendar days away from the local day that starts at
// `dayMidnightMs` (negative = earlier).
export function addLocalDaysMs(dayMidnightMs: number, days: number): number {
  const d = new Date(dayMidnightMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 0, 0, 0, 0).getTime();
}

// A window's [startMs, endMs) on a given local day. time_end at-or-before
// time_start means "to end of day" (the editor stores midnight-reaching
// entries that way — see SchedulePage's toSibling).
export function windowOnDay(dayMidnightMs: number, timeStart: string, timeEnd: string): { startMs: number; endMs: number } {
  const startMin = timeToMinutes(timeStart);
  const rawEndMin = timeToMinutes(timeEnd);
  const endMin = rawEndMin > startMin ? rawEndMin : 24 * 60;
  return {
    startMs: localTimeOnDayMs(dayMidnightMs, startMin),
    endMs: localTimeOnDayMs(dayMidnightMs, endMin),
  };
}

// Inclusive day count between two YYYY-MM-DD dates (same day = 1).
export function daysInclusive(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split('-').map((s) => parseInt(s, 10));
  const [ty, tm, td] = toYmd.split('-').map((s) => parseInt(s, 10));
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

// Local midnight of the Monday of the week containing `nowMs`.
export function startOfIsoWeekMs(nowMs: number): number {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (isoDayOfWeek(d) - 1), 0, 0, 0, 0).getTime();
}

// A YYYY-MM-DD string as local midnight. `new Date('YYYY-MM-DD')` parses as
// UTC midnight instead, which is 02:00 or 03:00 station time — close enough
// to pass casual checks, wrong for any time-of-day or day-count comparison.
export function parseLocalYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map((s) => parseInt(s, 10));
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
}

// Days from `start` to `end` where a day that has started counts as a day —
// the same answer as ceil(elapsed / 24h) on an ordinary day, but taken from
// calendar dates and wall-clock time so a 23- or 25-hour day cannot add or
// drop one. Never negative.
export function startedDaysBetween(start: Date, end: Date): number {
  const timeOfDay = (d: Date): number =>
    ((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * 1000 + d.getMilliseconds();
  const startDay = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endDay = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  const wholeDays = Math.round((endDay - startDay) / 86_400_000);
  return Math.max(0, wholeDays + (timeOfDay(end) > timeOfDay(start) ? 1 : 0));
}
