import { and, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  campaigns as campaignsTable,
  campaignMedia,
  media as mediaTable,
  musicCampaigns as musicCampaignsTable,
  playHistory,
  playlistMedia,
  playlists as playlistsTable,
  promos as promosTable,
  promoMedia,
  rotations as rotationsTable,
  showPlaylists,
} from '../../db/schema.js';
import type { Media, MusicCampaign, Rotation, RotationType } from '../../db/schema.js';
import type { SegmentSourceEntry } from '@radio/shared';
import type { ResolvedSegment } from './clockResolver.js';
import {
  countPlaysToday,
  isActiveOn,
  localDateString,
  startOfLocalDay,
  type MusicCampaignSnapshot,
} from './musicCampaignTracker.js';
import {
  hadPosition1Since,
  startOfLocalMonth,
  startOfLocalWeek,
  type CampaignSnapshot,
} from './campaignTracker.js';

// ─── Public types (snapshot is also consumed by the dry-run simulator later) ──

export interface MusicPickSnapshot {
  scheduled: ResolvedSegment;
  /** Resolved candidate pools per source entry on the segment, in source order. */
  sources: ResolvedSource[];
  /** Recent music plays (joined with media for category/artist). Ordered newest first. */
  recentHistory: SnapshotPlayRecord[];
  /** Music-track streak counters since the most recent interstitial play. */
  music_tracks_since_last_jingle: number;
  music_tracks_since_last_station_id: number;
  /** Pool to draw from when an interstitial jingle is due. Null when no playlist is configured. */
  interstitial_jingle_pool: PoolMedia[] | null;
  /** Pool to draw from when an interstitial station ID is due. Null when no playlist is configured. */
  interstitial_station_id_pool: PoolMedia[] | null;
  /**
   * Active music campaigns intersecting `now`. Only loaded when at least one
   * source has a heavy_rotation-enabled rotation; otherwise empty. Each entry
   * carries the campaign's playlist pool and plays-today count so the
   * predictor doesn't have to hit the DB.
   */
  music_campaigns: MusicCampaignSnapshot[];

  /**
   * Stop-set-specific snapshot. Populated only when the segment's type is
   * 'stop_set'; null otherwise. The picker uses it to walk through the break's
   * positions one slot per tick.
   */
  stop_set: StopSetSnapshot | null;
}

export interface StopSetSnapshot {
  /** Active spot campaigns intersecting `now`, with pacing aggregates. */
  campaigns: CampaignSnapshot[];
  /** Active promos intersecting `now`, with their media pool + today's count. */
  promos: PromoSnapshot[];
  /**
   * Play_history rows that landed in THIS stop-set segment instance (filtered
   * by clock_segment_id since segment_started_at). Used to count consumed
   * time and derive the next stop_set_position.
   */
  already_played: SnapshotStopSetPlay[];
}

export interface PromoSnapshot {
  id: number;
  name: string;
  show_id: number | null;
  no_air_during_show: boolean;
  min_plays_per_day: number;
  max_plays_per_day: number;
  pool: PoolMedia[];
  plays_today: number;
}

export interface SnapshotStopSetPlay {
  media_id: number | null;
  campaign_id: number | null;
  promo_id: number | null;
  stop_set_position: number | null;
  duration_seconds: number;
}

export interface ResolvedSource {
  /** Original source-entry index in segment.sources — used by the weighted draw and the seed. */
  index: number;
  type: SegmentSourceEntry['type'];
  weight: number;
  /** Human-readable description for pick_reason. */
  description: string;
  /** Media available to pick from this source. Empty = exhausted/unavailable. */
  pool: PoolMedia[];
  /** Rotation algorithm to run over the pool. */
  rotation: SnapshotRotation;
  /**
   * Hot-play pool — when populated alongside `hot_play_every_n_tracks`, the
   * predictor slips one pick from this pool into the rotation every N main
   * picks. Null = feature disabled for this rotation.
   */
  hot_play_pool: PoolMedia[] | null;
  hot_play_every_n_tracks: number | null;
  /**
   * When true, the predictor consults `snapshot.music_campaigns` before
   * drawing from this source's normal pool and prefers the most-behind-pacing
   * campaign's tracks.
   */
  heavy_rotation_enabled: boolean;
  /** Tier fallback (show_playlist only). Walked if the primary pool yields nothing. */
  fallback: ResolvedSource | null;
}

