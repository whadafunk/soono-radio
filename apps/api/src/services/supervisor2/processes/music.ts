// Music content process — Phase 2.
//
// Responds to REQUEST_CANDIDATES with a MusicCandidatePool that combines:
//   1. Rotation candidates — LRP-ordered tracks drawn from each music source
//      (segment.sources entries of type 'playlist').
//   2. Hot-play candidates — when a source rotation defines hot_play_playlist_id
//      and the consecutive non-hot-play streak in play_history meets the
//      configured threshold, slip in a track from that playlist (also LRP).
//   3. Heavy-rotation candidates — when a source rotation has
//      heavy_rotation_enabled, surface tracks from active music campaigns whose
//      pacing is behind the daily target.
//
// Critical rule: REQUEST_CANDIDATES must not mutate any state. LRP, pacing,
// and streak state are all derived from play_history, which the queue feeder
// writes when audio actually airs. CONFIRM_USED is therefore a logging
// no-op here — there is no in-memory state to advance. DROP_COMMITTED is
// likewise a no-op because nothing was persisted.

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db as defaultDb } from '../../../db/index.js';
import {
  clockSegments,
  media as mediaTable,
  musicCampaigns as musicCampaignsTable,
  playHistory as playHistoryTable,
  playlistMedia as playlistMediaTable,
  rotations as rotationsTable,
} from '../../../db/schema.js';
import { bus, type BusMessage, type ContentProcessName } from '../bus.js';
import type {
  MusicCandidate,
  MusicCandidatePool,
} from '../types.js';

const PROCESS_NAME: ContentProcessName = 'music';
// Multiplier for how many rotation candidates to return per source — gives
// the planner enough headroom to apply separation and slot constraints
// without re-querying. Floor of 5 ensures small rotations still return
// usable pools.
const POOL_MULTIPLIER = 2.5;
const MIN_POOL_PER_SOURCE = 5;
// Average music track length used for sizing rotation pools when we only
// know the segment's needed duration. Real candidate durations are loaded
// from media.duration_seconds before the pool is finalized.
const ASSUMED_AVG_TRACK_SECONDS = 200;

interface RotationSourceConfig {
  rotation_id: number;
  // The playlist whose tracks this rotation draws from. For a music segment
  // this comes from the segment's sources[] entries of type 'playlist'.
  playlist_id: number;
  // Cached row used during candidate assembly.
  rotation: typeof rotationsTable.$inferSelect;
}

