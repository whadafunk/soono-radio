import { resolveCurrentSegment } from './clockResolver.js';
import { loadMusicPickSnapshot, type MusicPickSnapshot, type SnapshotPlayRecord } from './snapshot.js';
import { predictSegmentPick } from './predictor.js';

export interface SimulatedPlay {
  /** Wall-clock time the pick would begin airing. */
  at: Date;
  /** Picked media (subset of fields useful to operators). */
  media: {
    id: number;
    title: string | null;
    artist: string | null;
    original_filename: string;
    duration_seconds: number;
    category: string;
  } | null; // null for `live` / `live_audience` placeholder rows
  /** Human-readable explanation — same shape as picker reasons. */
  reason: string;
  /** Clock + segment context for grouping in the UI. */
  clock_name: string;
  segment_name: string;
  segment_type: string;
  /** Source attribution, mirrored from PickResult. */
  campaign_id: number | null;
  music_campaign_id: number | null;
  promo_id: number | null;
  stop_set_position: number | null;
}

/** Caps to keep simulation runs bounded. */
const MAX_PLAYS = 2000;
const MAX_SPAN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_ADVANCE_MS = 60_000; // 1 minute — used when no pick fits and we have to skip

/**
 * Walks the predictor forward from `from` to `to`, threading synthetic
 * play_history so each pick reflects rotations as if real plays had aired.
 * Pure-ish: does DB reads inside loadMusicPickSnapshot but never writes.
 *
 * Output rows mirror what the live picker would push if reality matched the
 * schedule exactly (no operator intervention, no live takeovers, every track
 * plays its nominal duration).
 */
export async function simulate(from: Date, to: Date): Promise<SimulatedPlay[]> {
  if (to.getTime() <= from.getTime()) return [];
  const cap = new Date(Math.min(to.getTime(), from.getTime() + MAX_SPAN_MS));
  const out: SimulatedPlay[] = [];
  const syntheticHistory: SnapshotPlayRecord[] = [];
  let cursor = new Date(from);

  while (cursor < cap && out.length < MAX_PLAYS) {
    const scheduled = await resolveCurrentSegment(cursor);
    if (!scheduled) {
      // No schedule covers this minute. Advance by one minute and try again
      // — eventually either the next slot kicks in or we hit `cap`.
      cursor = new Date(cursor.getTime() + MIN_ADVANCE_MS);
      continue;
    }

    const segType = scheduled.segment.type;

    // ── Live / live_audience / stop_set: emit one placeholder per segment ──
    // Phase E v1 doesn't simulate the internals of these — for live it's a
    // harbor input we can't predict; for stop_set the campaign-attribution
    // and advertiser-separation logic depends on synthetic history with full
    // fidelity that isn't worth the complexity for a preview tool. We mark
    // the segment as a block and advance to its end.
    if (segType === 'live' || segType === 'live_audience' || segType === 'stop_set') {
      const segEnd = new Date(
        scheduled.segment_started_at.getTime() +
          scheduled.segment.duration_seconds * 1000,
      );
      const remaining = Math.max(0, segEnd.getTime() - cursor.getTime());
      const placeholderReason =
        segType === 'stop_set'
          ? `[stop_set seg=${scheduled.segment.name}] ${scheduled.segment.duration_seconds}s commercial break — spot-by-spot simulation not yet implemented`
          : `[${segType} seg=${scheduled.segment.name}] live broadcast — harbor input`;
      out.push({
        at: new Date(cursor),
        media: null,
        reason: placeholderReason,
        clock_name: scheduled.clock.name,
        segment_name: scheduled.segment.name,
        segment_type: segType,
        campaign_id: null,
        music_campaign_id: null,
        promo_id: null,
        stop_set_position: null,
      });
      cursor = new Date(cursor.getTime() + Math.max(MIN_ADVANCE_MS, remaining));
      continue;
    }

    // Snapshot for this moment. Override its recentHistory with the synthetic
    // accumulator merged on top, so rotations honor the simulated past.
    const snap = await loadMusicPickSnapshot(scheduled, cursor);
    const mergedHistory = mergeHistory(snap.recentHistory, syntheticHistory);
    const overlaidSnap: MusicPickSnapshot = {
      ...snap,
      recentHistory: mergedHistory,
    };

    const pick = predictSegmentPick(overlaidSnap, cursor);

    if (!pick) {
      // Nothing fits at this moment. Advance one minute and retry — usually
      // resolves at the next segment boundary.
      cursor = new Date(cursor.getTime() + MIN_ADVANCE_MS);
      continue;
    }

    const startedAt = new Date(cursor);
    out.push({
      at: startedAt,
      media: {
        id: pick.media.id,
        title: pick.media.title,
        artist: pick.media.artist,
        original_filename: pick.media.original_filename,
        duration_seconds: pick.media.duration_seconds,
        category: pick.media.category,
      },
      reason: `[${segType} seg=${scheduled.segment.name}] ${pick.reason}`,
      clock_name: scheduled.clock.name,
      segment_name: scheduled.segment.name,
      segment_type: segType,
      campaign_id: pick.campaign_id,
      music_campaign_id: pick.music_campaign_id,
      promo_id: pick.promo_id,
      stop_set_position: pick.stop_set_position,
    });

    // Add a synthetic play_history entry so rotations / counters honor this
    // pick on subsequent iterations.
    syntheticHistory.unshift({
      id: -out.length, // negative ids so they don't collide with real rows
      media_id: pick.media.id,
      started_at: startedAt,
      category: pick.media.category as SnapshotPlayRecord['category'],
      artist: pick.media.artist,
      clock_segment_id: scheduled.segment.id,
      music_campaign_id: pick.music_campaign_id,
    });

    cursor = new Date(cursor.getTime() + pick.media.duration_seconds * 1000);
  }

  return out;
}

/**
 * Merge real history with synthetic forward-walked picks, newest first.
 * Synthetic entries get inserted in time order so rotations that walk history
 * back-to-front see them at the right position.
 */
function mergeHistory(
  real: ReadonlyArray<SnapshotPlayRecord>,
  synthetic: ReadonlyArray<SnapshotPlayRecord>,
): SnapshotPlayRecord[] {
  if (synthetic.length === 0) return [...real];
  const merged = [...synthetic, ...real];
  merged.sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
  return merged;
}