export interface PoolMedia {
  id: number;
  sha256: string;
  category: Media['category'];
  title: string | null;
  artist: string | null;
  original_filename: string;
  duration_seconds: number;
  /** From playlist_media.weight when the pool came from a playlist; 1 otherwise. */
  weight: number;
  /** From playlist_media.sort_order; falls back to 0 for non-playlist pools. */
  sort_order: number;
  /** media.created_at — used by round_robin order_by='added_date'. */
  added_at: Date;
}

export interface SnapshotRotation {
  /** Null when no rotation document is attached — picker falls back to round_robin defaults. */
  id: number | null;
  type: RotationType;
  params: Record<string, unknown>;
}

export interface SnapshotPlayRecord {
  id: number;
  media_id: number | null;
  started_at: Date;
  category: Media['category'] | null;
  artist: string | null;
  clock_segment_id: number | null;
  music_campaign_id: number | null;
}

// Default rotation behavior when a source has no rotation_id.
const DEFAULT_ROTATION: SnapshotRotation = {
  id: null,
  type: 'round_robin',
  params: { order_by: 'added_date' },
};

// How far back to scan play_history for separation / rotation context. Two hours
// safely covers separation_minutes up to 120 (the schema cap is 480 but real-world
// values are well under that) and gives LRP / round_robin enough history to land on
// a recent track.
const HISTORY_LOOKBACK_MS = 2 * 60 * 60 * 1000;

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loadMusicPickSnapshot(
  scheduled: ResolvedSegment,
  now: Date,
): Promise<MusicPickSnapshot> {
  const segment = scheduled.segment;
  const sourceEntries = parseSources(segment.sources);

  const historyCutoff = new Date(now.getTime() - HISTORY_LOOKBACK_MS);
  // Two parallel queries: rotation docs we'll need, and recent history.
  const rotationIds = collectRotationIds(sourceEntries);
  const [rotationRows, history] = await Promise.all([
    rotationIds.length > 0
      ? db.select().from(rotationsTable).where(inArray(rotationsTable.id, rotationIds))
      : Promise.resolve([] as Rotation[]),
    loadRecentHistory(historyCutoff),
  ]);
  const rotationById = new Map(rotationRows.map((r) => [r.id, r]));

  // Resolve every source entry to a pool + rotation.
  const resolved: ResolvedSource[] = [];
  for (let i = 0; i < sourceEntries.length; i++) {
    const r = await resolveSourceEntry(sourceEntries[i], i, scheduled, rotationById);
    if (r) resolved.push(r);
  }

  // Interstitial pools come from clock-level playlists. For an assigned clock
  // the show's jingle playlist supersedes the clock's; the station_id playlist
  // is always on the clock.
  const jinglePlaylistId =
    scheduled.show?.jingle_playlist_id ?? scheduled.clock.jingle_playlist_id ?? null;
  const stationIdPlaylistId = scheduled.clock.station_id_playlist_id ?? null;

  const [interstitial_jingle_pool, interstitial_station_id_pool] = await Promise.all([
    jinglePlaylistId ? loadPlaylistPool(jinglePlaylistId) : Promise.resolve(null),
    stationIdPlaylistId ? loadPlaylistPool(stationIdPlaylistId) : Promise.resolve(null),
  ]);

  const { sinceJingle, sinceStationId } = countMusicStreaks(history, scheduled);

  // Only load music_campaigns when at least one source opts into them via
  // heavy_rotation_enabled — saves a query in the common case.
  const heavyRotationActive = resolved.some((s) => s.heavy_rotation_enabled);
  const music_campaigns = heavyRotationActive
    ? await loadActiveMusicCampaigns(now, history)
    : [];

  // Stop-set context lives parallel to music_campaigns; loaded only for
  // segments of type='stop_set'.
  const stop_set =
    segment.type === 'stop_set' ? await loadStopSetSnapshot(scheduled, now) : null;

  return {
    scheduled,
    sources: resolved,
    recentHistory: history,
    music_tracks_since_last_jingle: sinceJingle,
    music_tracks_since_last_station_id: sinceStationId,
    interstitial_jingle_pool,
    interstitial_station_id_pool,
    music_campaigns,
    stop_set,
  };
}