export class MusicProcess {
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly _bus: typeof bus,
    private readonly db: typeof defaultDb = defaultDb,
  ) {}

  start(): void {
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'REQUEST_CANDIDATES' }>(
        'REQUEST_CANDIDATES',
        (msg) => {
          if (msg.process !== PROCESS_NAME) return;
          void this.handleRequest(msg);
        },
      ),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'CONFIRM_USED' }>('CONFIRM_USED', (msg) => {
        if (msg.process !== PROCESS_NAME) return;
        // No in-memory state to advance. LRP and pacing are read from
        // play_history, which the queue feeder writes when audio airs.
      }),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'DROP_COMMITTED' }>('DROP_COMMITTED', (msg) => {
        if (msg.process !== PROCESS_NAME) return;
        // No DB rollback needed — CONFIRM_USED did not write anything.
      }),
    );
  }

  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }

  private async handleRequest(
    msg: BusMessage & { type: 'REQUEST_CANDIDATES' },
  ): Promise<void> {
    const pool = await this.buildPool(
      msg.segment_id,
      msg.duration_needed_seconds,
      msg.now_ms,
    );
    this._bus.emit({
      type: 'CANDIDATES',
      request_id: msg.request_id,
      process: PROCESS_NAME,
      payload: pool,
    });
  }

  // Builds the candidate pool. Pure read — no writes against any table.
  async buildPool(
    segmentId: number,
    durationNeededSeconds: number,
    nowMs: number,
  ): Promise<MusicCandidatePool> {
    const [segment] = await this.db
      .select()
      .from(clockSegments)
      .where(eq(clockSegments.id, segmentId));
    if (!segment) {
      return { candidates: [], total_duration_seconds: 0 };
    }

    const sources = parseSources(segment.sources);
    const playlistSources = sources.filter(
      (s): s is { type: 'playlist'; playlist_id: number; rotation_id?: number | null } =>
        s.type === 'playlist' && typeof s.playlist_id === 'number',
    );
    if (playlistSources.length === 0) {
      return { candidates: [], total_duration_seconds: 0 };
    }

    // Resolve each source to a (rotation, playlist_id) pair. Sources that
    // don't define a rotation_id are skipped — we don't have a fallback
    // rotation algorithm to apply, and the Planner can re-request with a
    // wider net if it needs to.
    const rotationConfigs: RotationSourceConfig[] = [];
    const seenRotationIds = new Set<number>();
    for (const src of playlistSources) {
      if (src.rotation_id == null) continue;
      if (seenRotationIds.has(src.rotation_id)) continue;
      const [row] = await this.db
        .select()
        .from(rotationsTable)
        .where(eq(rotationsTable.id, src.rotation_id));
      if (!row) continue;
      rotationConfigs.push({
        rotation_id: src.rotation_id,
        playlist_id: src.playlist_id,
        rotation: row,
      });
      seenRotationIds.add(src.rotation_id);
    }

    const targetPerSource = Math.max(
      MIN_POOL_PER_SOURCE,
      Math.ceil(
        (durationNeededSeconds * POOL_MULTIPLIER) /
          Math.max(1, ASSUMED_AVG_TRACK_SECONDS) /
          Math.max(1, rotationConfigs.length),
      ),
    );

    const aggregated: MusicCandidate[] = [];
    const seenMediaIds = new Set<number>();
    for (const cfg of rotationConfigs) {
      const rotationCandidates = await this.draftRotationCandidates(
        cfg,
        targetPerSource,
        nowMs,
      );
      for (const c of rotationCandidates) {
        if (seenMediaIds.has(c.media_id)) continue;
        seenMediaIds.add(c.media_id);
        aggregated.push(c);
      }

      // Hot-play: inject one candidate when streak threshold is met.
      const hotPlayCandidate = await this.draftHotPlayCandidate(cfg, nowMs);
      if (hotPlayCandidate && !seenMediaIds.has(hotPlayCandidate.media_id)) {
        seenMediaIds.add(hotPlayCandidate.media_id);
        aggregated.push(hotPlayCandidate);
      }

      // Heavy rotation: surface music-campaign tracks if the rotation
      // opts in and any active campaign is behind pacing.
      if (cfg.rotation.heavy_rotation_enabled) {
        const heavy = await this.draftHeavyRotationCandidates(cfg, nowMs);
        for (const c of heavy) {
          if (seenMediaIds.has(c.media_id)) continue;
          seenMediaIds.add(c.media_id);
          aggregated.push(c);
        }
      }
    }

    const totalDurationSeconds = aggregated.reduce(
      (sum, c) => sum + c.duration_seconds,
      0,
    );
    return { candidates: aggregated, total_duration_seconds: totalDurationSeconds };
  }

  // LRP draw from the rotation's playlist: tracks never played go first,
  // then tracks ordered by oldest-most-recent play. Applies the rotation's
  // separation_minutes filter.
  private async draftRotationCandidates(
    cfg: RotationSourceConfig,
    limit: number,
    nowMs: number,
  ): Promise<MusicCandidate[]> {
    const playlistMedia = await this.db
      .select({
        media_id: playlistMediaTable.media_id,
        sort_order: playlistMediaTable.sort_order,
      })
      .from(playlistMediaTable)
      .where(eq(playlistMediaTable.playlist_id, cfg.playlist_id));
    if (playlistMedia.length === 0) return [];

    const mediaIds = playlistMedia.map((r) => r.media_id);
    const mediaRows = await this.db
      .select({
        id: mediaTable.id,
        duration_seconds: mediaTable.duration_seconds,
        cue_in_seconds: mediaTable.cue_in_seconds,
        cue_out_seconds: mediaTable.cue_out_seconds,
      })
      .from(mediaTable)
      .where(inArray(mediaTable.id, mediaIds));
    const mediaById = new Map(mediaRows.map((r) => [r.id, r]));

    // Latest started_at per media_id in this playlist.
    const lastPlayed = await this.db
      .select({
        media_id: playHistoryTable.media_id,
        latest: sql<number>`MAX(${playHistoryTable.started_at})`.as('latest'),
      })
      .from(playHistoryTable)
      .where(inArray(playHistoryTable.media_id, mediaIds))
      .groupBy(playHistoryTable.media_id);
    const latestByMediaId = new Map<number, number>();
    for (const row of lastPlayed) {
      if (row.media_id == null) continue;
      // started_at is stored as unix seconds (libsql timestamp mode).
      const ts = typeof row.latest === 'number' ? row.latest : Number(row.latest);
      latestByMediaId.set(row.media_id, ts);
    }

    const separationSeconds = readSeparationMinutes(cfg.rotation.params) * 60;
    const nowSeconds = Math.floor(nowMs / 1000);

    // Build LRP ranking. Never-played first (treated as -Infinity timestamp),
    // then ascending by latest started_at.
    const ranked = mediaIds
      .filter((id) => {
        // Apply separation: skip tracks played within the rotation window.
        const latest = latestByMediaId.get(id);
        if (latest == null) return true;
        if (separationSeconds <= 0) return true;
        return nowSeconds - latest >= separationSeconds;
      })
      .sort((a, b) => {
        const ta = latestByMediaId.get(a) ?? -Infinity;
        const tb = latestByMediaId.get(b) ?? -Infinity;
        return ta - tb;
      })
      .slice(0, limit);

    return ranked
      .map<MusicCandidate | null>((mediaId) => {
        const m = mediaById.get(mediaId);
        if (!m) return null;
        const lastTs = latestByMediaId.get(mediaId);
        return {
          id: mediaId,
          media_id: mediaId,
          duration_seconds: effectiveDuration(m),
          source: 'rotation',
          rotation_id: cfg.rotation_id,
          reason_hint:
            lastTs == null
              ? `LRP rotation_id=${cfg.rotation_id} (never played)`
              : `LRP rotation_id=${cfg.rotation_id} (last played ${formatAge(nowSeconds - lastTs)} ago)`,
        };
      })
      .filter((c): c is MusicCandidate => c !== null);
  }

  // Hot-play streak check: how many tracks from this rotation's playlist were
  // played consecutively after the most recent hot-play pick? If the streak
  // meets hot_play_every_n_tracks, slip in one LRP candidate from the
  // hot_play_playlist_id.
  private async draftHotPlayCandidate(
    cfg: RotationSourceConfig,
    nowMs: number,
  ): Promise<MusicCandidate | null> {
    const hotPlayPlaylistId = cfg.rotation.hot_play_playlist_id;
    const everyN = cfg.rotation.hot_play_every_n_tracks;
    if (hotPlayPlaylistId == null || everyN == null || everyN <= 0) {
      return null;
    }

    const hotPlaylistMedia = await this.db
      .select({ media_id: playlistMediaTable.media_id })
      .from(playlistMediaTable)
      .where(eq(playlistMediaTable.playlist_id, hotPlayPlaylistId));
    if (hotPlaylistMedia.length === 0) return null;
    const hotMediaIds = new Set(hotPlaylistMedia.map((r) => r.media_id));

    const rotationPlaylistMedia = await this.db
      .select({ media_id: playlistMediaTable.media_id })
      .from(playlistMediaTable)
      .where(eq(playlistMediaTable.playlist_id, cfg.playlist_id));
    const rotationMediaIds = new Set(rotationPlaylistMedia.map((r) => r.media_id));

    // Pull recent music-source plays. Inspect newest-first to compute the
    // streak. We only need enough rows to either find a hot-play pick or
    // confirm none in the last (everyN * 2) plays.
    const recent = await this.db
      .select({
        media_id: playHistoryTable.media_id,
        started_at: playHistoryTable.started_at,
      })
      .from(playHistoryTable)
      .where(eq(playHistoryTable.source, 'auto'))
      .orderBy(desc(playHistoryTable.started_at))
      .limit(Math.max(everyN * 2, 20));

    let streak = 0;
    for (const row of recent) {
      if (row.media_id == null) continue;
      if (hotMediaIds.has(row.media_id)) {
        // Most recent hot pick found — stop counting.
        break;
      }
      if (rotationMediaIds.has(row.media_id)) {
        streak += 1;
      }
    }
    if (streak < everyN) return null;

    // LRP within the hot-play playlist.
    const ids = Array.from(hotMediaIds);
    const lastPlayed = await this.db
      .select({
        media_id: playHistoryTable.media_id,
        latest: sql<number>`MAX(${playHistoryTable.started_at})`.as('latest'),
      })
      .from(playHistoryTable)
      .where(inArray(playHistoryTable.media_id, ids))
      .groupBy(playHistoryTable.media_id);
    const latestByMediaId = new Map<number, number>();
    for (const row of lastPlayed) {
      if (row.media_id == null) continue;
      const ts = typeof row.latest === 'number' ? row.latest : Number(row.latest);
      latestByMediaId.set(row.media_id, ts);
    }
    const lrpId = ids.sort((a, b) => {
      const ta = latestByMediaId.get(a) ?? -Infinity;
      const tb = latestByMediaId.get(b) ?? -Infinity;
      return ta - tb;
    })[0];
    if (lrpId == null) return null;
    const [m] = await this.db
      .select({
        id: mediaTable.id,
        duration_seconds: mediaTable.duration_seconds,
        cue_in_seconds: mediaTable.cue_in_seconds,
        cue_out_seconds: mediaTable.cue_out_seconds,
      })
      .from(mediaTable)
      .where(eq(mediaTable.id, lrpId));
    if (!m) return null;

    const nowSeconds = Math.floor(nowMs / 1000);
    const lastTs = latestByMediaId.get(lrpId);
    return {
      id: lrpId,
      media_id: lrpId,
      duration_seconds: effectiveDuration(m),
      source: 'hot_play',
      rotation_id: cfg.rotation_id,
      reason_hint:
        lastTs == null
          ? `hot_play every ${everyN} tracks; LRP (never played)`
          : `hot_play every ${everyN} tracks; LRP (last played ${formatAge(nowSeconds - lastTs)} ago)`,
    };
  }

  // For each active music campaign whose pacing today is behind target,
  // surface tracks from its playlist as heavy-rotation candidates.
  private async draftHeavyRotationCandidates(
    cfg: RotationSourceConfig,
    nowMs: number,
  ): Promise<MusicCandidate[]> {
    const today = ymdFromMs(nowMs);
    const campaigns = await this.db
      .select()
      .from(musicCampaignsTable)
      .where(
        and(
          eq(musicCampaignsTable.active, true),
          sql`${musicCampaignsTable.starts_on} <= ${today}`,
          sql`${musicCampaignsTable.ends_on} >= ${today}`,
        ),
      );
    if (campaigns.length === 0) return [];

    const midnightSeconds = Math.floor(midnightMs(nowMs) / 1000);
    const out: MusicCandidate[] = [];

    for (const campaign of campaigns) {
      const playsToday = await this.db
        .select({ n: sql<number>`COUNT(*)`.as('n') })
        .from(playHistoryTable)
        .where(
          and(
            eq(playHistoryTable.music_campaign_id, campaign.id),
            gte(playHistoryTable.started_at, new Date(midnightSeconds * 1000)),
          ),
        );
      const played = Number(playsToday[0]?.n ?? 0);
      const target = campaign.plays_per_day;
      if (target <= 0) continue;
      const pacingScore = Math.max(0, 1 - played / target);
      // Only surface candidates when behind. A non-behind campaign emits
      // nothing — letting the rotation tracks win the slot is correct.
      if (pacingScore <= 0) continue;

      const playlistMedia = await this.db
        .select({ media_id: playlistMediaTable.media_id })
        .from(playlistMediaTable)
        .where(eq(playlistMediaTable.playlist_id, campaign.playlist_id));
      if (playlistMedia.length === 0) continue;
      const mediaIds = playlistMedia.map((r) => r.media_id);
      const mediaRows = await this.db
        .select({
          id: mediaTable.id,
          duration_seconds: mediaTable.duration_seconds,
          cue_in_seconds: mediaTable.cue_in_seconds,
          cue_out_seconds: mediaTable.cue_out_seconds,
        })
        .from(mediaTable)
        .where(inArray(mediaTable.id, mediaIds));

      // LRP within the campaign's playlist.
      const lastPlayed = await this.db
        .select({
          media_id: playHistoryTable.media_id,
          latest: sql<number>`MAX(${playHistoryTable.started_at})`.as('latest'),
        })
        .from(playHistoryTable)
        .where(inArray(playHistoryTable.media_id, mediaIds))
        .groupBy(playHistoryTable.media_id);
      const latestByMediaId = new Map<number, number>();
      for (const row of lastPlayed) {
        if (row.media_id == null) continue;
        const ts = typeof row.latest === 'number' ? row.latest : Number(row.latest);
        latestByMediaId.set(row.media_id, ts);
      }
      const ordered = mediaRows
        .map((m) => ({
          m,
          ts: latestByMediaId.get(m.id) ?? -Infinity,
        }))
        .sort((a, b) => a.ts - b.ts)
        .slice(0, MIN_POOL_PER_SOURCE);

      for (const { m } of ordered) {
        out.push({
          id: m.id,
          media_id: m.id,
          duration_seconds: effectiveDuration(m),
          source: 'heavy_rotation',
          rotation_id: cfg.rotation_id,
          music_campaign_id: campaign.id,
          pacing_score: pacingScore,
          reason_hint: `heavy_rotation campaign='${campaign.name}' (plays ${played}/${target} today, pacing_score=${pacingScore.toFixed(2)})`,
        });
      }
    }
    return out;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface MediaDurationCols {
  duration_seconds: number;
  cue_in_seconds: number | null;
  cue_out_seconds: number | null;
}

function effectiveDuration(m: MediaDurationCols): number {
  if (m.cue_in_seconds != null && m.cue_out_seconds != null) {
    const eff = m.cue_out_seconds - m.cue_in_seconds;
    if (eff > 0) return eff;
  }
  return m.duration_seconds;
}

type ParsedSource = {
  type: string;
  playlist_id?: number;
  rotation_id?: number | null;
};

// segment.sources is stored as JSON text. The drizzle column declaration uses
// { mode: 'json' } but libsql still surfaces it as a string in some code paths;
// handle both.
function parseSources(raw: unknown): ParsedSource[] {
  if (Array.isArray(raw)) return raw as ParsedSource[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ParsedSource[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function readSeparationMinutes(params: unknown): number {
  if (typeof params === 'string') {
    try {
      const parsed = JSON.parse(params);
      return readSeparationMinutes(parsed);
    } catch {
      return 0;
    }
  }
  if (params && typeof params === 'object') {
    const v = (params as Record<string, unknown>).separation_minutes;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

function midnightMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function ymdFromMs(nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}
