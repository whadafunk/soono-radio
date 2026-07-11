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
  plans as plansTable,
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

// Reconstructs a specific structural segment's [start, end) wall-clock bounds
// within a clock instance by walking the clock's own segment list in
// sort_order — the same cursor walk resolveSegmentWithinClock uses — rather
// than re-running the full calendar/template resolution chain. Used when the
// caller already knows which clock instance and which structural segment
// it's asking about (e.g. validating/positioning the currently active plan).
export async function segmentBoundsWithinClock(
  db: typeof defaultDb,
  clockId: number,
  segmentId: number,
  clockInstanceStartedAt: number,
): Promise<{ startMs: number; endMs: number } | null> {
  const segments = await db
    .select({ id: clockSegmentsTable.id, duration_seconds: clockSegmentsTable.duration_seconds })
    .from(clockSegmentsTable)
    .where(eq(clockSegmentsTable.clock_id, clockId))
    .orderBy(clockSegmentsTable.sort_order);

  let cursorMs = clockInstanceStartedAt;
  for (const seg of segments) {
    const segEndMs = cursorMs + seg.duration_seconds * 1000;
    if (seg.id === segmentId) return { startMs: cursorMs, endMs: segEndMs };
    cursorMs = segEndMs;
  }
  return null;
}

// Reconstructs a ResolvedSegment-shaped view of `planId`'s own segment and
// clock instance — trusts the plan's own segment_id/clock_instance_started_at
// rather than re-resolving wall clock (Decision 61). Used by activatePlanById
// to drive segment bookkeeping from the plan that just genuinely activated,
// and by /supervisor/v2/status (Decision 64) to derive the operator-facing
// segment/elapsed data from what's actually airing rather than an independent
// resolveCurrentSegment(nowMs) call — under drift the two can disagree.
//
// Show context isn't stored directly on `plans`, but `resolution_identity`
// (Decision 58) records which calendar/template row produced the plan's
// segment resolution — reused here to recover show_id/show_name without
// re-running wall-clock resolution. Plans drafted before that column existed
// (resolution_identity null) fall back to no show context, same as before
// this function existed.
export async function resolveActivePlanSegment(
  db: typeof defaultDb,
  planId: number,
): Promise<ResolvedSegment | null> {
  const [plan] = await db
    .select({
      segment_id: plansTable.segment_id,
      clock_instance_started_at: plansTable.clock_instance_started_at,
      resolution_identity: plansTable.resolution_identity,
    })
    .from(plansTable)
    .where(eq(plansTable.id, planId));
  if (!plan) return null;

  const [segment] = await db
    .select()
    .from(clockSegmentsTable)
    .where(eq(clockSegmentsTable.id, plan.segment_id));
  if (!segment) return null;

  const bounds = await segmentBoundsWithinClock(db, segment.clock_id, segment.id, plan.clock_instance_started_at);
  if (!bounds) return null;

  const { source_type, source_id, show_id, show_name } = await resolveShowFromResolutionIdentity(
    db,
    plan.resolution_identity,
  );

  return {
    clock_id: segment.clock_id,
    segment,
    segmentStartMs: bounds.startMs,
    segmentEndMs: bounds.endMs,
    clockInstanceStartedAt: plan.clock_instance_started_at,
    show_id,
    show_name,
    source_type,
    source_id: source_id ?? planId,
  };
}

// Parses a `resolution_identity` string (`source_type:source_id:segment_id:
// clockInstanceStartedAt`, Decision 58) and, when the source is a calendar or
// template row (the only two that carry a show_id), looks up its show_id and
// resolves the show's name. Returns nulls for template_clock/default sources
// (never show-scoped) or a missing/malformed identity.
async function resolveShowFromResolutionIdentity(
  db: typeof defaultDb,
  resolutionIdentity: string | null,
): Promise<{
  source_type: ResolvedSegment['source_type'];
  source_id: number | null;
  show_id: number | null;
  show_name: string | null;
}> {
  const fallback = { source_type: 'default' as const, source_id: null, show_id: null, show_name: null };
  if (!resolutionIdentity) return fallback;

  const [sourceType, sourceIdStr] = resolutionIdentity.split(':');
  const sourceId = Number(sourceIdStr);
  if (!Number.isFinite(sourceId)) return fallback;
  if (sourceType !== 'calendar' && sourceType !== 'template_clock' && sourceType !== 'template' && sourceType !== 'default') {
    return fallback;
  }

  let showId: number | null = null;
  if (sourceType === 'calendar') {
    const [row] = await db.select({ show_id: calendarEntriesTable.show_id }).from(calendarEntriesTable).where(eq(calendarEntriesTable.id, sourceId));
    showId = row?.show_id ?? null;
  } else if (sourceType === 'template') {
    const [row] = await db.select({ show_id: templateEntriesTable.show_id }).from(templateEntriesTable).where(eq(templateEntriesTable.id, sourceId));
    showId = row?.show_id ?? null;
  }

  let showName: string | null = null;
  if (showId != null) {
    const [show] = await db.select({ name: showsTable.name }).from(showsTable).where(eq(showsTable.id, showId));
    showName = show?.name ?? null;
  }

  return { source_type: sourceType, source_id: sourceId, show_id: showId, show_name: showName };
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