/**
 * Load every currently-active music campaign, pre-resolve its playlist pool,
 * and tally plays-today from the history snapshot. Returned in order of id
 * so the predictor's tie-breaker is deterministic.
 */
async function loadActiveMusicCampaigns(
  now: Date,
  history: SnapshotPlayRecord[],
): Promise<MusicCampaignSnapshot[]> {
  const today = localDateString(now);
  const allCampaigns = await db.select().from(musicCampaignsTable);
  const active = allCampaigns.filter((c: MusicCampaign) => isActiveOn(c, today));
  if (active.length === 0) return [];

  const midnight = startOfLocalDay(now);
  const playlistIds = [...new Set(active.map((c) => c.playlist_id))];
  // Single batch query for all playlists, then de-multiplex per campaign.
  const allPoolRows =
    playlistIds.length > 0
      ? await loadPlaylistPoolsByIds(playlistIds)
      : new Map<number, PoolMedia[]>();

  return active
    .sort((a, b) => a.id - b.id)
    .map((c) => ({
      id: c.id,
      name: c.name,
      playlist_id: c.playlist_id,
      plays_per_day: c.plays_per_day,
      pool: allPoolRows.get(c.playlist_id) ?? [],
      plays_today: countPlaysToday(c.id, history, midnight),
    }));
}

// ─── Stop-set snapshot loader ────────────────────────────────────────────────

