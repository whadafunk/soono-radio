import { and, eq, lte, gt } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  calendarEntries,
  clocks,
  clockSegments,
  shows,
  templateClockEntries,
  templateEntries,
} from '../../db/schema.js';
import type { Clock, ClockSegment, Show } from '../../db/schema.js';

export type ResolvedSource = 'calendar' | 'template_clock' | 'template' | 'fallback';

export interface ResolvedSegment {
  source: ResolvedSource;
  clock: Clock;
  segment: ClockSegment;
  show: Show | null;
  segment_index: number;
  clock_instance_started_at: Date;
  segment_started_at: Date;
  segment_elapsed_seconds: number;
  segment_remaining_seconds: number;
  /**
   * Music playtime minus segment elapsed. Positive = music is behind the
   * segment clock (running long); negative = music has played past the
   * elapsed time (segment overrun). Populated by the supervisor refresh —
   * the resolver itself leaves this 0.
   */
  drift_seconds: number;
  /**
   * True when the supervisor expects a forced cut within HARD_CUT_WARNING_SECONDS
   * (the next segment has start_policy='hard' and the current segment can't be
   * shortened). Populated by the supervisor refresh.
   */
  hard_cut_warning: boolean;
}

/**
 * Resolves which clock + segment is supposed to be on air at `now`. Show
 * context and clock context are resolved independently:
 *
 *  - Show: calendar entry's show wins, otherwise the template span's show.
 *    Per-hour clock overrides do NOT change which show is on air — they
 *    only swap the clock for that hour.
 *  - Clock: calendar > template_clock_entries (per-hour override) >
 *    template span's clock > resolved show's default_clock_id.
 *
 * Returns null when no schedule slot covers `now` (silence / fallback).
 * Pure-ish: only reads from the live DB. No telnet, no writes.
 *
 * Time math assumes the server's local time matches station time — schedule
 * times are stored as bare "HH:MM" strings and a "YYYY-MM-DD" date with no
 * timezone marker. Cross-midnight calendar/template spans are not supported
 * for Phase A (the UI doesn't generate them).
 */
export async function resolveCurrentSegment(
  now: Date = new Date(),
): Promise<ResolvedSegment | null> {
  const dow = jsDayToDow(now.getDay()); // 1=Mon … 7=Sun
  const dateStr = formatDate(now);
  const timeStr = formatTime(now);
  const hour = now.getHours();

  // Gather the three candidate layers in parallel. Each is independent of
  // the others; we'll compose show + clock + slot_start in a second pass.
  const [calRows, tcRows, tRows] = await Promise.all([
    db
      .select()
      .from(calendarEntries)
      .where(
        and(
          eq(calendarEntries.date, dateStr),
          lte(calendarEntries.time_start, timeStr),
          gt(calendarEntries.time_end, timeStr),
        ),
      ),
    db
      .select()
      .from(templateClockEntries)
      .where(
        and(
          eq(templateClockEntries.day_of_week, dow),
          eq(templateClockEntries.hour, hour),
        ),
      ),
    db
      .select()
      .from(templateEntries)
      .where(
        and(
          eq(templateEntries.day_of_week, dow),
          lte(templateEntries.time_start, timeStr),
          gt(templateEntries.time_end, timeStr),
        ),
      ),
  ]);

  const cal = calRows[0] ?? null;
  const perHour = tcRows[0] ?? null;
  const span = tRows[0] ?? null;

  // ── Show context (independent of which clock layer fires) ──────────────────
  const showId = cal?.show_id ?? span?.show_id ?? null;
  const show = showId != null ? await loadShow(showId) : null;

  // ── Clock + source + slot_start ─────────────────────────────────────────────
  let clockId: number | null = null;
  let source: ResolvedSource | null = null;
  let slotStart: Date | null = null;

  if (cal?.clock_id) {
    clockId = cal.clock_id;
    source = 'calendar';
    slotStart = parseLocalDateTime(cal.date, cal.time_start);
  } else if (cal && show?.default_clock_id) {
    // Calendar pinned a show but no explicit clock — derive from show.
    clockId = show.default_clock_id;
    source = 'calendar';
    slotStart = parseLocalDateTime(cal.date, cal.time_start);
  } else if (perHour) {
    // Per-hour override beats the underlying template span's clock. The
    // show (from the span, if any) still applies in parallel.
    clockId = perHour.clock_id;
    source = 'template_clock';
    slotStart = topOfHour(now);
  } else if (span?.clock_id) {
    clockId = span.clock_id;
    source = 'template';
    slotStart = parseLocalDateTime(dateStr, span.time_start);
  } else if (span && show?.default_clock_id) {
    clockId = show.default_clock_id;
    source = 'template';
    slotStart = parseLocalDateTime(dateStr, span.time_start);
  }

  if (clockId == null || source == null || slotStart == null) return null;

  const clock = await loadClock(clockId);
  if (!clock) return null;

  return materialize(source, clock, show, slotStart, now);
}

