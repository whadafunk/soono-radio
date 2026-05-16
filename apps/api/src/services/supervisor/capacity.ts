import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  templateEntries,
  templateClockEntries,
  clockSegments,
  shows,
  broadcastIntervals,
  broadcastIntervalSlots,
} from '../../db/schema.js';

// ─── Output types ─────────────────────────────────────────────────────────────

export interface DayCapacity {
  day_of_week: number;   // 1=Mon … 7=Sun
  total_slots: number;   // stop_set segments that fire this day
  total_seconds: number; // sum of their duration_seconds
}

export interface IntervalCapacity {
  interval_id: number;
  interval_name: string;
  total_slots: number;
  total_seconds: number;
}

export interface WeeklyCapacity {
  by_dow: DayCapacity[];
  by_interval: IntervalCapacity[];
}

// ─── Resolution helpers ───────────────────────────────────────────────────────

// "HH:MM" string for hour H (0–23)
function hourToTime(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}

// Does the closed interval [slotStart, slotEnd) contain the hour starting at hourTime?
// Both are "HH:MM" strings; the hour covers [hourTime, hourTime+1h).
function hourFallsInSlot(hourTime: string, slotStart: string, slotEnd: string): boolean {
  const hourEnd = hourToTime(parseInt(hourTime.slice(0, 2), 10) + 1);
  // Overlap: hourTime < slotEnd && hourEnd > slotStart
  return hourTime < slotEnd && hourEnd > slotStart;
}

// ─── Main calculator ──────────────────────────────────────────────────────────

/**
 * Calculates weekly stop-set capacity from the static schedule template.
 *
 * Does NOT account for calendar overrides (those are date-specific and change
 * capacity only for that date; they're irrelevant for planning purposes).
 * Also does NOT account for shows with no default_clock_id — those hours are
 * treated as silence.
 */
export async function computeWeeklyCapacity(): Promise<WeeklyCapacity> {
  // Load everything up front — these tables are small.
  const [
    templateEntriesRows,
    templateClockRows,
    showRows,
    stopSetRows,
    intervalRows,
    intervalSlotRows,
  ] = await Promise.all([
    db.select().from(templateEntries),
    db.select().from(templateClockEntries),
    db.select({ id: shows.id, default_clock_id: shows.default_clock_id }).from(shows),
    db.select({
      id: clockSegments.id,
      clock_id: clockSegments.clock_id,
      duration_seconds: clockSegments.duration_seconds,
    }).from(clockSegments).where(eq(clockSegments.type, 'stop_set')),
    db.select().from(broadcastIntervals),
    db.select().from(broadcastIntervalSlots),
  ]);

  // Build lookup maps
  const showClockMap = new Map<number, number | null>( // show_id → default_clock_id
    showRows.map((s) => [s.id, s.default_clock_id]),
  );

  // stop_set segments grouped by clock_id
  const stopSetsByClockId = new Map<number, Array<{ id: number; duration_seconds: number }>>();
  for (const seg of stopSetRows) {
    const list = stopSetsByClockId.get(seg.clock_id) ?? [];
    list.push({ id: seg.id, duration_seconds: seg.duration_seconds });
    stopSetsByClockId.set(seg.clock_id, list);
  }

  // interval slots grouped by interval_id → Map<day_of_week, {start_time, end_time}>
  const intervalSlotsByInterval = new Map<number, Map<number, { start_time: string; end_time: string }>>();
  for (const slot of intervalSlotRows) {
    let byDow = intervalSlotsByInterval.get(slot.interval_id);
    if (!byDow) {
      byDow = new Map();
      intervalSlotsByInterval.set(slot.interval_id, byDow);
    }
    byDow.set(slot.day_of_week, { start_time: slot.start_time, end_time: slot.end_time });
  }

  // ── Resolve clock for each (dow, hour) ───────────────────────────────────

  function resolveClockId(dow: number, hour: number): number | null {
    // Priority 1: per-hour clock override in template
    const clockOverride = templateClockRows.find(
      (e) => e.day_of_week === dow && e.hour === hour,
    );
    if (clockOverride) return clockOverride.clock_id;

    // Priority 2: show / clock span in template
    const hourStart = hourToTime(hour);
    const span = templateEntriesRows.find(
      (e) =>
        e.day_of_week === dow &&
        e.time_start <= hourStart &&
        e.time_end > hourStart,
    );
    if (!span) return null;

    // Span may point directly to a clock or to a show whose default_clock_id applies
    if (span.clock_id) return span.clock_id;
    if (span.show_id) return showClockMap.get(span.show_id) ?? null;
    return null;
  }

  // ── Accumulate ────────────────────────────────────────────────────────────

  const byDow: DayCapacity[] = Array.from({ length: 7 }, (_, i) => ({
    day_of_week: i + 1,
    total_slots: 0,
    total_seconds: 0,
  }));

  const byInterval = new Map<number, IntervalCapacity>(
    intervalRows.map((iv) => [
      iv.id,
      { interval_id: iv.id, interval_name: iv.name, total_slots: 0, total_seconds: 0 },
    ]),
  );

  for (let dow = 1; dow <= 7; dow++) {
    const dayEntry = byDow[dow - 1];

    for (let hour = 0; hour <= 23; hour++) {
      const clockId = resolveClockId(dow, hour);
      if (!clockId) continue;

      const stopSets = stopSetsByClockId.get(clockId) ?? [];
      if (stopSets.length === 0) continue;

      const hourTime = hourToTime(hour);

      for (const seg of stopSets) {
        dayEntry.total_slots++;
        dayEntry.total_seconds += seg.duration_seconds;

        // Check if this hour falls within any broadcast interval's slot for this dow
        for (const iv of intervalRows) {
          const slot = intervalSlotsByInterval.get(iv.id)?.get(dow);
          if (!slot) continue;
          if (hourFallsInSlot(hourTime, slot.start_time, slot.end_time)) {
            const entry = byInterval.get(iv.id)!;
            entry.total_slots++;
            entry.total_seconds += seg.duration_seconds;
          }
        }
      }
    }
  }

  return {
    by_dow: byDow,
    by_interval: [...byInterval.values()],
  };
}