async function loadStopSetSnapshot(
  scheduled: ResolvedSegment,
  now: Date,
): Promise<StopSetSnapshot> {
  const today = localDateString(now);
  const midnight = startOfLocalDay(now);
  const monthStart = startOfLocalMonth(now);
  const weekStart = startOfLocalWeek(now);

  // ── 1. Load all candidate campaigns (date-active) ─────────────────────────
  // Date-range filter is the cheapest cut; finer eligibility happens later.
  // We don't filter by `active=true` here so the picker can still inspect
  // active=false campaigns if it ever wants to surface them in logs; the
  // baseline-eligibility check rejects them.
  const allCampaigns = await db
    .select()
    .from(campaignsTable)
    .where(and(eq(campaignsTable.active, true)));

  const liveCampaigns = allCampaigns.filter(
    (c) => c.starts_on <= today && c.ends_on >= today,
  );
  const campaignIds = liveCampaigns.map((c) => c.id);

  // Aggregate plays in the relevant windows in one sweep. We pull plays since
  // the start of the current month — that covers monthly pacing, weekly cap,
  // today's count, and the "had position 1 today" check. Bounded by month.
  const campaignPlays =
    campaignIds.length > 0
      ? await db
          .select({
            campaign_id: playHistory.campaign_id,
            started_at: playHistory.started_at,
            stop_set_position: playHistory.stop_set_position,
          })
          .from(playHistory)
          .where(
            and(
              isNotNull(playHistory.campaign_id),
              gte(playHistory.started_at, monthStart),
              inArray(playHistory.campaign_id, campaignIds),
            ),
          )
      : [];

  // Group plays per campaign and tally counts.
  const playsByCampaign = new Map<number, typeof campaignPlays>();
  for (const p of campaignPlays) {
    const id = p.campaign_id!;
    if (!playsByCampaign.has(id)) playsByCampaign.set(id, []);
    playsByCampaign.get(id)!.push(p);
  }

  // Load all spot media (play_as_spot=true) for live campaigns in one batch.
  const spotPools = await loadSpotPools(campaignIds);

  const campaigns: CampaignSnapshot[] = liveCampaigns.map((c) => {
    const rows = playsByCampaign.get(c.id) ?? [];
    let plays_today = 0;
    let plays_this_month = rows.length;
    let plays_this_week_in_interval = 0;
    for (const r of rows) {
      if (r.started_at.getTime() >= midnight.getTime()) plays_today++;
      if (
        c.interval_id != null &&
        r.started_at.getTime() >= weekStart.getTime()
      ) {
        // NOTE: this counts ALL plays this week for the campaign, not strictly
        // "plays within the interval's time windows". Tightening to slot-aware
        // counting is deferred until intervals are actually used at runtime.
        plays_this_week_in_interval++;
      }
    }
    const had_position1_today = hadPosition1Since(
      c.id,
      rows.map((r) => ({
        media_id: null,
        started_at: r.started_at,
        category: null,
        artist: null,
        clock_segment_id: null,
        music_campaign_id: null,
        campaign_id: c.id,
        stop_set_position: r.stop_set_position,
        id: 0,
      })),
      midnight,
    );

    return {
      id: c.id,
      customer_id: c.customer_id,
      name: c.name,
      starts_on: c.starts_on,
      ends_on: c.ends_on,
      plays_per_month: c.plays_per_month,
      max_plays_per_day: c.max_plays_per_day,
      time_window_start: c.time_window_start,
      time_window_end: c.time_window_end,
      days_of_week: c.days_of_week,
      advertiser_separation_spots: c.advertiser_separation_spots,
      competing_exclusions: (c.competing_exclusions as number[]) ?? [],
      priority: c.priority,
      interval_id: c.interval_id,
      interval_plays_per_week: c.interval_plays_per_week,
      show_id: c.show_id,
      first_in_slot: c.first_in_slot,
      first_in_slot_mode: c.first_in_slot_mode,
      active: c.active,
      spot_pool: spotPools.get(c.id) ?? [],
      plays_today,
      plays_this_month,
      plays_this_week_in_interval,
      had_position1_today,
    };
  });

  // ── 2. Load active promos with pools + today's counts ─────────────────────
  const livePromos = (
    await db.select().from(promosTable).where(eq(promosTable.active, true))
  ).filter((p) => p.starts_on <= today && p.ends_on >= today);
  const promoIds = livePromos.map((p) => p.id);
  const promoPools = await loadPromoPools(promoIds);
  const promoPlaysToday =
    promoIds.length > 0
      ? await db
          .select({
            promo_id: playHistory.promo_id,
            started_at: playHistory.started_at,
          })
          .from(playHistory)
          .where(
            and(
              isNotNull(playHistory.promo_id),
              gte(playHistory.started_at, midnight),
              inArray(playHistory.promo_id, promoIds),
            ),
          )
      : [];
  const promoCounts = new Map<number, number>();
  for (const r of promoPlaysToday) {
    promoCounts.set(r.promo_id!, (promoCounts.get(r.promo_id!) ?? 0) + 1);
  }

  const promos: PromoSnapshot[] = livePromos.map((p) => ({
    id: p.id,
    name: p.name,
    show_id: p.show_id,
    no_air_during_show: p.no_air_during_show,
    min_plays_per_day: p.min_plays_per_day,
    max_plays_per_day: p.max_plays_per_day,
    pool: promoPools.get(p.id) ?? [],
    plays_today: promoCounts.get(p.id) ?? 0,
  }));

  // ── 3. Plays already in THIS stop-set instance ────────────────────────────
  // The segment fires from segment_started_at; we want plays attributed to
  // this clock_segment_id since then. They drive remaining_seconds and the
  // next stop_set_position.
  const consumed = await db
    .select({
      media_id: playHistory.media_id,
      campaign_id: playHistory.campaign_id,
      promo_id: playHistory.promo_id,
      stop_set_position: playHistory.stop_set_position,
      duration_seconds: mediaTable.duration_seconds,
    })
    .from(playHistory)
    .leftJoin(mediaTable, eq(playHistory.media_id, mediaTable.id))
    .where(
      and(
        eq(playHistory.clock_segment_id, scheduled.segment.id),
        gte(playHistory.started_at, scheduled.segment_started_at),
      ),
    );
  const already_played: SnapshotStopSetPlay[] = consumed.map((r) => ({
    media_id: r.media_id,
    campaign_id: r.campaign_id,
    promo_id: r.promo_id,
    stop_set_position: r.stop_set_position,
    duration_seconds: r.duration_seconds ?? 0,
  }));

  return { campaigns, promos, already_played };
}

