import type { MusicPickSnapshot, PoolMedia, PromoSnapshot } from './snapshot.js';
import type { SegmentPick } from './predictor.js';
import {
  isBaselineEligible,
  isBlockedAtNonPosition1,
  isPosition1Candidate,
  isUnderDailyCap,
  isUnderIntervalWeeklyCap,
  sortScore,
  type CampaignSnapshot,
} from './campaignTracker.js';
import { runRotation } from './rotations/index.js';
import { composeSeed } from './rotations/rng.js';
import type { RotationContext } from './rotations/types.js';

/**
 * Minimum duration we'll try to fit. Below this threshold the picker stops
 * trying — avoids infinite loops on tiny tail-end gaps.
 */
const MIN_SPOT_DURATION_SECONDS = 5;

/**
 * Pure function. Given a snapshot whose segment is type='stop_set', returns
 * the next slot to push (one tick = one slot). The picker walks through the
 * stop-set position by position; later ticks see earlier picks via the
 * already_played array on the snapshot.
 *
 * Returns null when:
 *   - The segment isn't a stop_set (defensive — caller routes correctly)
 *   - Remaining time < MIN_SPOT_DURATION_SECONDS
 *   - No campaign and no promo fits
 */
export function pickNextStopSetSlot(
  snap: MusicPickSnapshot,
  now: Date,
): SegmentPick | null {
  if (!snap.stop_set) return null;
  const seg = snap.scheduled.segment;
  if (seg.type !== 'stop_set') return null;

  const { campaigns, promos, already_played } = snap.stop_set;
  const consumed = already_played.reduce((sum, p) => sum + (p.duration_seconds || 0), 0);
  const remaining = seg.duration_seconds - consumed;
  if (remaining < MIN_SPOT_DURATION_SECONDS) return null;

  const nextPosition = already_played.length + 1;

  // Campaigns already selected in THIS stop-set are blocked from a second
  // slot in the same break. (Cross-stop-set repeats are governed by
  // max_plays_per_day, not stop-set position.)
  const selectedCampaignIds = new Set(
    already_played.map((p) => p.campaign_id).filter((id): id is number => id != null),
  );
  // Competing exclusions are bidirectional and pre-computed on each campaign;
  // walking selected campaigns gives us the full exclusion set.
  const excludedCampaignIds = new Set<number>();
  for (const selectedId of selectedCampaignIds) {
    const c = campaigns.find((x) => x.id === selectedId);
    if (c) for (const id of c.competing_exclusions) excludedCampaignIds.add(id);
  }

  // Map already-played slots → customer_id to enforce advertiser_separation_spots.
  // We need this lookup to skip campaigns whose customer aired too recently.
  const customerOfCampaign = new Map<number, number>();
  for (const c of campaigns) customerOfCampaign.set(c.id, c.customer_id);
  const playedCustomers: (number | null)[] = already_played.map((p) =>
    p.campaign_id != null ? (customerOfCampaign.get(p.campaign_id) ?? null) : null,
  );

  const currentShowId = snap.scheduled.show?.id ?? null;
  const baseSeed = composeSeed(Math.floor(now.getTime() / 60_000), seg.id, nextPosition);

  // ── Step 1: build the eligible-campaigns pool ────────────────────────────
  const eligibles = campaigns.filter((c) => {
    if (selectedCampaignIds.has(c.id)) return false;
    if (excludedCampaignIds.has(c.id)) return false;
    if (!isBaselineEligible(c, now, currentShowId)) return false;
    if (!isUnderDailyCap(c)) return false;
    if (!isUnderIntervalWeeklyCap(c)) return false;
    if (c.spot_pool.length === 0) return false;
    // Advertiser separation: skip if a spot from the same customer aired
    // within advertiser_separation_spots positions of this one.
    if (c.advertiser_separation_spots > 0) {
      const lookback = Math.min(c.advertiser_separation_spots, playedCustomers.length);
      for (let i = playedCustomers.length - lookback; i < playedCustomers.length; i++) {
        if (playedCustomers[i] === c.customer_id) return false;
      }
    }
    // Must have at least one spot whose duration fits in remaining time.
    if (c.spot_pool.every((m) => m.duration_seconds > remaining)) return false;
    return true;
  });

  // ── Step 2: position-1 handling vs general fill ──────────────────────────
  let candidatePool: CampaignSnapshot[];
  if (nextPosition === 1) {
    // Prefer first_in_slot campaigns for slot 1. If none qualify, fall back
    // to all eligibles — better to fill the slot than leave a gap.
    const position1 = eligibles.filter(isPosition1Candidate);
    candidatePool = position1.length > 0 ? position1 : eligibles;
  } else {
    // 'always' campaigns that didn't win slot 1 are blocked from non-slot-1
    // positions in this break. 'at_least_one' campaigns that already got a
    // position-1 play today CAN air at later positions (the constraint is
    // satisfied for the day).
    candidatePool = eligibles.filter((c) => !isBlockedAtNonPosition1(c));
  }

  // Sort: hard priority + pacing boost. Highest score first; ties broken by
  // lowest id for determinism.
  candidatePool.sort((a, b) => {
    const sa = sortScore(a, now);
    const sb = sortScore(b, now);
    if (sa !== sb) return sb - sa;
    return a.id - b.id;
  });

  // ── Step 3: try each candidate; pick its LRP spot media that fits ────────
  for (const c of candidatePool) {
    const pick = pickFittingSpot(c, snap, remaining, composeSeed(baseSeed, c.id));
    if (pick) {
      return {
        media: pick,
        reason: `[stop_set pos=${nextPosition}] campaign='${c.name}' priority=${c.priority} (plays today=${c.plays_today}${c.max_plays_per_day ? '/' + c.max_plays_per_day : ''})`,
        music_campaign_id: null,
        campaign_id: c.id,
        promo_id: null,
        stop_set_position: nextPosition,
      };
    }
  }

  // ── Step 4: fall through to promos ───────────────────────────────────────
  // No campaign fit or none eligible. Try promos to fill the slot. Order:
  //   1. Promos still under min_plays_per_day (need-to-air) — by gap-to-min
  //   2. Other eligible promos — by least-recently-played (today-count asc)
  // Exclude any promo whose show_id matches the current show when
  // no_air_during_show=true.
  const eligPromos = promos.filter((p) => {
    if (p.pool.length === 0) return false;
    if (p.plays_today >= p.max_plays_per_day) return false;
    if (p.no_air_during_show && p.show_id != null && p.show_id === currentShowId) return false;
    if (p.pool.every((m) => m.duration_seconds > remaining)) return false;
    return true;
  });
  eligPromos.sort((a, b) => {
    const aBelow = a.plays_today < a.min_plays_per_day;
    const bBelow = b.plays_today < b.min_plays_per_day;
    if (aBelow !== bBelow) return aBelow ? -1 : 1;
    // Within the same tier, fewer plays today wins (least-recently-aired by count).
    if (a.plays_today !== b.plays_today) return a.plays_today - b.plays_today;
    return a.id - b.id;
  });

  for (const p of eligPromos) {
    const pick = pickFittingPromo(p, snap, remaining, composeSeed(baseSeed, 0xb01a, p.id));
    if (pick) {
      return {
        media: pick,
        reason: `[stop_set pos=${nextPosition}] promo='${p.name}' (${p.plays_today}/${p.min_plays_per_day} min today)`,
        music_campaign_id: null,
        campaign_id: null,
        promo_id: p.id,
        stop_set_position: nextPosition,
      };
    }
  }

  return null;
}

