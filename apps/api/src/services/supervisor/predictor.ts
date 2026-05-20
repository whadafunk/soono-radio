import type { MusicPickSnapshot, PoolMedia, ResolvedSource, SnapshotRotation } from './snapshot.js';
import { runRotation } from './rotations/index.js';
import { composeSeed, mulberry32, weightedPick } from './rotations/rng.js';
import type { RotationContext } from './rotations/types.js';
import { pickMostBehind } from './musicCampaignTracker.js';

export interface SegmentPick {
  media: PoolMedia;
  reason: string;
  /** Set when the pick came from a music campaign's contracted playlist. */
  music_campaign_id: number | null;
  /** Set when the pick is a spot from a stop_set campaign. */
  campaign_id: number | null;
  /** Set when the pick is a promo (fills remaining stop_set time). */
  promo_id: number | null;
  /** 1-based slot position within a stop_set; null for non-stop-set picks. */
  stop_set_position: number | null;
}

/** Tolerance for "this pick fits" — picks within this many seconds of the boundary are allowed. */
const FIT_TOLERANCE_SECONDS = 5;

/**
 * Pure decision function. Given a snapshot of state and the current time,
 * returns what should be queued next or null when nothing fits. No DB calls,
 * no telnet, no Date.now() — the caller threads `now` and `snapshot.recentHistory`.
 *
 * Algorithm sketch for music segments:
 *  1. If an interstitial jingle / station ID is due (counter ≥ N), play one.
 *  2. If any rotation has hot_play configured and its streak is met, slip a
 *     hot pick in (deterministic tiebreak: lowest source.index wins).
 *  3. Otherwise pick a source via weighted random draw across segment.sources.
 *  4. Run that source's rotation algorithm; walk the tier-fallback chain on miss.
 *  5. If still nothing, try the remaining sources in declared order.
 *  6. Look-ahead: if the candidate pick would overrun a fixed-end segment
 *     (can_skip = false), reject it and try the filler pool. Better silence
 *     than an audible boundary overrun on a paid spot or news segment.
 *
 * For non-music segments with configured sources (news / bulletin / voice_track)
 * the same machinery runs; interstitial flags default to false so step 1 is a
 * no-op. live / live_audience / stop_set segments must not reach this function —
 * the picker dispatcher routes them elsewhere.
 */
export function predictSegmentPick(
  snap: MusicPickSnapshot,
  now: Date,
): SegmentPick | null {
  const candidate = pickCandidate(snap, now);
  return applyLookAhead(candidate, snap, now);
}

function pickCandidate(snap: MusicPickSnapshot, now: Date): SegmentPick | null {
  const seg = snap.scheduled.segment;
  const baseSeed = composeSeed(Math.floor(now.getTime() / 60_000), seg.id);

  // 1. Interstitial jingle / station ID. When both are due, jingle wins —
  //    an arbitrary but deterministic tiebreak; operators set the cadence
  //    via jingle_every_n_tracks / station_id_every_n_tracks to avoid clash.
  const interstitial = pickInterstitial(snap, now, baseSeed);
  if (interstitial) return interstitial;

  // 2. Heavy rotation. If at least one source has a heavy_rotation-enabled
  //    rotation and at least one active music campaign is behind its daily
  //    target, play a track from the most-behind campaign before drawing
  //    normally. Hard contractual targets take precedence over hot_play
  //    preferences and over the weighted draw.
  const heavy = pickHeavyRotation(snap, now, baseSeed);
  if (heavy) return heavy;

  // 3. Hot-play injection. Each music-kind rotation can carry its own
  //    hot_play_playlist + cadence; we slip in a hot pick when the streak of
  //    main-pool picks (within the current clock instance) reaches the cadence.
  const hot = pickHotPlay(snap, now, baseSeed);
  if (hot) return hot;

  // 4. Weighted source draw across non-empty sources.
  const live = snap.sources.filter(hasAnyWalkablePool);
  if (live.length === 0) return null;

  const rand = mulberry32(baseSeed);
  const chosen = weightedPick(
    live.map((s) => ({ value: s, weight: s.weight })),
    rand,
  );
  if (!chosen) return null;

  // 5. Run the chosen source's rotation, walking the fallback chain on miss.
  const primary = pickFromSourceChain(chosen, snap, now, composeSeed(baseSeed, chosen.index));
  if (primary) return primary;

  // 6. Other sources, in declared order, with their own per-source seed.
  for (const other of live) {
    if (other === chosen) continue;
    const pick = pickFromSourceChain(other, snap, now, composeSeed(baseSeed, other.index));
    if (pick) return pick;
  }
  return null;
}