/**
 * Load the spot-media pool (play_as_spot=true) for each campaign id, returned
 * grouped. Joins with media to get full PoolMedia rows.
 */
async function loadSpotPools(
  campaignIds: number[],
): Promise<Map<number, PoolMedia[]>> {
  if (campaignIds.length === 0) return new Map();
  const rows = await db
    .select({
      campaign_id: campaignMedia.campaign_id,
      id: mediaTable.id,
      sha256: mediaTable.sha256,
      category: mediaTable.category,
      title: mediaTable.title,
      artist: mediaTable.artist,
      original_filename: mediaTable.original_filename,
      duration_seconds: mediaTable.duration_seconds,
      created_at: mediaTable.created_at,
    })
    .from(campaignMedia)
    .innerJoin(mediaTable, eq(campaignMedia.media_id, mediaTable.id))
    .where(
      and(
        eq(campaignMedia.play_as_spot, true),
        inArray(campaignMedia.campaign_id, campaignIds),
      ),
    );
  const out = new Map<number, PoolMedia[]>();
  for (const r of rows) {
    if (!out.has(r.campaign_id)) out.set(r.campaign_id, []);
    out.get(r.campaign_id)!.push({
      id: r.id,
      sha256: r.sha256,
      category: r.category,
      title: r.title,
      artist: r.artist,
      original_filename: r.original_filename,
      duration_seconds: r.duration_seconds,
      weight: 1,
      sort_order: 0,
      added_at: r.created_at,
    });
  }
  return out;
}

/** Like loadSpotPools, but for promos via promo_media. */
async function loadPromoPools(
  promoIds: number[],
): Promise<Map<number, PoolMedia[]>> {
  if (promoIds.length === 0) return new Map();
  const rows = await db
    .select({
      promo_id: promoMedia.promo_id,
      id: mediaTable.id,
      sha256: mediaTable.sha256,
      category: mediaTable.category,
      title: mediaTable.title,
      artist: mediaTable.artist,
      original_filename: mediaTable.original_filename,
      duration_seconds: mediaTable.duration_seconds,
      created_at: mediaTable.created_at,
    })
    .from(promoMedia)
    .innerJoin(mediaTable, eq(promoMedia.media_id, mediaTable.id))
    .where(inArray(promoMedia.promo_id, promoIds));
  const out = new Map<number, PoolMedia[]>();
  for (const r of rows) {
    if (!out.has(r.promo_id)) out.set(r.promo_id, []);
    out.get(r.promo_id)!.push({
      id: r.id,
      sha256: r.sha256,
      category: r.category,
      title: r.title,
      artist: r.artist,
      original_filename: r.original_filename,
      duration_seconds: r.duration_seconds,
      weight: 1,
      sort_order: 0,
      added_at: r.created_at,
    });
  }
  return out;
}

/** Like loadMediaForPlaylists but groups rows by playlist_id. */
async function loadPlaylistPoolsByIds(
  playlistIds: number[],
): Promise<Map<number, PoolMedia[]>> {
  const rows = await db
    .select({
      playlist_id: playlistMedia.playlist_id,
      sort_order: playlistMedia.sort_order,
      weight: playlistMedia.weight,
      id: mediaTable.id,
      sha256: mediaTable.sha256,
      category: mediaTable.category,
      title: mediaTable.title,
      artist: mediaTable.artist,
      original_filename: mediaTable.original_filename,
      duration_seconds: mediaTable.duration_seconds,
      created_at: mediaTable.created_at,
    })
    .from(playlistMedia)
    .innerJoin(mediaTable, eq(playlistMedia.media_id, mediaTable.id))
    .where(inArray(playlistMedia.playlist_id, playlistIds));
  const out = new Map<number, PoolMedia[]>();
  for (const r of rows) {
    if (!out.has(r.playlist_id)) out.set(r.playlist_id, []);
    out.get(r.playlist_id)!.push({
      id: r.id,
      sha256: r.sha256,
      category: r.category,
      title: r.title,
      artist: r.artist,
      original_filename: r.original_filename,
      duration_seconds: r.duration_seconds,
      weight: r.weight,
      sort_order: r.sort_order,
      added_at: r.created_at,
    });
  }
  return out;
}