/**
 * Pick the least-recently-played spot from the campaign's pool that still
 * fits in `remaining` seconds. Uses the LRP rotation algorithm over the
 * snapshot's recentHistory.
 */
function pickFittingSpot(
  c: CampaignSnapshot,
  snap: MusicPickSnapshot,
  remaining: number,
  seed: number,
): PoolMedia | null {
  const fitting = c.spot_pool.filter((m) => m.duration_seconds <= remaining);
  if (fitting.length === 0) return null;
  const ctx: RotationContext = {
    pool: fitting,
    history: snap.recentHistory,
    rotation: { id: null, type: 'least_recently_played', params: {} },
    seed,
    now: new Date(), // unused by LRP but required by signature
  };
  const pick = runRotation(ctx);
  return pick?.media ?? null;
}

/** Same as pickFittingSpot but for a promo's media pool. */
function pickFittingPromo(
  p: PromoSnapshot,
  snap: MusicPickSnapshot,
  remaining: number,
  seed: number,
): PoolMedia | null {
  const fitting = p.pool.filter((m) => m.duration_seconds <= remaining);
  if (fitting.length === 0) return null;
  const ctx: RotationContext = {
    pool: fitting,
    history: snap.recentHistory,
    rotation: { id: null, type: 'least_recently_played', params: {} },
    seed,
    now: new Date(),
  };
  const pick = runRotation(ctx);
  return pick?.media ?? null;
}
