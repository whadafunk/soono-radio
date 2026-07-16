// Clock + segment resolution for the Supervisor.
//
// Decision 95 (2026-07-16) — the schedule grid is ENTRY-ANCHORED TILING, not
// hour-anchored wheels. One uniform rule: a schedule source defines a
// coverage window; its clock tiles from the window's start, repeating at the
// clock's OWN total duration, truncated by the window's end.
//
//   - Calendar entry   → window [time_start, time_end) on its date; tiling
//                        anchors at time_start.
//   - Template-clock   → per-hour override; its window IS the hour, so it
//     entry               anchors at the hour top by construction.
//   - Template entry   → window [time_start, time_end) on its weekday.
//   - Default clock    → the coverage GAP is the window: anchored at the
//                        gap's leading edge (= the previous coverage
//                        window's end — a stored fact, not runtime history),
//                        truncated by the next coverage window's start.
//                        Degenerate case (no prior coverage within the
//                        lookback horizon): the most recent local midnight.
//
// This matches the schedule editor's own model (SchedulePage's resize-snap
// tiles boundaries as entryStart + k × clockDuration) — the UI is the spec.
// Non-60-minute clocks are first-class: they tile at their own period. For
// on-hour entries with 60-minute clocks the boundaries are bit-identical to
// the old hour-anchored model.
//
// Coverage windows are half-open [start, end): an entry ending 16:00 and one
// starting 16:00 meet with no overlap minute (the old inclusive-end matching
// made the 16:00 minute nondeterministically owned by either entry).
//
// Resolution priority (highest first) is unchanged:
//   1. Calendar entry whose window contains now
//   2. Template clock entry for (day_of_week, hour) — per-hour override
//   3. Template entry whose (day_of_week, window) covers now
//   4. station_settings.default_clock_id over the coverage gap (Decision 53)
//   5. null — no default clock configured (startup misconfiguration)

import { and, eq } from 'drizzle-orm';
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
  // segmentEndMs may be truncated by the coverage window's end (Decision 95);
  // the editor's boundary snapping makes that rare in practice.
  segmentStartMs: number;
  segmentEndMs: number;
  // Unix ms — start of the clock TILE this segment belongs to (Decision 95:
  // windowStart + k × clockDuration; the old model's "top of the hour" is
  // the special case of an on-hour window with a 60-minute clock). Plans key
  // off this value, not the segment, so it's what PLAN_DRAFT_REQUESTED
  // carries as clock_instance_started_at.
  clockInstanceStartedAt: number;
  // Show context derived from the calendar / template entry that resolved
  // this segment. Null when no show is scheduled (generic clock time).
  show_id: number | null;
  show_name: string | null;
  // Which row actually produced this resolution — lets a plan later detect
  // that the schedule changed underneath it even when clock_id/segment/tile
  // happen to resolve identically (see computeResolutionIdentity below).
  source_type: 'calendar' | 'template_clock' | 'template' | 'default';
  source_id: number;
}

// A single deterministic value identifying "this exact schedule decision for
// this exact tile" — the row that resolved it, plus the structural segment
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