/**
 * Boundary protection for fixed-end segments. When the candidate pick would
 * overrun a `can_skip = false` segment, swap to the filler pool. If even
 * filler doesn't fit, return null — silence at end-of-news/end-of-spot-break
 * is safer than blowing past the boundary into the next hard-start segment.
 *
 * For flexible-end segments (can_skip = true), let the candidate through —
 * the next segment's start_policy governs whether the overrun gets cut.
 */
function applyLookAhead(
  candidate: SegmentPick | null,
  snap: MusicPickSnapshot,
  now: Date,
): SegmentPick | null {
  if (!candidate) return null;
  const seg = snap.scheduled.segment;
  if (seg.can_skip) return candidate;

  const remaining = snap.scheduled.segment_remaining_seconds;
  if (candidate.media.duration_seconds <= remaining + FIT_TOLERANCE_SECONDS) {
    return candidate;
  }

  // Nothing fits. Returning null lets the scheduler leave a gap rather than
  // crash through the segment boundary.
  return null;
}

// ─── Heavy rotation selection ─────────────────────────────────────────────────

function pickHeavyRotation(
  snap: MusicPickSnapshot,
  now: Date,
  baseSeed: number,
): SegmentPick | null {
  if (snap.music_campaigns.length === 0) return null;
  // Need at least one source whose rotation opts in. If a segment has no
  // heavy_rotation source, the snapshot loader wouldn't have loaded
  // campaigns — but check defensively in case future callers populate the
  // snapshot differently (e.g. simulator).
  const anyEnabled = snap.sources.some((s) => s.heavy_rotation_enabled);
  if (!anyEnabled) return null;

  const campaign = pickMostBehind(snap.music_campaigns);
  if (!campaign) return null; // every campaign at or above target → fall through

  const ctx: RotationContext = {
    pool: campaign.pool,
    history: snap.recentHistory,
    // LRP keeps contracted songs cycling rather than airing one to exhaustion;
    // matches typical music-promotion expectations.
    rotation: DEFAULT_HEAVY_ROTATION,
    seed: composeSeed(baseSeed, 0xc4afe16e, campaign.id),
    now,
  };
  const pick = runRotation(ctx);
  if (!pick) return null;
  return {
    media: pick.media,
    reason: `heavy_rotation campaign='${campaign.name}' (${campaign.plays_today}/${campaign.plays_per_day} today, behind): ${pick.reason}`,
    music_campaign_id: campaign.id,
    campaign_id: null,
    promo_id: null,
    stop_set_position: null,
  };
}

const DEFAULT_HEAVY_ROTATION: SnapshotRotation = {
  id: null,
  type: 'least_recently_played',
  params: {},
};

// ─── Hot-play selection ───────────────────────────────────────────────────────

function pickHotPlay(
  snap: MusicPickSnapshot,
  now: Date,
  baseSeed: number,
): SegmentPick | null {
  // Sources with hot_play config, sorted by declaration order (lowest index
  // wins when multiple are due simultaneously).
  const candidates = snap.sources
    .filter(
      (s) =>
        s.hot_play_pool != null &&
        s.hot_play_pool.length > 0 &&
        s.hot_play_every_n_tracks != null,
    )
    .sort((a, b) => a.index - b.index);

  for (const src of candidates) {
    const cadence = src.hot_play_every_n_tracks!;
    const streak = countMainStreak(src, snap);
    if (streak < cadence) continue;
    const ctx: RotationContext = {
      pool: src.hot_play_pool!,
      history: snap.recentHistory,
      rotation: DEFAULT_HOT_PLAY_ROTATION,
      seed: composeSeed(baseSeed, 0x40790ec, src.index),
      now,
    };
    const pick = runRotation(ctx);
    if (pick) {
      return {
        media: pick.media,
        reason: `${src.description} → hot_play every ${cadence} (streak ${streak}): ${pick.reason}`,
        music_campaign_id: null,
        campaign_id: null,
        promo_id: null,
        stop_set_position: null,
      };
    }
  }
  return null;
}

/**
 * Count consecutive picks attributable to this source's main rotation chain
 * (primary pool + fallback chain) since the most recent hot-play pick. The
 * walk stops at the start of the current clock instance — we don't carry
 * streaks across clock boundaries.
 *
 * Picks unrelated to this source (e.g. from a different source's pool, or
 * interstitial jingles) are skipped — they neither advance nor reset the
 * streak.
 */
function countMainStreak(src: ResolvedSource, snap: MusicPickSnapshot): number {
  const boundary = snap.scheduled.clock_instance_started_at.getTime();
  const mainIds = collectChainPoolIds(src);
  const hotIds = new Set((src.hot_play_pool ?? []).map((m) => m.id));
  let streak = 0;
  for (const row of snap.recentHistory) {
    if (row.started_at.getTime() < boundary) break;
    if (row.media_id == null) continue;
    if (hotIds.has(row.media_id)) break; // hot-play pick — streak ends
    if (mainIds.has(row.media_id)) streak++;
    // else: not in either pool — neutral, keep walking
  }
  return streak;
}

