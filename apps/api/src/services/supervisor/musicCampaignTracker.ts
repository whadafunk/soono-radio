import type { MusicCampaign } from '../../db/schema.js';
import type { PoolMedia, SnapshotPlayRecord } from './snapshot.js';

/**
 * Snapshot of a music campaign at decision time — pure data the predictor
 * uses without further DB access. The snapshot loader builds these; the
 * tracker helpers consume them.
 */
export interface MusicCampaignSnapshot {
  id: number;
  name: string;
  playlist_id: number;
  plays_per_day: number;
  /** Songs covered by this campaign's contracted playlist. */
  pool: PoolMedia[];
  /** Count of plays so far today, attributed via play_history.music_campaign_id. */
  plays_today: number;
}

/**
 * Filter to campaigns whose date range covers `now`. Used at snapshot-load
 * time so the predictor only ever sees campaigns that should be airing.
 *
 * Pure-helper: takes today's local date string ("YYYY-MM-DD") rather than
 * doing date math itself, so the simulator can pass a synthetic date.
 */
export function isActiveOn(
  campaign: { active: boolean; starts_on: string; ends_on: string },
  localDate: string,
): boolean {
  if (!campaign.active) return false;
  return campaign.starts_on <= localDate && localDate <= campaign.ends_on;
}

/**
 * Pacing ratio = plays_today / plays_per_day. Values < 1 are behind target,
 * = 1 on target, > 1 over target. plays_per_day is positive by schema, so
 * division is safe.
 */
export function pacingRatio(c: { plays_per_day: number }, plays_today: number): number {
  return plays_today / c.plays_per_day;
}

/**
 * Return the campaign that's most behind its daily target. Returns null when
 * every campaign is at or above target — the predictor falls through to the
 * rotation's normal pool in that case.
 *
 * Pacing-first prioritization, ties broken by lowest campaign id for
 * determinism. The "≤ 1" boundary means an at-target campaign is allowed to
 * tie but not steal from a strictly-behind one.
 */
export function pickMostBehind(
  campaigns: ReadonlyArray<MusicCampaignSnapshot>,
): MusicCampaignSnapshot | null {
  let chosen: MusicCampaignSnapshot | null = null;
  let chosenRatio = Number.POSITIVE_INFINITY;
  for (const c of campaigns) {
    if (c.pool.length === 0) continue; // empty playlist — skip
    const r = pacingRatio(c, c.plays_today);
    if (r >= 1) continue; // on/over target
    if (r < chosenRatio || (r === chosenRatio && (!chosen || c.id < chosen.id))) {
      chosen = c;
      chosenRatio = r;
    }
  }
  return chosen;
}

/**
 * Count plays in a history array attributable to a specific music campaign
 * since the start of the local day. The history is expected to be the
 * caller's snapshot — pure, no DB.
 */
export function countPlaysToday(
  campaignId: number,
  history: ReadonlyArray<SnapshotPlayRecord & { music_campaign_id?: number | null }>,
  localMidnight: Date,
): number {
  let count = 0;
  for (const row of history) {
    if (row.music_campaign_id !== campaignId) continue;
    if (row.started_at.getTime() < localMidnight.getTime()) continue;
    count++;
  }
  return count;
}

/** Local midnight for a given date — start of "today" in station time. */
export function startOfLocalDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/** "YYYY-MM-DD" in local time, matching the schema convention for date columns. */
export function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Re-export the row type from schema for callers that want to type the input.
export type { MusicCampaign };
