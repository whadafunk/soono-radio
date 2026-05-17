import { eq, gte } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { media, playHistory } from '../../db/schema.js';
import { resolveCurrentSegment, type ResolvedSegment } from './clockResolver.js';
import { loadMusicPickSnapshot } from './snapshot.js';
import { predictSegmentPick } from './predictor.js';
import { pickNextStopSetSlot } from './stopSetPicker.js';
import { getSupervisorConfig } from './config.js';

/**
 * Minimal shape the scheduler needs to push a pick — wide enough that both
 * the clock-aware predictor (PoolMedia) and the random-fallback (Media) can
 * satisfy it without conversion.
 */
export interface PickedMedia {
  id: number;
  sha256: string;
  title: string | null;
  original_filename: string;
  duration_seconds: number;
}

export interface PickResult {
  media: PickedMedia;
  reason: string;
  clock_segment_id: number | null;
  /** Set when the pick was attributed to a music campaign by heavy_rotation. */
  music_campaign_id: number | null;
  /** Set when the pick is a stop-set spot from a campaign. */
  campaign_id: number | null;
  /** Set when the pick is a stop-set fill from a promo. */
  promo_id: number | null;
  /** 1-based slot position within a stop_set; null otherwise. */
  stop_set_position: number | null;
}

/**
 * Top-level picker. Resolves the current clock segment and dispatches by type.
 *
 *  - music / news / bulletin / voice_track → clock-aware predictor over the
 *    segment's configured sources (weighted draw, rotation algorithms,
 *    interstitial jingles).
 *  - stop_set → Phase B leaves the existing random-with-separation in place.
 *    Phase C will replace it with the campaign/promo break picker.
 *  - live / live_audience → null (harbor input; the supervisor doesn't push).
 *  - no resolved segment → random-with-separation safety net so the station
 *    never goes silent during a misconfiguration.
 */
export async function pickNext(now: Date = new Date()): Promise<PickResult | null> {
  const scheduled = await resolveCurrentSegment(now);

  if (!scheduled) {
    return pickRandomWithSeparation(now, 'no scheduled segment');
  }

  switch (scheduled.segment.type) {
    case 'music':
    case 'news':
    case 'bulletin':
    case 'voice_track':
      return pickFromSegment(scheduled, now);

    case 'live':
    case 'live_audience':
      // Harbor input drives this segment; the auto-source stays quiet.
      return null;

    case 'stop_set':
      return pickStopSetSlot(scheduled, now);

    default:
      return pickRandomWithSeparation(now, `unknown segment type fallback`);
  }
}

async function pickStopSetSlot(
  scheduled: ResolvedSegment,
  now: Date,
): Promise<PickResult | null> {
  const snap = await loadMusicPickSnapshot(scheduled, now);
  const pick = pickNextStopSetSlot(snap, now);
  if (!pick) {
    // Nothing fits (gap at end of break, or no eligible spots/promos). The
    // scheduler will just not push; LS will idle/crossfade between breaks.
    // We deliberately don't fall back to random music inside a stop_set —
    // a music track during a paid break would be worse than silence.
    return null;
  }
  return {
    media: pick.media,
    reason: pick.reason,
    clock_segment_id: scheduled.segment.id,
    music_campaign_id: pick.music_campaign_id,
    campaign_id: pick.campaign_id,
    promo_id: pick.promo_id,
    stop_set_position: pick.stop_set_position,
  };
}

async function pickFromSegment(
  scheduled: ResolvedSegment,
  now: Date,
): Promise<PickResult | null> {
  const snap = await loadMusicPickSnapshot(scheduled, now);
  const pick = predictSegmentPick(snap, now);
  if (!pick) {
    // Configured sources resolved to empty pools. Don't strand the station —
    // fall back to random music with a reason that flags the gap.
    return pickRandomWithSeparation(
      now,
      `segment_id=${scheduled.segment.id} sources exhausted — random fallback`,
    );
  }
  return {
    media: pick.media,
    reason: `[${scheduled.segment.type} seg=${scheduled.segment.name}] ${pick.reason}`,
    clock_segment_id: scheduled.segment.id,
    music_campaign_id: pick.music_campaign_id,
    campaign_id: pick.campaign_id,
    promo_id: pick.promo_id,
    stop_set_position: pick.stop_set_position,
  };
}

/**
 * Random pick from category='music' with separation. Used as a safety net
 * when no segment resolves or its sources can't yield a pick. Returns null
 * only when the library is empty or every music track is inside the
 * separation window — caller decides whether to retry or log.
 */
async function pickRandomWithSeparation(
  now: Date,
  reasonPrefix: string,
): Promise<PickResult | null> {
  const separationMinutes = getSupervisorConfig().separation_minutes;
  const cutoff = new Date(now.getTime() - separationMinutes * 60_000);

  const candidates = await db.select().from(media).where(eq(media.category, 'music'));
  if (candidates.length === 0) return null;

  const recent = await db
    .select({ media_id: playHistory.media_id })
    .from(playHistory)
    .where(gte(playHistory.started_at, cutoff));
  const blocked = new Set(
    recent.map((r) => r.media_id).filter((id): id is number => id !== null),
  );

  const eligible = candidates.filter((c) => !blocked.has(c.id));
  if (eligible.length === 0) return null;

  const choice = eligible[Math.floor(Math.random() * eligible.length)];
  return {
    media: choice,
    reason: `${reasonPrefix} (random sep=${separationMinutes}min eligible=${eligible.length}/${candidates.length})`,
    clock_segment_id: null,
    music_campaign_id: null,
    campaign_id: null,
    promo_id: null,
    stop_set_position: null,
  };
}
