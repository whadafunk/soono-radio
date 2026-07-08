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
//   4. station_settings.default_clock_id — station-wide fallback (Decision 53)
//   5. null — no default clock configured (startup misconfiguration)
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
  stationSettings as stationSettingsTable,
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
  // Show context derived from the calendar / template entry that resolved this
  // segment. Null when no show is scheduled (generic clock time). Used by the
  // Supervisor to populate show_id / show_name in PLAN_DRAFT_REQUESTED so the
  // Planner can request show-envelope candidates from the Branding process.
  show_id: number | null;
  show_name: string | null;
  // Which row actually produced this resolution — lets a plan later detect
  // that the schedule changed underneath it even when clock_id/segment/hour
  // happen to resolve identically (see computeResolutionIdentity below).
  source_type: 'calendar' | 'template_clock' | 'template' | 'default';
  source_id: number;
}

// A single deterministic value identifying "this exact schedule decision for
// this exact hour" — the row that resolved it, plus the structural segment
// and wall-clock instance it produced. Stored on `plans` at draft time so a
// later reconcile pass can tell whether the calendar/template row backing an
// in-progress plan has since been edited or replaced.
export function computeResolutionIdentity(resolved: ResolvedSegment): string {
  return `${resolved.source_type}:${resolved.source_id}:${resolved.segment.id}:${resolved.clockInstanceStartedAt}`;
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
    const ctx = await resolveClockContext(db, row.clock_id, row.show_id);
    if (ctx != null) {
      const resolved = await resolveSegmentWithinClock(db, ctx.clockId, nowMs, ctx.showId, ctx.showName, 'calendar', row.id);
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
    const resolved = await resolveSegmentWithinClock(db, tce.clock_id, nowMs, null, null, 'template_clock', tce.id);
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
    const ctx = await resolveClockContext(db, row.clock_id, row.show_id);
    if (ctx != null) {
      const resolved = await resolveSegmentWithinClock(db, ctx.clockId, nowMs, ctx.showId, ctx.showName, 'template', row.id);
      if (resolved) return resolved;
    }
  }

  // (4) Station-wide default clock — last-resort fallback so a moment never
  // resolves to silence just because nothing was explicitly scheduled for it.
  // No fallback beneath this tier: an unset/empty default clock is a startup
  // misconfiguration, not something to design a fallback-of-a-fallback for.
  const [settings] = await db
    .select({ default_clock_id: stationSettingsTable.default_clock_id })
    .from(stationSettingsTable)
    .where(eq(stationSettingsTable.id, 1));
  if (settings?.default_clock_id != null) {
    const resolved = await resolveSegmentWithinClock(db, settings.default_clock_id, nowMs, null, null, 'default', settings.default_clock_id);
    if (resolved) return resolved;
  }

  return null;
}

// Resolves the segment that begins immediately after the segment active at
// `nowMs`. Returns null if there is no following segment (silence, end of
// clock structure, or calendar gap). Used by the Supervisor to request a
// first-pass draft for segment N+1 the moment segment N starts (D29, D32).
export async function resolveNextSegment(
  nowMs: number,
  db: typeof defaultDb = defaultDb,
): Promise<ResolvedSegment | null> {
  const current = await resolveCurrentSegment(nowMs, db);
  if (!current) return null;
  return resolveCurrentSegment(current.segmentEndMs + 1, db);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

interface ClockContext {
  clockId: number;
  showId: number | null;
  showName: string | null;
}

// Resolves clock + show context from an entry's clock_id / show_id fields.
// Prefers the explicit clock_id; falls back to the show's default_clock_id.
// Returns null when neither source yields a clock.
async function resolveClockContext(
  db: typeof defaultDb,
  clockId: number | null | undefined,
  showId: number | null | undefined,
): Promise<ClockContext | null> {
  if (clockId != null) {
    return { clockId, showId: showId ?? null, showName: null };
  }
  if (showId == null) return null;
  const [show] = await db
    .select({ default_clock_id: showsTable.default_clock_id, name: showsTable.name })
    .from(showsTable)
    .where(eq(showsTable.id, showId));
  if (!show?.default_clock_id) return null;
  return {
    clockId: show.default_clock_id,
    showId,
    showName: show.name ?? null,
  };
}

// Given a clock_id and now-ms, lays out segments in sort_order starting at
// the top of the current hour and picks the one whose interval contains now.
async function resolveSegmentWithinClock(
  db: typeof defaultDb,
  clockId: number,
  nowMs: number,
  showId: number | null,
  showName: string | null,
  sourceType: 'calendar' | 'template_clock' | 'template' | 'default',
  sourceId: number,
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
        show_id: showId,
        show_name: showName,
        source_type: sourceType,
        source_id: sourceId,
      };
    }
    cursorMs = segEnd;
  }

  // Ran past the end of the clock — no active segment for this hour.
  return null;
}
