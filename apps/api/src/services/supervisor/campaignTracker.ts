import type { Campaign } from '../../db/schema.js';
import type { PoolMedia, SnapshotPlayRecord } from './snapshot.js';

/**
 * Per-decision snapshot of a spot campaign. Built by the snapshot loader so
 * the picker doesn't touch the DB during decision-making.
 */
export interface CampaignSnapshot {
  id: number;
  customer_id: number;
  name: string;
  starts_on: string;
  ends_on: string;
  plays_per_month: number;
  max_plays_per_day: number | null;
  time_window_start: string | null;
  time_window_end: string | null;
  days_of_week: string | null;
  advertiser_separation_spots: number;
  competing_exclusions: number[];
  priority: 'hard' | 'best_effort';
  interval_id: number | null;
  interval_plays_per_week: number | null;
  show_id: number | null;
  first_in_slot: boolean;
  first_in_slot_mode: 'always' | 'at_least_one' | 'at_least_one_shared' | null;
  active: boolean;

  /** play_as_spot=true media for this campaign (joined with media). */
  spot_pool: PoolMedia[];

  /** Plays since local midnight today, attributed via play_history.campaign_id. */
  plays_today: number;
  /** Plays since the start of the current month — drives pacing. */
  plays_this_month: number;
  /** Plays this week within this campaign's interval (if interval_id is set). */
  plays_this_week_in_interval: number;
  /** True if a position-1 play happened today for this campaign. */
  had_position1_today: boolean;
}

// ─── Eligibility ──────────────────────────────────────────────────────────────

/** Date string in local time, "YYYY-MM-DD". */
export function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** "HH:MM" in local time, schema-friendly. */
export function localTimeString(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** Local midnight = start of "today". */
export function startOfLocalDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/** Local Monday 00:00 = start of "this week" (ISO week start). */
export function startOfLocalWeek(d: Date): Date {
  const out = startOfLocalDay(d);
  // JS getDay(): 0=Sun..6=Sat. We want Monday=0..Sunday=6, then subtract.
  const dow = (out.getDay() + 6) % 7;
  out.setDate(out.getDate() - dow);
  return out;
}

/** Start of the calendar month for `d`. */
export function startOfLocalMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

/** Days in the month containing `d`. */
export function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/** dow as 1..7 (Mon..Sun) to match schema convention. */
function jsDayToDow(jsDay: number): number {
  return ((jsDay + 6) % 7) + 1;
}

/**
 * Date-range / day-of-week / time-window / show-scope eligibility.
 * Returns false when the campaign shouldn't fire at all at `now`.
 *
 * Daily/weekly caps and pacing are evaluated separately so the picker can
 * distinguish "ineligible" from "behind pacing".
 */
export function isBaselineEligible(
  c: CampaignSnapshot,
  now: Date,
  currentShowId: number | null,
): boolean {
  if (!c.active) return false;
  const today = localDateString(now);
  if (c.starts_on > today || c.ends_on < today) return false;

  // Time window — null = any time.
  if (c.time_window_start && c.time_window_end) {
    const tnow = localTimeString(now);
    if (tnow < c.time_window_start || tnow >= c.time_window_end) return false;
  }

  // Days-of-week — null = any day.
  if (c.days_of_week) {
    const dow = jsDayToDow(now.getDay());
    const allowed = c.days_of_week
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
    if (!allowed.includes(dow)) return false;
  }

  // Show scope — null = all shows; matched show requires equality.
  if (c.show_id != null && c.show_id !== currentShowId) return false;

  return true;
}

/** Daily cap check — false when at or above max_plays_per_day. */
export function isUnderDailyCap(c: CampaignSnapshot): boolean {
  if (c.max_plays_per_day == null) return true;
  return c.plays_today < c.max_plays_per_day;
}

/** Interval-weekly cap check — false when at or above interval_plays_per_week. */
export function isUnderIntervalWeeklyCap(c: CampaignSnapshot): boolean {
  if (c.interval_plays_per_week == null) return true;
  return c.plays_this_week_in_interval < c.interval_plays_per_week;
}

// ─── Pacing ───────────────────────────────────────────────────────────────────

/**
 * pacing_ratio = plays_to_date / (plays_per_month * elapsed_days / days_in_month)
 *
 * < 1 = under-pacing (behind), == 1 = on track, > 1 = over-pacing.
 * Returns 1 when the monthly target is 0 — defensive (target is positive by
 * schema but guards against bad data).
 */
export function pacingRatio(c: CampaignSnapshot, now: Date): number {
  if (c.plays_per_month <= 0) return 1;
  const elapsed = now.getDate();
  const days = daysInMonth(now);
  const expected = (c.plays_per_month * elapsed) / days;
  if (expected === 0) return 1;
  return c.plays_this_month / expected;
}

/**
 * Pacing → sort-score modifier. Mirrors docs/campaign-delivery.md:
 *   ratio < 0.8 → +2 (under-pacing, boost)
 *   0.8..1.2  → 0   (on track)
 *   > 1.2     → −1  (over-pacing, deprioritise, don't suppress)
 */
export function pacingBoost(ratio: number): number {
  if (ratio < 0.8) return 2;
  if (ratio > 1.2) return -1;
  return 0;
}

/**
 * Composite sort score: hard priority gets +10 over best_effort (so it sorts
 * strictly above), plus the pacing boost. Higher score = picked first.
 */
export function sortScore(c: CampaignSnapshot, now: Date): number {
  const base = c.priority === 'hard' ? 10 : 0;
  return base + pacingBoost(pacingRatio(c, now));
}

// ─── Position-1 helpers ───────────────────────────────────────────────────────

/**
 * A campaign is a position-1 candidate if its first_in_slot flag is on AND
 * either it's an `always` campaign (every play must be at position 1) or it's
 * an `at_least_one` campaign that hasn't yet had its position-1 play today.
 * `at_least_one_shared` falls under at_least_one for picker purposes.
 */
export function isPosition1Candidate(c: CampaignSnapshot): boolean {
  if (!c.first_in_slot) return false;
  if (c.first_in_slot_mode === 'always') return true;
  return !c.had_position1_today;
}

/**
 * `always` campaigns that didn't win position 1 are blocked from non-position-1
 * picks within the same stop-set (they can only ever air at position 1).
 */
export function isBlockedAtNonPosition1(c: CampaignSnapshot): boolean {
  return c.first_in_slot && c.first_in_slot_mode === 'always';
}

// ─── Play-history counting ────────────────────────────────────────────────────

/** Count plays of a campaign since `since` (inclusive). Pure: walks history array. */
export function countPlaysSince(
  campaignId: number,
  history: ReadonlyArray<SnapshotPlayRecord & { campaign_id?: number | null }>,
  since: Date,
): number {
  let n = 0;
  for (const row of history) {
    if (row.campaign_id !== campaignId) continue;
    if (row.started_at.getTime() < since.getTime()) continue;
    n++;
  }
  return n;
}

/** Did this campaign have a position-1 play since `since` (typically local midnight)? */
export function hadPosition1Since(
  campaignId: number,
  history: ReadonlyArray<SnapshotPlayRecord & { campaign_id?: number | null; stop_set_position?: number | null }>,
  since: Date,
): boolean {
  for (const row of history) {
    if (row.campaign_id !== campaignId) continue;
    if (row.stop_set_position !== 1) continue;
    if (row.started_at.getTime() < since.getTime()) continue;
    return true;
  }
  return false;
}

// ─── Re-export Campaign for callers that want to type DB rows ─────────────────
export type { Campaign };
