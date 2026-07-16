/**
 * SpotBudgetService
 *
 * Calculates available ad/promo air time in the schedule.
 * Algorithm: docs/spot-budget-algorithm.md
 * Interface: docs/spot-budget-service.md
 *
 * Three layers:
 *  L1 — inventory: project clock stop-set segments over calendar for period.
 *  L2 — demand: sum campaign fields for the period.
 *  L3 — available: L1 effective − L2 totals.
 */

import { and, eq, gte, inArray, lte, isNotNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '../db/index.js';
import {
  campaigns as campaignsTable,
  calendarEntries as calendarEntriesTable,
  clockSegments as clockSegmentsTable,
  playHistory as playHistoryTable,
  templateEntries as templateEntriesTable,
  templateClockEntries as templateClockEntriesTable,
  stationSettings as stationSettingsTable,
  broadcastIntervals as broadcastIntervalsTable,
  broadcastIntervalSlots as broadcastIntervalSlotsTable,
} from '../db/schema.js';
import { campaignCompletedPlayFilter } from './supervisor2/playHistoryViews.js';
import type {
  Budget,
  BudgetCuts,
  BudgetMode,
  CampaignAvailable,
  CampaignPacingDetail,
  SpotBudgetDemand,
  SpotBudgetInventory,
} from '@soono/shared';

// ─── Constants ────────────────────────────────────────────────────────────────

async function getPromoMargin(): Promise<number> {
  const [row] = await db.select({ promo_margin: stationSettingsTable.promo_margin })
    .from(stationSettingsTable)
    .where(eq(stationSettingsTable.id, 1));
  return row?.promo_margin ?? 0.10;
}

// ─── Internal types ──────────────────────────────────────────────────────────

interface DateRange {
  start: Date;
  end: Date;
}

/** One materialised stop-set occurrence from the calendar projection. */
interface StopSetOccurrence {
  date: string;       // "YYYY-MM-DD"
  dow: number;        // 1=Mon … 7=Sun
  timeStart: string;  // "HH:MM" — used to match broadcast interval windows
  durationSeconds: number;
  showId: number | null;
  clockSegmentId: number;
}

/** Resolved time window for one interval on one day-of-week (minutes from midnight). */
interface IntervalWindow {
  id: number;
  startMin: number;
  endMin: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dateToString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** Days between two dates (inclusive start, exclusive end). */
function daysBetween(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  return Math.max(0, Math.ceil(ms / 86400000));
}

/** ISO day of week: 1=Mon … 7=Sun. */
function isoDay(d: Date): number {
  return ((d.getDay() + 6) % 7) + 1;
}

function emptyBudget(): Budget {
  return { minutes: 0, breaks: 0 };
}

function emptyBudgetCuts(): BudgetCuts {
  return { global: emptyBudget(), byInterval: {}, byShow: {} };
}

function addBudget(a: Budget, b: Budget): Budget {
  return { minutes: a.minutes + b.minutes, breaks: a.breaks + b.breaks };
}

function scaleBudget(b: Budget, factor: number): Budget {
  return { minutes: b.minutes * factor, breaks: b.breaks * factor };
}

function addToCuts(cuts: BudgetCuts, scopeKey: string, value: Budget): void {
  cuts.global = addBudget(cuts.global, value);
  if (scopeKey.startsWith('interval:')) {
    const id = scopeKey.slice('interval:'.length);
    cuts.byInterval[id] = addBudget(cuts.byInterval[id] ?? emptyBudget(), value);
  } else if (scopeKey.startsWith('show:')) {
    const id = scopeKey.slice('show:'.length);
    cuts.byShow[id] = addBudget(cuts.byShow[id] ?? emptyBudget(), value);
  }
}

/** Add to a sub-scope (show or interval) without bumping global — caller already did that. */
function addToSubScope(cuts: BudgetCuts, scopeKey: string, value: Budget): void {
  if (scopeKey.startsWith('interval:')) {
    const id = scopeKey.slice('interval:'.length);
    cuts.byInterval[id] = addBudget(cuts.byInterval[id] ?? emptyBudget(), value);
  } else if (scopeKey.startsWith('show:')) {
    const id = scopeKey.slice('show:'.length);
    cuts.byShow[id] = addBudget(cuts.byShow[id] ?? emptyBudget(), value);
  }
}

// ─── Inventory Cache ───────────────────────────────────────────────────────────

interface CacheEntry {
  inventory: SpotBudgetInventory;
  occurrences: StopSetOccurrence[];
}

const inventoryCache = new Map<string, CacheEntry>();

function makeCacheKey(period: DateRange, mode: BudgetMode): string {
  const raw = `${dateToString(period.start)}:${dateToString(period.end)}:${mode}`;
  return createHash('sha256').update(raw).digest('hex');
}

export function invalidateInventory(): void {
  inventoryCache.clear();
}

// ─── Demand Cache ──────────────────────────────────────────────────────────────

// L2 demand is keyed by today's date + mode. The date acts as a natural 24-hour
// TTL — yesterday's entry is never matched again. Invalidated on campaign save.
const demandCache = new Map<string, SpotBudgetDemand>();

function makeDemandCacheKey(period: DateRange, mode: BudgetMode): string {
  return `${dateToString(period.start)}:${dateToString(period.end)}:${mode}`;
}

export function invalidateDemand(): void {
  demandCache.clear();
}

export function invalidateAll(): void {
  inventoryCache.clear();
  demandCache.clear();
}

// ─── L1 — Inventory ──────────────────────────────────────────────────────────

/**
 * Project all stop-set segments over the calendar for the given period and
 * return the raw + effective (after promo margin) inventory.
 *
 * In live mode, `period.start` is clamped to `max(period.start, now)` before
 * enumeration — past breaks have already aired and their capacity is gone.
 */
async function computeInventory(
  period: DateRange,
  mode: BudgetMode,
): Promise<{ inventory: SpotBudgetInventory; occurrences: StopSetOccurrence[] }> {
  const now = new Date();
  const effectiveStart = mode === 'remaining' && now > period.start ? now : period.start;
  const effectiveStartStr = dateToString(effectiveStart);
  const endStr = dateToString(period.end);

  // ── Load full clock layouts (Decision 95) ─────────────────────────────────
  // The old projection counted each stop-set ONCE per schedule entry,
  // regardless of the entry's window length — undercounting every multi-tile
  // window and attributing every break to the entry's start time for
  // interval matching. Inventory now uses the same entry-anchored tiling as
  // the resolver: a window tiles its clock at the clock's own period, and
  // each tile contributes its stop-sets at their real offsets.
  const allSegRows = await db
    .select({
      id: clockSegmentsTable.id,
      clock_id: clockSegmentsTable.clock_id,
      duration_seconds: clockSegmentsTable.duration_seconds,
      type: clockSegmentsTable.type,
      sort_order: clockSegmentsTable.sort_order,
    })
    .from(clockSegmentsTable);

  interface ClockLayout {
    periodSec: number;
    stopSets: Array<{ id: number; offsetSec: number; durationSec: number }>;
  }
  const layoutByClockId = new Map<number, ClockLayout>();
  {
    const segsByClock = new Map<number, typeof allSegRows>();
    for (const seg of allSegRows) {
      const list = segsByClock.get(seg.clock_id) ?? [];
      list.push(seg);
      segsByClock.set(seg.clock_id, list);
    }
    for (const [clockId, segs] of segsByClock) {
      segs.sort((a, b) => a.sort_order - b.sort_order);
      let offset = 0;
      const stopSets: ClockLayout['stopSets'] = [];
      for (const seg of segs) {
        if (seg.type === 'stop_set') {
          stopSets.push({ id: seg.id, offsetSec: offset, durationSec: seg.duration_seconds });
        }
        offset += seg.duration_seconds;
      }
      layoutByClockId.set(clockId, { periodSec: offset, stopSets });
    }
  }

  // ── Collect calendar entries for the period ───────────────────────────────
  // Calendar entries override template for their specific date.
  const calRows = await db
    .select({
      date: calendarEntriesTable.date,
      time_start: calendarEntriesTable.time_start,
      time_end: calendarEntriesTable.time_end,
      show_id: calendarEntriesTable.show_id,
      clock_id: calendarEntriesTable.clock_id,
    })
    .from(calendarEntriesTable)
    .where(
      and(
        gte(calendarEntriesTable.date, effectiveStartStr),
        lte(calendarEntriesTable.date, endStr),
      ),
    );

  // Group calendar entries by date so we can overlay them on template dates.
  const calByDate = new Map<string, typeof calRows>();
  for (const r of calRows) {
    const list = calByDate.get(r.date) ?? [];
    list.push(r);
    calByDate.set(r.date, list);
  }

  // ── Load template entries + per-hour generic clock slots ─────────────────
  // Two clock types exist in the schedule:
  //   Show clock    — a template/calendar entry with show_id set. Stop-sets count
  //                   toward that show's scoped budget pool.
  //   Generic clock — a templateClockEntry (hour-level, no show_id) or any entry
  //                   with show_id = null. Stop-sets fall into the global pool.
  // When expandTemplateEntry splits a show-block at a generic-clock hour, it
  // correctly sets show_id = null for that sub-slot — the hour belongs to the
  // generic clock, not the surrounding show.
  const [templateRows, templateClockRows, intervalRows, intervalSlotRows] = await Promise.all([
    db.select({
      day_of_week: templateEntriesTable.day_of_week,
      time_start: templateEntriesTable.time_start,
      time_end: templateEntriesTable.time_end,
      show_id: templateEntriesTable.show_id,
      clock_id: templateEntriesTable.clock_id,
    }).from(templateEntriesTable),
    db.select({
      day_of_week: templateClockEntriesTable.day_of_week,
      hour: templateClockEntriesTable.hour,
      clock_id: templateClockEntriesTable.clock_id,
    }).from(templateClockEntriesTable),
    db.select({
      id: broadcastIntervalsTable.id,
      default_start_time: broadcastIntervalsTable.default_start_time,
      default_end_time: broadcastIntervalsTable.default_end_time,
    }).from(broadcastIntervalsTable),
    db.select({
      interval_id: broadcastIntervalSlotsTable.interval_id,
      day_of_week: broadcastIntervalSlotsTable.day_of_week,
      start_time: broadcastIntervalSlotsTable.start_time,
      end_time: broadcastIntervalSlotsTable.end_time,
    }).from(broadcastIntervalSlotsTable),
  ]);

  // Per day-of-week, map hour → generic clock_id
  const clockOverrideByDow = new Map<number, Map<number, number>>();
  for (const tc of templateClockRows) {
    const m = clockOverrideByDow.get(tc.day_of_week) ?? new Map<number, number>();
    m.set(tc.hour, tc.clock_id);
    clockOverrideByDow.set(tc.day_of_week, m);
  }

  // Group template entries by day of week
  const templateByDow = new Map<number, typeof templateRows>();
  for (const te of templateRows) {
    const list = templateByDow.get(te.day_of_week) ?? [];
    list.push(te);
    templateByDow.set(te.day_of_week, list);
  }

  // Build per-dow interval windows. Per-day slots override the interval default times.
  // intervalWindowsByDow: dow → list of {id, startMin, endMin}
  const slotByIntervalDow = new Map<string, { start_time: string; end_time: string }>();
  for (const s of intervalSlotRows) {
    slotByIntervalDow.set(`${s.interval_id}:${s.day_of_week}`, s);
  }
  const intervalWindowsByDow = new Map<number, IntervalWindow[]>();
  for (let dow = 1; dow <= 7; dow++) {
    const windows: IntervalWindow[] = [];
    for (const iv of intervalRows) {
      const slot = slotByIntervalDow.get(`${iv.id}:${dow}`);
      const start = slot ? slot.start_time : iv.default_start_time;
      const end   = slot ? slot.end_time   : iv.default_end_time;
      windows.push({ id: iv.id, startMin: timeToMin(start), endMin: timeToMin(end) });
    }
    intervalWindowsByDow.set(dow, windows);
  }

  // ── Walk each date in [effectiveStart, period.end) ────────────────────────
  const occurrences: StopSetOccurrence[] = [];
  const current = new Date(effectiveStart);
  current.setHours(0, 0, 0, 0);
  const periodEnd = new Date(period.end);
  periodEnd.setHours(23, 59, 59, 999);

  // Decision 95: tile a coverage window with its clock and emit each tile's
  // stop-sets at their real offsets, truncated by the window end. `timeStart`
  // is the break's ACTUAL start time — interval attribution now matches
  // where the break really airs, not the entry's start.
  const pushTiledOccurrences = (
    dateStr: string,
    dow: number,
    clockId: number,
    showId: number | null,
    timeStart: string,
    timeEnd: string,
  ): void => {
    const layout = layoutByClockId.get(clockId);
    if (!layout || layout.periodSec <= 0 || layout.stopSets.length === 0) return;
    const winStartSec = timeToMin(timeStart) * 60;
    const rawEndSec = timeToMin(timeEnd) * 60;
    const winEndSec = rawEndSec > winStartSec ? rawEndSec : 24 * 3600;
    for (let tileStartSec = winStartSec; tileStartSec < winEndSec; tileStartSec += layout.periodSec) {
      for (const ss of layout.stopSets) {
        const occStartSec = tileStartSec + ss.offsetSec;
        if (occStartSec >= winEndSec) break;
        occurrences.push({
          date: dateStr,
          dow,
          timeStart: minToTime(Math.floor(occStartSec / 60)),
          durationSeconds: Math.min(ss.durationSec, winEndSec - occStartSec),
          showId,
          clockSegmentId: ss.id,
        });
      }
    }
  };

  while (current <= periodEnd) {
    const dateStr = dateToString(current);
    const dow = isoDay(current);

    // Use calendar entries for this date (they override the template).
    const calEntries = calByDate.get(dateStr);
    if (calEntries && calEntries.length > 0) {
      for (const ce of calEntries) {
        if (!ce.clock_id) continue;
        pushTiledOccurrences(dateStr, dow, ce.clock_id, ce.show_id, ce.time_start, ce.time_end);
      }
    } else {
      // Fall back to template for this day.
      const templateEntries = templateByDow.get(dow) ?? [];
      const clockOverrides = clockOverrideByDow.get(dow) ?? new Map<number, number>();

      for (const te of templateEntries) {
        // Expand template entry into per-hour slots if generic clock entries exist.
        const slots = expandTemplateEntry(te, clockOverrides);
        for (const slot of slots) {
          if (!slot.clock_id) continue;
          pushTiledOccurrences(dateStr, dow, slot.clock_id, slot.show_id, slot.time_start, slot.time_end);
        }
      }
    }

    current.setDate(current.getDate() + 1);
  }

  // ── Build raw budget cuts from occurrences ────────────────────────────────
  // Each occurrence contributes to global always, to byShow if inside a show slot,
  // and to byInterval for every interval whose time window contains the occurrence.
  // Show and interval pools are overlapping subsets of global — campaigns pick one scope.
  const raw = emptyBudgetCuts();
  for (const occ of occurrences) {
    const budget = { minutes: occ.durationSeconds / 60, breaks: 1 };
    raw.global = addBudget(raw.global, budget);
    if (occ.showId != null) {
      addToSubScope(raw, `show:${occ.showId}`, budget);
    }
    const tMin = timeToMin(occ.timeStart);
    for (const w of intervalWindowsByDow.get(occ.dow) ?? []) {
      if (tMin >= w.startMin && tMin < w.endMin) {
        addToSubScope(raw, `interval:${w.id}`, budget);
      }
    }
  }

  const margin = await getPromoMargin();
  const effective = applyMarginToCuts(raw, margin);

  const inventory: SpotBudgetInventory = {
    raw,
    effective,
    promoMargin: margin,
  };

  return { inventory, occurrences };
}

function expandTemplateEntry(
  te: { time_start: string; time_end: string; show_id: number | null; clock_id: number | null },
  clockOverrides: Map<number, number>,
): { time_start: string; time_end: string; show_id: number | null; clock_id: number | null }[] {
  if (clockOverrides.size === 0) return [te];

  const startMin = timeToMin(te.time_start);
  const endMin = timeToMin(te.time_end);

  const breaks: number[] = [startMin];
  const startHour = Math.ceil(startMin / 60);
  const endHour = Math.floor(endMin / 60);
  for (let h = startHour; h < endHour; h++) {
    if (clockOverrides.has(h)) breaks.push(h * 60);
  }
  breaks.push(endMin);
  const points = [...new Set(breaks)].sort((a, b) => a - b);

  if (points.length <= 2) return [te];

  const result: { time_start: string; time_end: string; show_id: number | null; clock_id: number | null }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const segStart = points[i];
    const segHour = Math.floor(segStart / 60);
    const overrideClock = clockOverrides.get(segHour);
    result.push({
      time_start: minToTime(segStart),
      time_end: minToTime(points[i + 1]),
      show_id: overrideClock !== undefined ? null : te.show_id,
      clock_id: overrideClock !== undefined ? overrideClock : te.clock_id,
    });
  }
  return result.length > 0 ? result : [te];
}

function timeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function minToTime(min: number): string {
  return `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function applyMarginToCuts(raw: BudgetCuts, margin: number): BudgetCuts {
  const factor = 1 - margin;
  // Promo margin reserves time within breaks — it reduces minutes only.
  // Break slots themselves are not eliminated; the count stays the same.
  const minutesOnly = (b: Budget): Budget => ({ minutes: b.minutes * factor, breaks: b.breaks });
  const effective: BudgetCuts = {
    global: minutesOnly(raw.global),
    byInterval: {},
    byShow: {},
  };
  for (const [k, v] of Object.entries(raw.byInterval)) {
    effective.byInterval[k] = minutesOnly(v);
  }
  for (const [k, v] of Object.entries(raw.byShow)) {
    effective.byShow[k] = minutesOnly(v);
  }
  return effective;
}

async function getOrComputeInventory(
  period: DateRange,
  mode: BudgetMode,
): Promise<CacheEntry> {
  const key = makeCacheKey(period, mode);
  const cached = inventoryCache.get(key);
  if (cached) return cached;

  const result = await computeInventory(period, mode);
  const entry: CacheEntry = { inventory: result.inventory, occurrences: result.occurrences };
  inventoryCache.set(key, entry);
  return entry;
}

// ─── L2 — Demand ─────────────────────────────────────────────────────────────

/**
 * Compute aggregate campaign demand for the period.
 * Always fresh — no caching needed, it only sums config fields.
 */
async function computeDemand(
  period: DateRange,
  mode: BudgetMode,
): Promise<SpotBudgetDemand> {
  const now = new Date();
  const effectiveStart = mode === 'remaining' && now > period.start ? now : period.start;
  const periodStartStr = dateToString(effectiveStart);
  const periodEndStr = dateToString(period.end);

  // ── Load all active campaigns in the period window ────────────────────────
  const allCampaigns = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.active, true));

  const activeCampaigns = allCampaigns.filter(
    (c) => c.starts_on <= periodEndStr && c.ends_on >= periodStartStr,
  );

  if (activeCampaigns.length === 0) {
    return { totals: emptyBudgetCuts(), byCampaign: [] };
  }

  const campaignIds = activeCampaigns.map((c) => c.id);

  // ── Actual plays to date per campaign (live mode only) ───────────────────
  const actualPlaysByCampaign = new Map<number, number>();
  if (mode === 'remaining') {
    const playRows = campaignIds.length > 0
      ? await db
          .select({
            campaign_id: playHistoryTable.campaign_id,
          })
          .from(playHistoryTable)
          .where(
            and(
              isNotNull(playHistoryTable.campaign_id),
              inArray(playHistoryTable.campaign_id, campaignIds),
              campaignCompletedPlayFilter,
            ),
          )
      : [];
    for (const r of playRows) {
      const id = r.campaign_id!;
      actualPlaysByCampaign.set(id, (actualPlaysByCampaign.get(id) ?? 0) + 1);
    }
  }

  // ── Compute per-campaign demand ───────────────────────────────────────────
  const totals = emptyBudgetCuts();
  const byCampaign: SpotBudgetDemand['byCampaign'] = [];

  for (const c of activeCampaigns) {
    // Clamp campaign window to the analysis period.
    const campStart = c.starts_on > periodStartStr ? c.starts_on : periodStartStr;
    const campEnd = c.ends_on < periodEndStr ? c.ends_on : periodEndStr;

    const campStartDate = new Date(campStart);
    const campEndDate = new Date(campEnd);
    campEndDate.setDate(campEndDate.getDate() + 1); // make exclusive

    // Total days in the campaign (full range, not clamped).
    const fullStart = new Date(c.starts_on);
    const fullEnd = new Date(c.ends_on);
    fullEnd.setDate(fullEnd.getDate() + 1);
    const totalDays = daysBetween(fullStart, fullEnd);
    const daysInPeriod = daysBetween(campStartDate, campEndDate);

    if (totalDays <= 0 || daysInPeriod <= 0) continue;

    // P = planned plays in period (projection) or remaining plays (live).
    // campaigns.plays_per_month is monthly — pro-rate to the analysis window.
    // For simplicity, we treat "month" as 30 days.
    const DAYS_PER_MONTH = 30;
    const playsInPeriodFull = (c.plays_per_month / DAYS_PER_MONTH) * daysInPeriod;

    let P: number;
    let D: number; // campaign days in period

    if (mode === 'remaining') {
      const actualPlays = actualPlaysByCampaign.get(c.id) ?? 0;
      const plannedTotal = (c.plays_per_month / DAYS_PER_MONTH) * totalDays;
      const remaining = Math.max(0, plannedTotal - actualPlays);
      // For live: P = remaining plays (proportional to remaining days in period).
      const now2 = new Date();
      const liveStart = now2 > campStartDate ? now2 : campStartDate;
      const remainingDaysTotal = daysBetween(liveStart, campEndDate);
      P = remaining > 0 && totalDays > 0
        ? (remaining * daysInPeriod) / Math.max(daysInPeriod, remainingDaysTotal)
        : 0;
      D = daysInPeriod;
    } else {
      P = playsInPeriodFull;
      D = daysInPeriod;
    }

    const duration = c.duration_bracket / 60; // in minutes

    // First-in-slot breaks demand.
    let firstSlotBreaks = 0;
    if (c.first_in_slot && c.first_in_slot_mode) {
      if (c.first_in_slot_mode === 'always') {
        // Every play must be first-in-slot.
        firstSlotBreaks = P;
      } else {
        // 'at_least_one' or 'at_least_one_shared' → at most one per day.
        firstSlotBreaks = D;
      }
    }

    const minutes = P * duration;

    // Campaign scope: show > interval > global (show_id takes precedence).
    let scopeKey: string;
    let scope: SpotBudgetDemand['byCampaign'][number]['scope'];

    if (c.show_id != null) {
      scopeKey = `show:${c.show_id}`;
      scope = { showId: String(c.show_id) };
    } else if (c.interval_id != null) {
      scopeKey = `interval:${c.interval_id}`;
      scope = { intervalId: String(c.interval_id) };
    } else {
      scopeKey = 'global';
      scope = 'global';
    }

    addToCuts(totals, scopeKey, { minutes, breaks: firstSlotBreaks });

    byCampaign.push({
      campaignId: String(c.id),
      minutes,
      firstSlotBreaks,
      scope,
    });
  }

  return { totals, byCampaign };
}

// ─── L3 — Available ──────────────────────────────────────────────────────────

function subtractCuts(effective: BudgetCuts, demand: BudgetCuts): BudgetCuts {
  const result: BudgetCuts = {
    global: {
      minutes: Math.max(0, effective.global.minutes - demand.global.minutes),
      breaks: Math.max(0, effective.global.breaks - demand.global.breaks),
    },
    byInterval: {},
    byShow: {},
  };

  const allIntervalKeys = new Set([
    ...Object.keys(effective.byInterval),
    ...Object.keys(demand.byInterval),
  ]);
  for (const k of allIntervalKeys) {
    const eff = effective.byInterval[k] ?? emptyBudget();
    const dem = demand.byInterval[k] ?? emptyBudget();
    result.byInterval[k] = {
      minutes: Math.max(0, eff.minutes - dem.minutes),
      breaks: Math.max(0, eff.breaks - dem.breaks),
    };
  }

  const allShowKeys = new Set([
    ...Object.keys(effective.byShow),
    ...Object.keys(demand.byShow),
  ]);
  for (const k of allShowKeys) {
    const eff = effective.byShow[k] ?? emptyBudget();
    const dem = demand.byShow[k] ?? emptyBudget();
    result.byShow[k] = {
      minutes: Math.max(0, eff.minutes - dem.minutes),
      breaks: Math.max(0, eff.breaks - dem.breaks),
    };
  }

  return result;
}

// ─── Public service functions ─────────────────────────────────────────────────

export async function getInventory(
  period: DateRange,
  mode: BudgetMode,
): Promise<SpotBudgetInventory> {
  const { inventory } = await getOrComputeInventory(period, mode);
  return inventory;
}

export async function getDemand(
  period: DateRange,
  mode: BudgetMode,
): Promise<SpotBudgetDemand> {
  const key = makeDemandCacheKey(period, mode);
  const cached = demandCache.get(key);
  if (cached) return cached;
  const result = await computeDemand(period, mode);
  demandCache.set(key, result);
  return result;
}

export async function getAvailable(
  period: DateRange,
  mode: BudgetMode,
): Promise<BudgetCuts> {
  const [inv, demand] = await Promise.all([
    getInventory(period, mode),
    getDemand(period, mode),
  ]);
  return subtractCuts(inv.effective, demand.totals);
}

/**
 * L3 from a specific campaign's perspective.
 * Applies first-in-slot sub-pool reduction and non-compete partner footprint.
 */
export async function getCampaignAvailable(
  campaignId: number,
  period: DateRange,
  mode: BudgetMode,
): Promise<Omit<CampaignAvailable, 'pacing'>> {
  const now = new Date();
  const effectiveStart = mode === 'remaining' && now > period.start ? now : period.start;
  const periodStartStr = dateToString(effectiveStart);
  const periodEndStr = dateToString(period.end);

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaignId));

  if (!campaign) {
    return { available: emptyBudget() };
  }

  const [inv, demand] = await Promise.all([
    getInventory(period, mode),
    getDemand(period, mode),
  ]);

  const l3 = subtractCuts(inv.effective, demand.totals);

  // Determine this campaign's scope pool for available minutes.
  let scopedL3: Budget;
  if (campaign.show_id != null) {
    scopedL3 = l3.byShow[String(campaign.show_id)] ?? l3.global;
  } else if (campaign.interval_id != null) {
    scopedL3 = l3.byInterval[String(campaign.interval_id)] ?? l3.global;
  } else {
    scopedL3 = l3.global;
  }

  const DAYS_PER_MONTH = 30;
  const campStart = campaign.starts_on > periodStartStr ? campaign.starts_on : periodStartStr;
  const campEnd = campaign.ends_on < periodEndStr ? campaign.ends_on : periodEndStr;
  const campStartDate = new Date(campStart);
  const campEndDate = new Date(campEnd);
  campEndDate.setDate(campEndDate.getDate() + 1);
  const daysInPeriod = daysBetween(campStartDate, campEndDate);

  // Compute non-compete partner footprint reduction if applicable.
  const partnerIds: number[] = (campaign.competing_exclusions as number[]) ?? [];

  let nonCompeteReduction: Budget | undefined;

  if (partnerIds.length > 0) {
    // Load partner campaigns.
    const partnerCampaigns = await db
      .select()
      .from(campaignsTable)
      .where(
        and(
          inArray(campaignsTable.id, partnerIds),
          eq(campaignsTable.active, true),
        ),
      );

    // Actual plays to date for partners (live mode).
    const partnerActuals = new Map<number, number>();
    if (mode === 'remaining') {
      const partnerPlayRows = partnerIds.length > 0
        ? await db
            .select({ campaign_id: playHistoryTable.campaign_id })
            .from(playHistoryTable)
            .where(
              and(
                isNotNull(playHistoryTable.campaign_id),
                inArray(playHistoryTable.campaign_id, partnerIds),
                campaignCompletedPlayFilter,
              ),
            )
        : [];
      for (const r of partnerPlayRows) {
        const id = r.campaign_id!;
        partnerActuals.set(id, (partnerActuals.get(id) ?? 0) + 1);
      }
    }

    let totalPartnerBreaks = 0;
    let totalPartnerMinutes = 0;

    for (const partner of partnerCampaigns) {
      if (partner.ends_on < periodStartStr || partner.starts_on > periodEndStr) continue;

      let partnerP: number;
      if (mode === 'remaining') {
        const actual = partnerActuals.get(partner.id) ?? 0;
        const fullStart2 = new Date(partner.starts_on);
        const fullEnd2 = new Date(partner.ends_on);
        fullEnd2.setDate(fullEnd2.getDate() + 1);
        const totalDays2 = daysBetween(fullStart2, fullEnd2);
        const plannedTotal2 = (partner.plays_per_month / DAYS_PER_MONTH) * totalDays2;
        partnerP = Math.max(0, plannedTotal2 - actual);
      } else {
        partnerP = (partner.plays_per_month / DAYS_PER_MONTH) * daysInPeriod;
      }

      totalPartnerBreaks += partnerP;
      totalPartnerMinutes += (partnerP * partner.duration_bracket) / 60;
    }

    if (totalPartnerBreaks > 0 || totalPartnerMinutes > 0) {
      nonCompeteReduction = {
        minutes: totalPartnerMinutes,
        breaks: totalPartnerBreaks,
      };
    }
  }

  // Available after non-compete reduction.
  const available: Budget = {
    minutes: Math.max(0, scopedL3.minutes - (nonCompeteReduction?.minutes ?? 0)),
    breaks: Math.max(0, scopedL3.breaks - (nonCompeteReduction?.breaks ?? 0)),
  };

  // First-in-slot: compute the first-slot sub-pool availability.
  let firstSlotAvailable: number | undefined;
  if (campaign.first_in_slot && campaign.first_in_slot_mode) {
    // First-slot sub-pool = L1 effective breaks − sum of all first-slot break demands
    const allFirstSlotDemand = demand.byCampaign.reduce(
      (sum, entry) => sum + entry.firstSlotBreaks,
      0,
    );
    const rawFirstSlotAvailable = Math.max(
      0,
      inv.effective.global.breaks - allFirstSlotDemand,
    );

    // Apply non-compete partner footprint to first-slot pool too.
    const partnerFirstSlotFootprint = partnerIds.length > 0
      ? demand.byCampaign
          .filter((e) => partnerIds.includes(Number(e.campaignId)))
          .reduce((sum, e) => sum + e.firstSlotBreaks, 0)
      : 0;

    firstSlotAvailable = Math.max(0, rawFirstSlotAvailable - partnerFirstSlotFootprint);
  }

  return {
    available,
    ...(firstSlotAvailable !== undefined ? { firstSlotAvailable } : {}),
    ...(nonCompeteReduction ? { nonCompeteReduction } : {}),
  };
}

/**
 * Pacing — always uses live mode. Uses campaign's own date range.
 * Answers whether the campaign is on track to deliver by end date.
 */
export async function getPacing(campaignId: number): Promise<CampaignPacingDetail> {
  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(eq(campaignsTable.id, campaignId));

  if (!campaign) {
    return { expectedToDate: 0, actualToDate: 0, delta: 0, totalPlanned: 0, remaining: 0 };
  }

  const now = new Date();
  const fullStart = new Date(campaign.starts_on);
  const fullEnd = new Date(campaign.ends_on);
  fullEnd.setDate(fullEnd.getDate() + 1); // exclusive

  const DAYS_PER_MONTH = 30;
  const totalDays = Math.max(1, daysBetween(fullStart, fullEnd));
  const totalPlanned = Math.round((campaign.plays_per_month / DAYS_PER_MONTH) * totalDays);

  const elapsedStart = now > fullStart ? fullStart : fullStart;
  const elapsedEnd = now < fullEnd ? now : fullEnd;
  const elapsedDays = Math.max(0, daysBetween(elapsedStart, elapsedEnd));

  const expectedToDate = totalPlanned * (elapsedDays / totalDays);

  // Count actual plays for this campaign (all time within campaign window).
  const playRows = await db
    .select({ id: playHistoryTable.id })
    .from(playHistoryTable)
    .where(
      and(
        eq(playHistoryTable.campaign_id, campaignId),
        gte(playHistoryTable.started_at, fullStart),
        lte(playHistoryTable.started_at, fullEnd),
        campaignCompletedPlayFilter,
      ),
    );
  const actualToDate = playRows.length;

  const delta = actualToDate - expectedToDate;
  const remaining = Math.max(0, totalPlanned - actualToDate);

  return {
    expectedToDate,
    actualToDate,
    delta,
    totalPlanned,
    remaining,
  };
}

// ─── Decision 75 — campaign-driven stop-set recovery multiplier ────────────
//
// Supersedes Decision 74's recovery calculation (not its eligibility-
// exclusion half, which stays in campaign.ts). D74 pre-allocated a fixed
// absolute-seconds share to each of today's scheduled stop-sets, cached for
// the day — which broke whenever a stop-set got skipped (D62 skip-ahead, or
// an operator crossing over one), silently losing whatever share had been
// reserved for it. It also reinvented pacing math this file already does
// more completely (promo margin, show/interval-scoped pool sharing).
//
// This reuses the existing L1 (getInventory)/L2 (getDemand)/L3 (getAvailable)
// system directly: if campaign demand exceeds scheduled stop-set capacity
// for the rest of the month, getAvailable's global minutes goes negative —
// that's the real, already-correct shortfall signal. No caching needed here
// (getAvailable/getInventory already hit this file's own inventoryCache/
// demandCache internally), and no per-segment pre-allocation to lose when a
// stop-set gets skipped — this is recomputed fresh every time a stop-set is
// actually drafted, same as CampaignProcess.buildPool already recomputes
// pacing fresh from play_history on every call.
//
// Returns the raw, uncapped ratio — the safety ceiling (MAX_RECOVERY_MULTIPLIER)
// is applied where it's consumed (planner.ts's assembleStopSetPlan), keeping
// "how behind are we" (pacing) separate from "how big can a break get"
// (scheduling safety).
export async function getStopSetRecoveryMultiplier(nowMs: number): Promise<number> {
  const now = new Date(nowMs);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1); // exclusive
  const period: DateRange = { start: now, end: monthEnd };
  const mode: BudgetMode = 'remaining';

  const [available, inventory] = await Promise.all([
    getAvailable(period, mode),
    getInventory(period, mode),
  ]);

  const totalMinutes = inventory.effective.global.minutes;
  if (totalMinutes <= 0) return 1;

  const shortfallMinutes = Math.max(0, -available.global.minutes);
  return 1 + shortfallMinutes / totalMinutes;
}

export async function getOverview(
  period: DateRange,
  mode: BudgetMode,
): Promise<{
  inventory: SpotBudgetInventory;
  demand: SpotBudgetDemand;
  available: BudgetCuts;
}> {
  const [inventory, demand] = await Promise.all([
    getInventory(period, mode),
    getDemand(period, mode),
  ]);
  const available = subtractCuts(inventory.effective, demand.totals);
  return { inventory, demand, available };
}

// Re-export helpers used by the campaigns route for invalidation.
export { addDays, dateToString };