function collectChainPoolIds(src: ResolvedSource): Set<number> {
  const ids = new Set<number>();
  let cur: ResolvedSource | null = src;
  while (cur) {
    for (const m of cur.pool) ids.add(m.id);
    cur = cur.fallback;
  }
  return ids;
}

// Hot-play pool is a specific operator-curated playlist; cycle through it in
// the order it was set up (manual sort_order) so the same hot tracks don't
// keep firing repeatedly while others wait their turn.
const DEFAULT_HOT_PLAY_ROTATION: SnapshotRotation = {
  id: null,
  type: 'round_robin',
  params: { order_by: 'manual' },
};

// ─── Interstitial selection ───────────────────────────────────────────────────

function pickInterstitial(
  snap: MusicPickSnapshot,
  now: Date,
  baseSeed: number,
): SegmentPick | null {
  const seg = snap.scheduled.segment;

  // Jingle takes priority over station ID when both are due. Each gates on
  // (feature enabled) + (cadence set) + (pool available) + (streak met).
  if (
    seg.interstitial_jingles_enabled &&
    seg.jingle_every_n_tracks &&
    snap.interstitial_jingle_pool &&
    snap.interstitial_jingle_pool.length > 0 &&
    snap.music_tracks_since_last_jingle >= seg.jingle_every_n_tracks
  ) {
    const pick = pickFromAdhocPool(
      snap.interstitial_jingle_pool,
      snap,
      now,
      composeSeed(baseSeed, 0xa110ca7e),
    );
    if (pick) {
      return {
        media: pick.media,
        reason: `interstitial jingle (every ${seg.jingle_every_n_tracks} tracks): ${pick.reason}`,
        music_campaign_id: null,
        campaign_id: null,
        promo_id: null,
        stop_set_position: null,
      };
    }
  }

  if (
    seg.interstitial_station_id_enabled &&
    seg.station_id_every_n_tracks &&
    snap.interstitial_station_id_pool &&
    snap.interstitial_station_id_pool.length > 0 &&
    snap.music_tracks_since_last_station_id >= seg.station_id_every_n_tracks
  ) {
    const pick = pickFromAdhocPool(
      snap.interstitial_station_id_pool,
      snap,
      now,
      composeSeed(baseSeed, 0xd1ad11d5),
    );
    if (pick) {
      return {
        media: pick.media,
        reason: `interstitial station_id (every ${seg.station_id_every_n_tracks} tracks): ${pick.reason}`,
        music_campaign_id: null,
        campaign_id: null,
        promo_id: null,
        stop_set_position: null,
      };
    }
  }

  return null;
}

// ─── Source walking ───────────────────────────────────────────────────────────

function hasAnyWalkablePool(s: ResolvedSource): boolean {
  let cur: ResolvedSource | null = s;
  while (cur) {
    if (cur.pool.length > 0) return true;
    cur = cur.fallback;
  }
  return false;
}

function pickFromSourceChain(
  source: ResolvedSource,
  snap: MusicPickSnapshot,
  now: Date,
  seed: number,
): SegmentPick | null {
  let cur: ResolvedSource | null = source;
  while (cur) {
    if (cur.pool.length > 0) {
      const ctx: RotationContext = {
        pool: cur.pool,
        history: snap.recentHistory,
        rotation: cur.rotation,
        seed,
        now,
      };
      const pick = runRotation(ctx);
      if (pick) {
        const prefix = cur === source ? cur.description : `${source.description} → ${cur.description}`;
        return {
          media: pick.media,
          reason: `${prefix}: ${pick.reason}`,
          music_campaign_id: null,
          campaign_id: null,
          promo_id: null,
          stop_set_position: null,
        };
      }
    }
    cur = cur.fallback;
  }
  return null;
}

// Interstitial pools have no rotation document attached — use round_robin
// (deterministic cycling through the playlist) so jingles don't repeat.
const DEFAULT_INTERSTITIAL_ROTATION: SnapshotRotation = {
  id: null,
  type: 'round_robin',
  params: { order_by: 'manual' },
};

function pickFromAdhocPool(
  pool: PoolMedia[],
  snap: MusicPickSnapshot,
  now: Date,
  seed: number,
): SegmentPick | null {
  const ctx: RotationContext = {
    pool,
    history: snap.recentHistory,
    rotation: DEFAULT_INTERSTITIAL_ROTATION,
    seed,
    now,
  };
  const pick = runRotation(ctx);
  return pick
    ? {
        media: pick.media,
        reason: pick.reason,
        music_campaign_id: null,
        campaign_id: null,
        promo_id: null,
        stop_set_position: null,
      }
    : null;
}