// ─── Source resolution ────────────────────────────────────────────────────────

function parseSources(raw: unknown): SegmentSourceEntry[] {
  // segment.sources is stored as JSON; Drizzle returns it parsed. We accept it
  // optimistically here — the API validates on write via SegmentSourceEntrySchema.
  if (!Array.isArray(raw)) return [];
  return raw as SegmentSourceEntry[];
}

function collectRotationIds(sources: SegmentSourceEntry[]): number[] {
  const ids = new Set<number>();
  for (const s of sources) {
    if (s.type === 'playlist' && s.rotation_id != null) {
      ids.add(s.rotation_id);
    }
  }
  return [...ids];
}

async function resolveSourceEntry(
  entry: SegmentSourceEntry,
  index: number,
  scheduled: ResolvedSegment,
  rotationById: Map<number, Rotation>,
): Promise<ResolvedSource | null> {
  switch (entry.type) {
    case 'show_playlist':
      return resolveShowPlaylist(entry, index, scheduled, rotationById);
    case 'show_jingles':
      return resolveShowJingles(entry, index, scheduled);
    case 'show_beds':
      return resolveShowBeds(entry, index, scheduled);
    case 'playlist':
      return resolvePlaylistEntry(entry, index, rotationById);
    case 'promos':
    case 'campaigns':
    case 'live':
    case 'recording':
      // Out of scope for the music predictor — campaigns/promos belong to stop-sets,
      // live/recording belong to non-music segment types.
      return null;
  }
}

async function resolveShowPlaylist(
  entry: Extract<SegmentSourceEntry, { type: 'show_playlist' }>,
  index: number,
  scheduled: ResolvedSegment,
  rotationById: Map<number, Rotation>,
): Promise<ResolvedSource | null> {
  if (!scheduled.show) return null; // unassigned clock → show_playlist source has no context

  const allShowPlaylists = await db
    .select()
    .from(showPlaylists)
    .where(eq(showPlaylists.show_id, scheduled.show.id));

  // Build the source for one tier; walk fallback_tier to chain alternatives.
  // Visited set guards against fallback cycles.
  const buildForTier = async (
    tier: string | null,
    visited: Set<string>,
  ): Promise<ResolvedSource | null> => {
    const key = tier ?? '__null__';
    if (visited.has(key)) return null;
    visited.add(key);

    const tierRows = allShowPlaylists.filter(
      (sp) => (tier === null ? sp.rotation_tier == null : sp.rotation_tier === tier),
    );
    if (tierRows.length === 0) return null;

    const playlistIds = tierRows.map((r) => r.playlist_id);
    const pool = await loadMediaForPlaylists(playlistIds);

    // The rotation document on any matching show_playlist row wins (in tier order).
    const rotationId = tierRows.find((r) => r.rotation_id != null)?.rotation_id ?? null;
    const rotation = pickRotation(rotationId, rotationById);
    const features = await loadRotationFeatures(rotationId, rotationById);

    const tierLabel = tier ?? '(no tier)';
    const fallbackTier = tierRows.find((r) => r.fallback_tier != null)?.fallback_tier ?? null;
    const fallback = fallbackTier ? await buildForTier(fallbackTier, visited) : null;

    return {
      index,
      type: 'show_playlist',
      weight: 1,
      description: `show_playlist tier=${tierLabel} (show=${scheduled.show!.name})`,
      pool,
      rotation,
      hot_play_pool: features.hot_play_pool,
      hot_play_every_n_tracks: features.hot_play_every_n_tracks,
      heavy_rotation_enabled: features.heavy_rotation_enabled,
      fallback,
    };
  };

  return buildForTier(null, new Set());
}