async function loadClock(id: number): Promise<Clock | null> {
  const rows = await db.select().from(clocks).where(eq(clocks.id, id)).limit(1);
  return rows[0] ?? null;
}

async function loadShow(id: number): Promise<Show | null> {
  const rows = await db.select().from(shows).where(eq(shows.id, id)).limit(1);
  return rows[0] ?? null;
}

function topOfHour(d: Date): Date {
  const out = new Date(d);
  out.setMinutes(0, 0, 0);
  return out;
}

/**
 * Walk a clock's segments to find which one covers `now` given the slot's
 * start. If the clock is shorter than the elapsed time (operator placed a
 * 30min clock in a 1h slot), tile it: the next instance starts at
 * slotStart + N × clock.duration.
 */
async function materialize(
  source: ResolvedSource,
  clock: Clock,
  show: Show | null,
  slotStart: Date,
  now: Date,
): Promise<ResolvedSegment | null> {
  const segRows = await db
    .select()
    .from(clockSegments)
    .where(eq(clockSegments.clock_id, clock.id))
    .orderBy(clockSegments.sort_order);
  if (segRows.length === 0) return null;

  const clockSeconds = segRows.reduce((sum, s) => sum + s.duration_seconds, 0);
  if (clockSeconds <= 0) return null;

  const elapsedInSlot = (now.getTime() - slotStart.getTime()) / 1000;
  if (elapsedInSlot < 0) return null;

  // Tile: how many full clock instances have run, where in the current one we are.
  const instanceIndex = Math.floor(elapsedInSlot / clockSeconds);
  const elapsedInInstance = elapsedInSlot - instanceIndex * clockSeconds;
  const instanceStart = new Date(slotStart.getTime() + instanceIndex * clockSeconds * 1000);

  // Find the segment containing elapsedInInstance.
  let acc = 0;
  for (let i = 0; i < segRows.length; i++) {
    const seg = segRows[i];
    const segEnd = acc + seg.duration_seconds;
    if (elapsedInInstance < segEnd) {
      const segmentStart = new Date(instanceStart.getTime() + acc * 1000);
      const segmentElapsed = elapsedInInstance - acc;
      return {
        source,
        clock,
        segment: seg,
        show,
        segment_index: i,
        clock_instance_started_at: instanceStart,
        segment_started_at: segmentStart,
        segment_elapsed_seconds: Math.max(0, Math.round(segmentElapsed)),
        segment_remaining_seconds: Math.max(0, Math.round(seg.duration_seconds - segmentElapsed)),
        // Drift + hard-cut warning are populated by the supervisor refresh —
        // resolver alone doesn't know about play_history or sibling segments.
        drift_seconds: 0,
        hard_cut_warning: false,
      };
    }
    acc = segEnd;
  }
  // elapsedInInstance landed exactly on the clock boundary — fall through.
  return null;
}

// ── Time helpers ──────────────────────────────────────────────────────────────

/** Convert JS Date.getDay() (0=Sun…6=Sat) to schema dow (1=Mon…7=Sun). */
function jsDayToDow(jsDay: number): number {
  return ((jsDay + 6) % 7) + 1;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Parse "YYYY-MM-DD" + "HH:MM" as a local-time Date. JS's Date constructor
 * with numeric components interprets them as local time, which matches the
 * implicit station-local convention the schema uses.
 */
function parseLocalDateTime(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map((s) => parseInt(s, 10));
  const [hh, mm] = time.split(':').map((s) => parseInt(s, 10));
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}
