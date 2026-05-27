// Clock + segment resolution for the Supervisor.
//
// Replaces V1's clockResolver.ts. Given a wall-clock instant, returns the
// segment that should be playing right now, plus the boundaries of that
// segment within the current clock hour.
//
// Resolution priority (highest first):
//   1. Calendar entry whose date + time_start..time_end window contains now
//   2. Template clock entry for (day_of_week, hour) — per-hour override
//   3. Template entry whose (day_of_week, time_start..time_end) covers now,
//      using its clock_id (or show.default_clock_id when no clock_id is set)
//   4. null — silence
//
// Within the resolved clock, segments are laid out in sort_order order
// starting at the top of the resolved hour. Each segment occupies the next
// `duration_seconds` slice. The segment whose [start, end) interval contains
// the offset of `now` within the clock hour is the active segment.

import { and, eq, lte, gte } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import {
  calendarEntries as calendarEntriesTable,
  clockSegments as clockSegmentsTable,
  shows as showsTable,
  templateClockEntries as templateClockEntriesTable,
  templateEntries as templateEntriesTable,
  type ClockSegment,
} from '../../db/schema.js';

export interface ResolvedSegment {
  clock_id: number;
  segment: ClockSegment;
  // Unix ms — start and end wall-clock boundaries of this segment instance.
  segmentStartMs: number;
  segmentEndMs: number;
  // Unix ms — start boundary of the clock hour that this segment belongs to.
  // Plans key off the clock instance, not the segment, so this is the key
  // the Supervisor uses for PLAN_DRAFT_REQUESTED.clock_instance_started_at.
  clockInstanceStartedAt: number;
}

// ISO weekday in our schema: 1 = Mon … 7 = Sun. JS Date.getDay() returns
// 0 = Sun … 6 = Sat, so we translate.
function isoDayOfWeek(d: Date): number {
  const js = d.getDay();
  return js === 0 ? 7 : js;
}

function isoDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function hmString(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Returns the active segment for `nowMs`, or null if no clock is scheduled.
export async function resolveCurrentSegment(
  nowMs: number,
  db: typeof defaultDb = defaultDb,
): Promise<ResolvedSegment | null> {
  const now = new Date(nowMs);
  const dateStr = isoDateString(now);
  const hm = hmString(now);
  const dow = isoDayOfWeek(now);

  // (1) Calendar entry containing now (highest priority).
  const calendarRows = await db
    .select()
    .from(calendarEntriesTable)
    .where(
      and(
        eq(calendarEntriesTable.date, dateStr),
        lte(calendarEntriesTable.time_start, hm),
        gte(calendarEntriesTable.time_end, hm),
      ),
    );
  for (const row of calendarRows) {
    const clockId = await resolveClockIdForEntry(db, row.clock_id, row.show_id);
    if (clockId != null) {
      const resolved = await resolveSegmentWithinClock(db, clockId, nowMs);
      if (resolved) return resolved;
    }
  }

  // (2) Template clock entry — per-hour clock override.
  const hour = now.getHours();
  const [tce] = await db
    .select()
    .from(templateClockEntriesTable)
    .where(
      and(
        eq(templateClockEntriesTable.day_of_week, dow),
        eq(templateClockEntriesTable.hour, hour),
      ),
    );
  if (tce) {
    const resolved = await resolveSegmentWithinClock(db, tce.clock_id, nowMs);
    if (resolved) return resolved;
  }

  // (3) Template entry (day_of_week + time window).
  const templateRows = await db
    .select()
    .from(templateEntriesTable)
    .where(
      and(
        eq(templateEntriesTable.day_of_week, dow),
        lte(templateEntriesTable.time_start, hm),
        gte(templateEntriesTable.time_end, hm),
      ),
    );
  for (const row of templateRows) {
    const clockId = await resolveClockIdForEntry(db, row.clock_id, row.show_id);
    if (clockId != null) {
      const resolved = await resolveSegmentWithinClock(db, clockId, nowMs);
      if (resolved) return resolved;
    }
  }

  return null;
}

// Pulls clock_id out of an entry: prefer the explicit clock_id, otherwise
// fall back to the assigned show's default_clock_id.
async function resolveClockIdForEntry(
  db: typeof defaultDb,
  clockId: number | null | undefined,
  showId: number | null | undefined,
): Promise<number | null> {
  if (clockId != null) return clockId;
  if (showId == null) return null;
  const [show] = await db
    .select({ default_clock_id: showsTable.default_clock_id })
    .from(showsTable)
    .where(eq(showsTable.id, showId));
  return show?.default_clock_id ?? null;
}

// Given a clock_id and now-ms, lays out segments in sort_order starting at
// the top of the current hour and picks the one whose interval contains now.
async function resolveSegmentWithinClock(
  db: typeof defaultDb,
  clockId: number,
  nowMs: number,
): Promise<ResolvedSegment | null> {
  const segments = await db
    .select()
    .from(clockSegmentsTable)
    .where(eq(clockSegmentsTable.clock_id, clockId))
    .orderBy(clockSegmentsTable.sort_order);
  if (segments.length === 0) return null;

  // Clock instance starts at the top of the wall-clock hour containing now.
  const now = new Date(nowMs);
  const hourStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    0,
    0,
    0,
  );
  const hourStartMs = hourStart.getTime();
  let cursorMs = hourStartMs;
  for (const seg of segments) {
    const segStart = cursorMs;
    const segEnd = cursorMs + seg.duration_seconds * 1000;
    if (nowMs >= segStart && nowMs < segEnd) {
      return {
        clock_id: clockId,
        segment: seg,
        segmentStartMs: segStart,
        segmentEndMs: segEnd,
        clockInstanceStartedAt: hourStartMs,
      };
    }
    cursorMs = segEnd;
  }

  // Ran past the end of the clock — no active segment for this hour.
  return null;
}