async function resolveShowJingles(
  entry: Extract<SegmentSourceEntry, { type: 'show_jingles' }>,
  index: number,
  scheduled: ResolvedSegment,
): Promise<ResolvedSource | null> {
  const playlistId = scheduled.show?.jingle_playlist_id ?? null;
  if (!playlistId) return null;
  const pool = await loadPlaylistPool(playlistId);
  return {
    index,
    type: 'show_jingles',
    weight: entry.weight,
    description: `show_jingles (show=${scheduled.show?.name ?? '?'})`,
    pool,
    rotation: DEFAULT_ROTATION,
    hot_play_pool: null,
    hot_play_every_n_tracks: null,
    heavy_rotation_enabled: false,
    fallback: null,
  };
}

async function resolveShowBeds(
  entry: Extract<SegmentSourceEntry, { type: 'show_beds' }>,
  index: number,
  scheduled: ResolvedSegment,
): Promise<ResolvedSource | null> {
  const playlistId = scheduled.show?.bed_playlist_id ?? null;
  if (!playlistId) return null;
  const pool = await loadPlaylistPool(playlistId);
  return {
    index,
    type: 'show_beds',
    weight: entry.weight,
    description: `show_beds (show=${scheduled.show?.name ?? '?'})`,
    pool,
    rotation: DEFAULT_ROTATION,
    hot_play_pool: null,
    hot_play_every_n_tracks: null,
    heavy_rotation_enabled: false,
    fallback: null,
  };
}

async function resolvePlaylistEntry(
  entry: Extract<SegmentSourceEntry, { type: 'playlist' }>,
  index: number,
  rotationById: Map<number, Rotation>,
): Promise<ResolvedSource | null> {
  const pool = await loadPlaylistPool(entry.playlist_id);
  const rotationId = entry.rotation_id ?? null;
  const rotation = pickRotation(rotationId, rotationById);
  const features = await loadRotationFeatures(rotationId, rotationById);
  return {
    index,
    type: 'playlist',
    weight: entry.weight,
    description: `playlist id=${entry.playlist_id}`,
    pool,
    rotation,
    hot_play_pool: features.hot_play_pool,
    hot_play_every_n_tracks: features.hot_play_every_n_tracks,
    heavy_rotation_enabled: features.heavy_rotation_enabled,
    fallback: null,
  };
}

function pickRotation(id: number | null, map: Map<number, Rotation>): SnapshotRotation {
  if (id == null) return DEFAULT_ROTATION;
  const r = map.get(id);
  if (!r) return DEFAULT_ROTATION;
  return {
    id: r.id,
    type: r.type,
    params: (r.params as Record<string, unknown>) ?? {},
  };
}

/**
 * Resolve rotation-level feature flags + pools for a given rotation id.
 * Returns null-equivalents when the rotation is missing or its features
 * aren't configured. The picker reads these from the ResolvedSource without
 * touching the rotation row directly.
 */
async function loadRotationFeatures(
  rotationId: number | null,
  rotationById: Map<number, Rotation>,
): Promise<{
  hot_play_pool: PoolMedia[] | null;
  hot_play_every_n_tracks: number | null;
  heavy_rotation_enabled: boolean;
}> {
  if (rotationId == null) {
    return { hot_play_pool: null, hot_play_every_n_tracks: null, heavy_rotation_enabled: false };
  }
  const r = rotationById.get(rotationId);
  if (!r) {
    return { hot_play_pool: null, hot_play_every_n_tracks: null, heavy_rotation_enabled: false };
  }
  let hot_play_pool: PoolMedia[] | null = null;
  let hot_play_every_n_tracks: number | null = null;
  if (r.hot_play_playlist_id != null && r.hot_play_every_n_tracks) {
    const pool = await loadPlaylistPool(r.hot_play_playlist_id);
    if (pool.length > 0) {
      hot_play_pool = pool;
      hot_play_every_n_tracks = r.hot_play_every_n_tracks;
    }
  }
  return {
    hot_play_pool,
    hot_play_every_n_tracks,
    heavy_rotation_enabled: !!r.heavy_rotation_enabled,
  };
}