// "HH:MM" → minutes since local midnight.
function timeToMinutes(hm: string): number {
  const [h, m] = hm.split(':').map((x) => parseInt(x, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function localMidnightMs(atMs: number): number {
  const d = new Date(atMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

// A window's [startMs, endMs) on a given local day. time_end at-or-before
// time_start means "to end of day" (the editor stores midnight-reaching
// entries that way — see SchedulePage's toSibling).
function windowOnDay(dayMidnightMs: number, timeStart: string, timeEnd: string): { startMs: number; endMs: number } {
  const startMin = timeToMinutes(timeStart);
  const rawEndMin = timeToMinutes(timeEnd);
  const endMin = rawEndMin > startMin ? rawEndMin : 24 * 60;
  return { startMs: dayMidnightMs + startMin * 60_000, endMs: dayMidnightMs + endMin * 60_000 };
}

// ─── Coverage windows (Decision 95) ──────────────────────────────────────────

interface CoverageWindow {
  startMs: number;
  // Exclusive end; null = open-ended (only the degenerate default-clock case
  // when no upcoming coverage exists within the forward horizon).
  endMs: number | null;
  clockId: number;
  showId: number | null;
  showName: string | null;
  sourceType: ResolvedSegment['source_type'];
  sourceId: number;
}

// How far the gap-edge scans look for surrounding coverage before giving up.
const GAP_SCAN_HORIZON_DAYS = 7;

// Finds the highest-priority coverage window containing `nowMs`, or the
// default-clock gap window when nothing covers it. Returns null only when
// the moment is uncovered AND no default clock is configured.
async function resolveCoveringWindow(
  nowMs: number,
  db: typeof defaultDb,
): Promise<CoverageWindow | null> {
  const now = new Date(nowMs);
  const dayMs = localMidnightMs(nowMs);
  const dateStr = isoDateString(now);
  const dow = isoDayOfWeek(now);

  // (1) Calendar entries for this date whose window contains now.
  const calendarRows = await db
    .select()
    .from(calendarEntriesTable)
    .where(eq(calendarEntriesTable.date, dateStr));
  for (const row of calendarRows) {
    const w = windowOnDay(dayMs, row.time_start, row.time_end);
    if (nowMs < w.startMs || nowMs >= w.endMs) continue;
    const ctx = await resolveClockContext(db, row.clock_id, row.show_id);
    if (ctx != null) {
      return {
        startMs: w.startMs, endMs: w.endMs, clockId: ctx.clockId,
        showId: ctx.showId, showName: ctx.showName,
        sourceType: 'calendar', sourceId: row.id,
      };
    }
  }

  // (2) Template clock entry — per-hour clock override. Its window IS the
  // hour (Decision 95: it anchors at the hour top by construction).
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
    const hourStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0).getTime();
    return {
      startMs: hourStartMs, endMs: hourStartMs + 3_600_000, clockId: tce.clock_id,
      showId: null, showName: null, sourceType: 'template_clock', sourceId: tce.id,
    };
  }

  // (3) Template entries for this weekday whose window contains now.
  const templateRows = await db
    .select()
    .from(templateEntriesTable)
    .where(eq(templateEntriesTable.day_of_week, dow));
  for (const row of templateRows) {
    const w = windowOnDay(dayMs, row.time_start, row.time_end);
    if (nowMs < w.startMs || nowMs >= w.endMs) continue;
    const ctx = await resolveClockContext(db, row.clock_id, row.show_id);
    if (ctx != null) {
      return {
        startMs: w.startMs, endMs: w.endMs, clockId: ctx.clockId,
        showId: ctx.showId, showName: ctx.showName,
        sourceType: 'template', sourceId: row.id,
      };
    }
  }

  // (4) Default clock over the coverage gap (Decisions 53 + 95). The gap is
  // itself a window: anchored at the previous coverage's end, truncated by
  // the next coverage's start.
  const [settings] = await db
    .select({ default_clock_id: stationSettingsTable.default_clock_id })
    .from(stationSettingsTable)
    .where(eq(stationSettingsTable.id, 1));
  if (settings?.default_clock_id != null) {
    const gapStartMs = (await latestCoverageEndAtOrBefore(nowMs, db)) ?? localMidnightMs(nowMs);
    const gapEndMs = await earliestCoverageStartAfter(nowMs, db);
    return {
      startMs: gapStartMs, endMs: gapEndMs, clockId: settings.default_clock_id,
      showId: null, showName: null,
      sourceType: 'default', sourceId: settings.default_clock_id,
    };
  }

  return null;
}

// All schedule windows (calendar + template_clock + template) on one local
// day, as absolute [startMs, endMs) — used only by the gap-edge scans, so
// clock resolvability doesn't matter here: any entry row marks a schedule
// edge the gap should anchor to / truncate at.
async function scheduleWindowsOnDay(dayMidnightMs: number, db: typeof defaultDb): Promise<Array<{ startMs: number; endMs: number }>> {
  const d = new Date(dayMidnightMs);
  const dateStr = isoDateString(d);
  const dow = isoDayOfWeek(d);

  const [calendarRows, templateRows, templateClockRows] = await Promise.all([
    db.select({ time_start: calendarEntriesTable.time_start, time_end: calendarEntriesTable.time_end })
      .from(calendarEntriesTable).where(eq(calendarEntriesTable.date, dateStr)),
    db.select({ time_start: templateEntriesTable.time_start, time_end: templateEntriesTable.time_end })
      .from(templateEntriesTable).where(eq(templateEntriesTable.day_of_week, dow)),
    db.select({ hour: templateClockEntriesTable.hour })
      .from(templateClockEntriesTable).where(eq(templateClockEntriesTable.day_of_week, dow)),
  ]);

  const windows: Array<{ startMs: number; endMs: number }> = [];
  for (const row of calendarRows) windows.push(windowOnDay(dayMidnightMs, row.time_start, row.time_end));
  for (const row of templateRows) windows.push(windowOnDay(dayMidnightMs, row.time_start, row.time_end));
  for (const row of templateClockRows) {
    const startMs = dayMidnightMs + row.hour * 3_600_000;
    windows.push({ startMs, endMs: startMs + 3_600_000 });
  }
  return windows;
}

// Latest coverage-window end at or before `tMs` — the gap's leading edge.
// By construction nothing covers tMs when this is called, so every window
// either ends at/before tMs or starts after it.
async function latestCoverageEndAtOrBefore(tMs: number, db: typeof defaultDb): Promise<number | null> {
  for (let dayOffset = 0; dayOffset <= GAP_SCAN_HORIZON_DAYS; dayOffset++) {
    const dayMs = localMidnightMs(tMs) - dayOffset * 86_400_000;
    const windows = await scheduleWindowsOnDay(dayMs, db);
    let best: number | null = null;
    for (const w of windows) {
      if (w.endMs <= tMs && (best == null || w.endMs > best)) best = w.endMs;
    }
    if (best != null) return best;
  }
  return null;
}

// Earliest coverage-window start after `tMs` — where the gap window ends.
async function earliestCoverageStartAfter(tMs: number, db: typeof defaultDb): Promise<number | null> {
  for (let dayOffset = 0; dayOffset <= GAP_SCAN_HORIZON_DAYS; dayOffset++) {
    const dayMs = localMidnightMs(tMs) + dayOffset * 86_400_000;
    const windows = await scheduleWindowsOnDay(dayMs, db);
    let best: number | null = null;
    for (const w of windows) {
      if (w.startMs > tMs && (best == null || w.startMs < best)) best = w.startMs;
    }
    if (best != null) return best;
  }
  return null;
}

// ─── Tiling within a window (Decision 95) ────────────────────────────────────

// Lays the window's clock from the window start, repeating at the clock's
// own total duration, truncated by the window end, and picks the segment
// whose [start, end) contains `tMs`.
async function resolveWithinWindow(
  db: typeof defaultDb,
  win: CoverageWindow,
  tMs: number,
): Promise<ResolvedSegment | null> {
  const segments = await db
    .select()
    .from(clockSegmentsTable)
    .where(eq(clockSegmentsTable.clock_id, win.clockId))
    .orderBy(clockSegmentsTable.sort_order);
  if (segments.length === 0) return null;

  const clockDurMs = segments.reduce((sum, s) => sum + s.duration_seconds, 0) * 1000;
  if (clockDurMs <= 0) return null;
  if (tMs < win.startMs) return null;
  if (win.endMs != null && tMs >= win.endMs) return null;

  const tileIndex = Math.floor((tMs - win.startMs) / clockDurMs);
  const tileStartMs = win.startMs + tileIndex * clockDurMs;

  let cursorMs = tileStartMs;
  for (const seg of segments) {
    const rawEndMs = cursorMs + seg.duration_seconds * 1000;
    const segStartMs = cursorMs;
    const segEndMs = win.endMs != null ? Math.min(rawEndMs, win.endMs) : rawEndMs;
    if (tMs >= segStartMs && tMs < segEndMs) {
      return {
        clock_id: win.clockId,
        segment: seg,
        segmentStartMs: segStartMs,
        segmentEndMs: segEndMs,
        clockInstanceStartedAt: tileStartMs,
        show_id: win.showId,
        show_name: win.showName,
        source_type: win.sourceType,
        source_id: win.sourceId,
      };
    }
    cursorMs = rawEndMs;
    if (win.endMs != null && cursorMs >= win.endMs) break;
  }
  return null;
}

// Returns the active segment for `nowMs`, or null if no clock is scheduled.
export async function resolveCurrentSegment(
  nowMs: number,
  db: typeof defaultDb = defaultDb,
): Promise<ResolvedSegment | null> {
  const win = await resolveCoveringWindow(nowMs, db);
  if (!win) return null;
  return resolveWithinWindow(db, win, nowMs);
}

// Resolves the segment that begins immediately after the segment active at
// `nowMs`. Returns null if there is no following segment. Used by the
// Supervisor to request a first-pass draft for segment N+1 the moment
// segment N starts (D29, D32).
export async function resolveNextSegment(
  nowMs: number,
  db: typeof defaultDb = defaultDb,
): Promise<ResolvedSegment | null> {
  const current = await resolveCurrentSegment(nowMs, db);
  if (!current) return null;
  return resolveCurrentSegment(current.segmentEndMs + 1, db);
}

// Reconstructs a specific structural segment's [start, end) wall-clock bounds
// within a clock tile by walking the clock's own segment list in sort_order —
// the same cursor walk resolveWithinWindow uses — rather than re-running the
// full window resolution. Used when the caller already knows which tile
// (clock_instance_started_at) and which structural segment it's asking about
// (e.g. validating/positioning the currently active plan).
//
// Decision 95 note: bounds computed here are NOT truncated by the coverage
// window (the tile start alone doesn't identify the window). Slots truncated
// by a window edge are rare by construction — the editor snaps entry edges
// to segment boundaries — so plan bookkeeping accepts the untruncated length
// for those edge slots rather than paying a full window resolution here.
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
// clock tile — trusts the plan's own segment_id/clock_instance_started_at
// rather than re-resolving wall clock (Decision 61). Used by activatePlanById
// to drive segment bookkeeping from the plan that just genuinely activated,
// and by /supervisor/v2/status (Decision 64).
//
// Show context isn't stored directly on `plans`, but `resolution_identity`
// (Decision 58) records which calendar/template row produced the plan's
// segment resolution — reused here to recover show_id/show_name without
// re-running wall-clock resolution.
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

// Parses a `clock_segments.start_policy` value (stored as JSON text or
// already-parsed object, depending on caller) into its typed form. The
// single canonical implementation — previously duplicated between
// supervisor.ts and planner.ts with slightly different shapes; consolidated
// here (Decision 62) since the forward-scanning hard-segment resolver
// needs it too.
export function readStartPolicy(raw: unknown): { type: 'hard' | 'flexible'; early_seconds?: number | null } {
  if (raw && typeof raw === 'object' && 'type' in raw) {
    const t = (raw as { type: unknown; early_seconds?: unknown }).type;
    if (t === 'hard') return { type: 'hard' };
    if (t === 'flexible') {
      const es = (raw as { early_seconds?: unknown }).early_seconds;
      return { type: 'flexible', early_seconds: typeof es === 'number' ? es : null };
    }
  }
  if (typeof raw === 'string') {
    try { return readStartPolicy(JSON.parse(raw)); } catch { /* fall through */ }
  }
  return { type: 'flexible', early_seconds: null };
}

export interface HardSegmentLookahead {
  hard: ResolvedSegment;
  // Segments between `afterMs` and `hard`, in schedule order — none of them
  // have a hard start_policy, or the walk would have stopped there instead.
  // Empty when `hard` is the immediate next segment (no gap at all).
  skipped: ResolvedSegment[];
}

// Walks forward through the resolved schedule, one segment at a time,
// starting just after `afterMs`, until it finds a segment whose
// start_policy.type === 'hard' (Decision 62). Distinct from
// `resolveNextSegment`, which only ever answers "current+1" — this can walk
// across many segments, tiles, and coverage windows. Bounded by
// `maxSegments` so a schedule with no hard segments at all (or a resolution
// gap) can't spin forever; returns null if nothing hard is found within the
// horizon, which callers should treat as "no lookahead hazard right now."
export async function resolveNextHardSegment(
  afterMs: number,
  db: typeof defaultDb = defaultDb,
  maxSegments = 50,
): Promise<HardSegmentLookahead | null> {
  const skipped: ResolvedSegment[] = [];
  let cursorMs = afterMs;
  for (let i = 0; i < maxSegments; i++) {
    const next = await resolveCurrentSegment(cursorMs, db);
    if (!next) return null;
    if (readStartPolicy(next.segment.start_policy).type === 'hard') return { hard: next, skipped };
    skipped.push(next);
    cursorMs = next.segmentEndMs + 1;
  }
  return null;
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
