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
import type { SLogger } from '../supervisorLogger.js';
import {
  clockSegments,
  media as mediaTable,
  musicCampaigns as musicCampaignsTable,
  playHistory as playHistoryTable,
  playlistMedia as playlistMediaTable,
  playlists as playlistsTable,
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
    private readonly logger: SLogger | null = null,
  ) {}

  start(): void {
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'REQUEST_CANDIDATES' }>(
        'REQUEST_CANDIDATES',
        (msg) => {
          if (msg.process !== PROCESS_NAME) return;
          // Decision 98/99: without this catch, a transient throw inside the
          // pool build (DB hiccup) became an unhandled promise rejection and
          // crashed the whole API process (Node default). The planner's own
          // request timeout + failure signalling handle the missing
          // CANDIDATES response; this guard's only job is keeping the
          // process alive.
          void this.handleRequest(msg).catch((err) => {
            this.logger?.error(
              { err, process: 'music', event: 'CANDIDATES_REQUEST_FAILED', request_id: msg.request_id, segment_id: msg.segment_id },
              'music: REQUEST_CANDIDATES handler failed',
            );
          });
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

    // Resolve each source to a (rotation, playlist_id) pair.
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

    // Fallback: when no sources are configured or all sources lack a rotation_id,
    // use the default music rotation with all available music playlists so that
    // unconfigured segments still play music rather than falling through to
    // coasting fill.
    if (rotationConfigs.length === 0) {
      const [defaultRotation] = await this.db
        .select()
        .from(rotationsTable)
        .where(and(eq(rotationsTable.is_default, true), eq(rotationsTable.kind, 'music')))
        .limit(1);
      if (defaultRotation) {
        // Use any playlist_id from configured sources; if none, query all music playlists.
        const fallbackPlaylistIds = playlistSources.length > 0
          ? playlistSources.map((s) => s.playlist_id)
          : (await this.db
              .select({ id: playlistsTable.id })
              .from(playlistsTable)
              .where(eq(playlistsTable.type, 'music'))
            ).map((r) => r.id);
        for (const playlistId of fallbackPlaylistIds) {
          rotationConfigs.push({
            rotation_id: defaultRotation.id,
            playlist_id: playlistId,
            rotation: defaultRotation,
          });
        }
        this.logger?.warn({
          process: 'music',
          event: 'ROTATION_FALLBACK',
          segment_id: segmentId,
          default_rotation_id: defaultRotation.id,
          fallback_playlist_ids: fallbackPlaylistIds,
        }, 'music: segment has no rotation configured — falling back to default rotation');
      }
    }

    if (rotationConfigs.length === 0) {
      return { candidates: [], total_duration_seconds: 0 };
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
        durationNeededSeconds,
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
    if (aggregated.length === 0 && rotationConfigs.length > 0) {
      const rotationIds = rotationConfigs.map((c) => c.rotation_id);
      this.logger?.warn({ process: 'music', event: 'EMPTY_POOL', segment_id: segmentId, rotation_ids: rotationIds }, 'music: all rotations returned empty pools for segment');
    }
    return { candidates: aggregated, total_duration_seconds: totalDurationSeconds };
  }

  // LRP draw from the rotation's playlist: tracks never played go first,
  // then tracks ordered by oldest-most-recent play. Applies the rotation's
  // separation_minutes filter.
  private async draftRotationCandidates(
    cfg: RotationSourceConfig,
    limit: number,
    nowMs: number,
    durationNeededSeconds: number,
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

    // Latest started_at per media_id in this playlist. Deliberately does not
    // filter on `aborted` (Decision 63): a track cut short mid-air still
    // occupied a rotation slot and must stay deprioritized for LRP purposes,
    // even though it wouldn't count toward Campaign's billing/pacing.
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

    // D101: a track longer than the requested target — even by a second — is
    // disqualified outright (operator rule: a track that cannot fit the plan
    // is a mistake, not a candidate; a shortfall is honest, recoverable drift,
    // while airing a track longer than the whole segment is not). Filtering
    // BEFORE the LRP slice also keeps such tracks from permanently occupying
    // pool slots: a never-played mega-track sorts to the front of LRP forever
    // (it can never air, so it never stops being never-played) and would
    // otherwise win a slot in nearly every pool.
    const placeableIds = mediaIds.filter((id) => {
      const m = mediaById.get(id);
      return m != null && effectiveDuration(m) <= durationNeededSeconds;
    });

    // LRP sort across all tracks. Never-played first (-Infinity), then oldest
    // most-recently-played.
    const allSorted = placeableIds.slice().sort((a, b) => {
      const ta = latestByMediaId.get(a) ?? -Infinity;
      const tb = latestByMediaId.get(b) ?? -Infinity;
      return ta - tb;
    });

    // Partition into tracks that pass the separation window and those that
    // don't, preserving LRP order within each group.
    const passes: number[] = [];
    const fails: number[] = [];
    for (const id of allSorted) {
      const latest = latestByMediaId.get(id);
      const ok = latest == null || separationSeconds <= 0 || nowSeconds - latest >= separationSeconds;
      if (ok) passes.push(id);
      else fails.push(id);
    }

    // Separation-passing tracks fill the pool first. When the pass group is
    // smaller than needed, fall through to recently-played tracks (still in
    // LRP order) so the segment isn't left short and padded with branding.
    if (fails.length > 0 && passes.length < limit) {
      this.logger?.info({
        process: 'music',
        event: 'SEPARATION_RELAXED',
        rotation_id: cfg.rotation_id,
        playlist_id: cfg.playlist_id,
        separation_seconds: separationSeconds,
        passes: passes.length,
        fallback_used: Math.min(fails.length, limit - passes.length),
      }, 'music: separation filter relaxed — not enough candidates within window');
    }

    // random_separation genuinely randomizes selection within each group,
    // weighted toward the longest-waiting tracks — every other type keeps
    // the strict LRP order above unchanged.
    let orderedPasses = passes;
    let orderedFails = fails;
    if (cfg.rotation.type === 'random_separation') {
      orderedPasses = weightedRandomOrder(passes);
      orderedFails = weightedRandomOrder(fails);
    } else if (cfg.rotation.type === 'round_robin' || cfg.rotation.type === 'weighted') {
      this.logger?.warn({
        process: 'music', event: 'ROTATION_TYPE_UNIMPLEMENTED',
        rotation_id: cfg.rotation_id, type: cfg.rotation.type,
      }, 'music: rotation type not implemented, falling back to least-recently-played order');
    }

    const ranked = [...orderedPasses, ...orderedFails].slice(0, limit);
    const reasonLabel = cfg.rotation.type === 'random_separation' ? 'Random' : 'LRP';

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
              ? `${reasonLabel} rotation_id=${cfg.rotation_id} (never played)`
              : `${reasonLabel} rotation_id=${cfg.rotation_id} (last played ${formatAge(nowSeconds - lastTs)} ago)`,
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

    // LRP within the hot-play playlist. No `aborted` filter — same reasoning
    // as the rotation LRP query above (Decision 63).
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
      // Heavy-rotation daily cap — a Music-domain concept (distinct from
      // Campaign's ad billing/pacing), so per Decision 63 this counts any
      // row regardless of `aborted`: a cut-short heavy-rotation play still
      // occupied a slot and should still count against overplay risk.
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

      // LRP within the campaign's playlist. No `aborted` filter — same
      // reasoning as the rotation LRP query above (Decision 63).
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

// Weighted-random draw without replacement, for `random_separation` rotations.
// Every remaining candidate can be picked at each step, but earlier LRP
// positions (longer since last played) get proportionally more weight —
// weights are N, N-1, ..., 1 for a pool of size N, so the longest-waiting
// track is most likely to come out first without ever being guaranteed.
// Confirmed live 2026-07-04: this rotation type never actually randomized
// anything — every draw used the plain LRP sort below regardless of the
// configured type, which is indistinguishable from round-robin in practice.
function weightedRandomOrder(idsInLrpOrder: number[]): number[] {
  const pool = idsInLrpOrder.slice();
  const result: number[] = [];
  while (pool.length > 0) {
    const totalWeight = (pool.length * (pool.length + 1)) / 2;
    let r = Math.random() * totalWeight;
    let pickIndex = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= pool.length - i;
      if (r <= 0) { pickIndex = i; break; }
    }
    result.push(pool[pickIndex]);
    pool.splice(pickIndex, 1);
  }
  return result;
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
