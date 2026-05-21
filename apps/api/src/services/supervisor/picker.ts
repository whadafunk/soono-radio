import { and, eq, gte } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { media, playHistory, playlistMedia, rundownAssignments, rundownShowContent, rundownPlaybackCursors } from '../../db/schema.js';
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
      return pickFromSegment(scheduled, now);

    case 'news':
    case 'bulletin':
    case 'voice_track':
      return pickFromRundownSegment(scheduled, now);

    case 'live':
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

function pad2(n: number): string { return n < 10 ? `0${n}` : `${n}`; }

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * For news/bulletin: shared show-content playlist with cursor (sequential, shared across all
 * segments of the same type in the clock instance) → fallback_playlist → segment sources.
 * For voice_track: per-segment rundown assignment → fallback_playlist → segment sources.
 *
 * SUPERVISOR V2 NOTE — tiling:
 * A clock shorter than its scheduled slot repeats ("tiles") — each tile is a separate clock
 * instance with a different time_start. The rundown_show_content row is assigned once per
 * calendar slot (the slot's time_start, not each tile's time_start). The new supervisor must
 * resolve the originating calendar-slot time_start for a tiled instance and use that to look up
 * rundown_show_content. The cursor (rundown_playback_cursors) should also be keyed to the slot,
 * not the tile, so the playlist advances continuously across all tiles of the same type.
 */
async function pickFromRundownSegment(
  scheduled: ResolvedSegment,
  now: Date,
): Promise<PickResult | null> {
  const date = fmtDate(scheduled.clock_instance_started_at);
  const timeStart = fmtTime(scheduled.clock_instance_started_at);
  const segType = scheduled.segment.type;

  // News/bulletin: use shared show-content playlist with cursor
  if (segType === 'news' || segType === 'bulletin') {
    const [showContent] = await db
      .select({ playlist_id: rundownShowContent.playlist_id })
      .from(rundownShowContent)
      .where(and(
        eq(rundownShowContent.date, date),
        eq(rundownShowContent.time_start, timeStart),
        eq(rundownShowContent.clock_id, scheduled.clock.id),
        eq(rundownShowContent.segment_type, segType),
      ))
      .limit(1);

    if (showContent?.playlist_id) {
      const tracks = await db
        .select({ media_id: playlistMedia.media_id })
        .from(playlistMedia)
        .where(eq(playlistMedia.playlist_id, showContent.playlist_id))
        .orderBy(playlistMedia.sort_order);

      if (tracks.length > 0) {
        // Load or init cursor
        const [cursor] = await db
          .select({ next_track_index: rundownPlaybackCursors.next_track_index })
          .from(rundownPlaybackCursors)
          .where(and(
            eq(rundownPlaybackCursors.date, date),
            eq(rundownPlaybackCursors.time_start, timeStart),
            eq(rundownPlaybackCursors.clock_id, scheduled.clock.id),
            eq(rundownPlaybackCursors.segment_type, segType),
          ))
          .limit(1);

        const idx = cursor?.next_track_index ?? 0;

        if (idx < tracks.length) {
          const trackMediaId = tracks[idx].media_id;
          if (trackMediaId) {
            const [m] = await db.select().from(media).where(eq(media.id, trackMediaId)).limit(1);
            if (m) {
              // Advance cursor
              await db
                .insert(rundownPlaybackCursors)
                .values({
                  date, time_start: timeStart, clock_id: scheduled.clock.id,
                  segment_type: segType, next_track_index: idx + 1,
                  updated_at: new Date(),
                })
                .onConflictDoUpdate({
                  target: [
                    rundownPlaybackCursors.date, rundownPlaybackCursors.time_start,
                    rundownPlaybackCursors.clock_id, rundownPlaybackCursors.segment_type,
                  ],
                  set: { next_track_index: idx + 1, updated_at: new Date() },
                });

              return {
                media: m,
                reason: `[rundown ${segType} seg=${scheduled.segment.name}] show_content track=${idx + 1}/${tracks.length}`,
                clock_segment_id: scheduled.segment.id,
                music_campaign_id: null,
                campaign_id: null,
                promo_id: null,
                stop_set_position: null,
              };
            }
          }
        }
        // Playlist exhausted — fall through to fallback chain
      }
    }
  }

  // Voice_track (and exhausted show-content fallback): per-segment rundown assignment
  if (segType === 'voice_track') {
    const [assignment] = await db
      .select({ media_id: rundownAssignments.media_id })
      .from(rundownAssignments)
      .where(and(
        eq(rundownAssignments.date, date),
        eq(rundownAssignments.time_start, timeStart),
        eq(rundownAssignments.clock_id, scheduled.clock.id),
        eq(rundownAssignments.segment_index, scheduled.segment_index),
      ))
      .limit(1);

    if (assignment?.media_id) {
      const [m] = await db.select().from(media).where(eq(media.id, assignment.media_id)).limit(1);
      if (m) {
        return {
          media: m,
          reason: `[rundown voice_track seg=${scheduled.segment.name}] assigned`,
          clock_segment_id: scheduled.segment.id,
          music_campaign_id: null,
          campaign_id: null,
          promo_id: null,
          stop_set_position: null,
        };
      }
    }
  }

  // Fallback playlist on the segment template.
  const fallbackId = scheduled.segment.fallback_playlist_id;
  if (fallbackId) {
    const items = await db
      .select({ media_id: playlistMedia.media_id })
      .from(playlistMedia)
      .where(eq(playlistMedia.playlist_id, fallbackId));
    if (items.length > 0) {
      const chosen = items[Math.floor(Math.random() * items.length)];
      const [m] = await db.select().from(media).where(eq(media.id, chosen.media_id)).limit(1);
      if (m) {
        return {
          media: m,
          reason: `[rundown ${segType} seg=${scheduled.segment.name}] fallback_playlist=${fallbackId}`,
          clock_segment_id: scheduled.segment.id,
          music_campaign_id: null,
          campaign_id: null,
          promo_id: null,
          stop_set_position: null,
        };
      }
    }
  }

  // Final fallback: segment's own source config.
  return pickFromSegment(scheduled, now);
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