// ─── Pool loading ─────────────────────────────────────────────────────────────

async function loadPlaylistPool(playlistId: number): Promise<PoolMedia[]> {
  return loadMediaForPlaylists([playlistId]);
}

async function loadMediaForPlaylists(playlistIds: number[]): Promise<PoolMedia[]> {
  if (playlistIds.length === 0) return [];
  const rows = await db
    .select({
      media_id: playlistMedia.media_id,
      sort_order: playlistMedia.sort_order,
      weight: playlistMedia.weight,
      id: mediaTable.id,
      sha256: mediaTable.sha256,
      category: mediaTable.category,
      title: mediaTable.title,
      artist: mediaTable.artist,
      original_filename: mediaTable.original_filename,
      duration_seconds: mediaTable.duration_seconds,
      created_at: mediaTable.created_at,
    })
    .from(playlistMedia)
    .innerJoin(mediaTable, eq(playlistMedia.media_id, mediaTable.id))
    .where(inArray(playlistMedia.playlist_id, playlistIds));

  // De-duplicate when one media id appears in multiple same-tier playlists —
  // keep the first occurrence (its sort_order/weight wins).
  const seen = new Set<number>();
  const out: PoolMedia[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      sha256: r.sha256,
      category: r.category,
      title: r.title,
      artist: r.artist,
      original_filename: r.original_filename,
      duration_seconds: r.duration_seconds,
      weight: r.weight,
      sort_order: r.sort_order,
      added_at: r.created_at,
    });
  }
  return out;
}

// ─── History + streaks ────────────────────────────────────────────────────────

async function loadRecentHistory(cutoff: Date): Promise<SnapshotPlayRecord[]> {
  const rows = await db
    .select({
      id: playHistory.id,
      media_id: playHistory.media_id,
      started_at: playHistory.started_at,
      category: mediaTable.category,
      artist: mediaTable.artist,
      clock_segment_id: playHistory.clock_segment_id,
      music_campaign_id: playHistory.music_campaign_id,
    })
    .from(playHistory)
    .leftJoin(mediaTable, eq(playHistory.media_id, mediaTable.id))
    .where(and(gte(playHistory.started_at, cutoff)))
    .orderBy(desc(playHistory.started_at));
  return rows.map((r) => ({
    id: r.id,
    media_id: r.media_id,
    started_at: r.started_at,
    category: r.category ?? null,
    artist: r.artist ?? null,
    clock_segment_id: r.clock_segment_id,
    music_campaign_id: r.music_campaign_id,
  }));
}

/**
 * Counts consecutive music plays since the most-recent interstitial play of
 * each kind. The walk stops at the start of the current clock instance — we
 * don't carry streaks across clock boundaries.
 */
function countMusicStreaks(
  history: SnapshotPlayRecord[],
  scheduled: ResolvedSegment,
): { sinceJingle: number; sinceStationId: number } {
  const boundary = scheduled.clock_instance_started_at.getTime();
  let sinceJingle = 0;
  let sinceStationId = 0;
  let stoppedJingle = false;
  let stoppedStationId = false;
  for (const row of history) {
    if (row.started_at.getTime() < boundary) break;
    const cat = row.category;
    if (!stoppedJingle) {
      if (cat === 'jingle') stoppedJingle = true;
      else if (cat === 'music') sinceJingle++;
    }
    if (!stoppedStationId) {
      // station IDs are stored as jingle category but typically come from the
      // station_id playlist. Without a stronger signal we treat them the same
      // as jingles here — the per-N counter on the segment governs cadence.
      if (cat === 'jingle') stoppedStationId = true;
      else if (cat === 'music') sinceStationId++;
    }
    if (stoppedJingle && stoppedStationId) break;
  }
  return { sinceJingle, sinceStationId };
}
