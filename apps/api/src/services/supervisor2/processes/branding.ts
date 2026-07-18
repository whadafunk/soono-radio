// Branding content process — Phase 2.
//
// Returns a BrandingCandidatePool containing:
//   - jingles: LRP-ordered pool from the assigned-show jingle playlist if any,
//     else the clock-level jingle_playlist_id
//   - station_ids: LRP-ordered pool from clock.station_id_playlist_id
//   - segment_start / segment_end: the specific envelope clips configured on
//     clock_segments.start_clip_media_id / end_clip_media_id — a bookend is
//     one piece of audio, selected directly from the library (operator
//     decision 2026-07-18; envelopes were never playlist-managed content)
//   - show_start / show_end: same, from show.show_start_media_id /
//     show_end_media_id — only when show_id is set in REQUEST_CANDIDATES (D40)
//
// Decision 15: "No branding rotations in V2; round-robin and random only."
// LRP is implemented here against play_history because it yields the same
// pick a round-robin scan over the playlist would produce after enough
// history has accumulated, and it gracefully handles new media inserted
// into a playlist.
//
// No state changes on REQUEST_CANDIDATES. CONFIRM_USED is a logging no-op
// because LRP is derived from play_history, which the queue feeder writes
// when audio airs.

import { eq, inArray, sql } from 'drizzle-orm';
import { db as defaultDb } from '../../../db/index.js';
import type { SLogger } from '../supervisorLogger.js';
import {
  clocks as clocksTable,
  clockSegments,
  media as mediaTable,
  playHistory as playHistoryTable,
  playlistMedia as playlistMediaTable,
  shows as showsTable,
} from '../../../db/schema.js';
import { bus, type BusMessage, type ContentProcessName } from '../bus.js';
import type {
  BrandingCandidate,
  BrandingCandidatePool,
  BrandingContentSubtype,
} from '../types.js';

const PROCESS_NAME: ContentProcessName = 'branding';
// Synthetic id namespacing — keeps ids unique within a single pool when the
// same media id appears in two slots (e.g. as a jingle and as a segment
// envelope clip).
const NS_JINGLE = 1;
const NS_STATION_ID = 2;
const NS_SEGMENT_START = 3;
const NS_SEGMENT_END = 4;
const NS_SHOW_START = 5;
const NS_SHOW_END = 6;
const NS_STRIDE = 10_000_000;

export class BrandingProcess {
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
              { err, process: 'branding', event: 'CANDIDATES_REQUEST_FAILED', request_id: msg.request_id, segment_id: msg.segment_id },
              'branding: REQUEST_CANDIDATES handler failed',
            );
          });
        },
      ),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'CONFIRM_USED' }>('CONFIRM_USED', (msg) => {
        if (msg.process !== PROCESS_NAME) return;
        // LRP is derived from play_history; no in-memory state to advance.
      }),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'DROP_COMMITTED' }>('DROP_COMMITTED', (msg) => {
        if (msg.process !== PROCESS_NAME) return;
        // No DB rollback needed.
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
    const pool = await this.buildPool(msg.segment_id, msg.show_id ?? null);
    this._bus.emit({
      type: 'CANDIDATES',
      request_id: msg.request_id,
      process: PROCESS_NAME,
      payload: pool,
    });
  }

  async buildPool(
    segmentId: number,
    showId: number | null,
  ): Promise<BrandingCandidatePool> {
    const [segment] = await this.db
      .select()
      .from(clockSegments)
      .where(eq(clockSegments.id, segmentId));
    if (!segment) {
      return { jingles: [], station_ids: [] };
    }

    const [clock] = await this.db
      .select()
      .from(clocksTable)
      .where(eq(clocksTable.id, segment.clock_id));

    // Use show_id passed explicitly from the planner (D40). When set, query
    // the show directly — no calendar lookup needed.
    const show = showId != null ? await this.fetchShow(showId) : null;

    // Jingle source preference: assigned show's jingle playlist if set, else
    // the clock-level jingle_playlist_id (used for unassigned clocks per the
    // schema comment).
    const jinglePlaylistId =
      show?.jingle_playlist_id ?? clock?.jingle_playlist_id ?? null;
    const jingles = jinglePlaylistId
      ? await this.lrpPlaylist(jinglePlaylistId, 'jingle', NS_JINGLE)
      : [];
    if (jinglePlaylistId && jingles.length === 0) {
      this.logger?.warn({ process: 'branding', event: 'EMPTY_POOL', pool: 'jingles', playlist_id: jinglePlaylistId, segment_id: segmentId }, 'branding: jingle playlist is empty');
    }

    const stationIdPlaylistId = clock?.station_id_playlist_id ?? null;
    const stationIds = stationIdPlaylistId
      ? await this.lrpPlaylist(stationIdPlaylistId, 'station_id', NS_STATION_ID)
      : [];
    if (stationIdPlaylistId && stationIds.length === 0) {
      this.logger?.warn({ process: 'branding', event: 'EMPTY_POOL', pool: 'station_ids', playlist_id: stationIdPlaylistId, segment_id: segmentId }, 'branding: station ID playlist is empty');
    }

    const segmentStart = segment.start_clip_media_id
      ? await this.singleClip(segment.start_clip_media_id, 'segment_start', NS_SEGMENT_START)
      : undefined;
    const segmentEnd = segment.end_clip_media_id
      ? await this.singleClip(segment.end_clip_media_id, 'segment_end', NS_SEGMENT_END)
      : undefined;

    // Show envelopes only when show_id is set (D40). Planner decides whether
    // to place them based on is_show_start / is_show_end.
    const showStart =
      show?.show_start_media_id != null
        ? await this.singleClip(show.show_start_media_id, 'show_start', NS_SHOW_START)
        : undefined;
    const showEnd =
      show?.show_end_media_id != null
        ? await this.singleClip(show.show_end_media_id, 'show_end', NS_SHOW_END)
        : undefined;

    return {
      jingles,
      station_ids: stationIds,
      segment_start: segmentStart,
      segment_end: segmentEnd,
      show_start: showStart,
      show_end: showEnd,
    };
  }

  // LRP-ordered pool from a playlist. Returns the entire pool — the planner
  // applies any further limit/separation it needs.
  private async lrpPlaylist(
    playlistId: number,
    subtype: BrandingContentSubtype,
    namespace: number,
  ): Promise<BrandingCandidate[]> {
    const playlistMedia = await this.db
      .select({ media_id: playlistMediaTable.media_id })
      .from(playlistMediaTable)
      .where(eq(playlistMediaTable.playlist_id, playlistId));
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

    // Latest started_at per media_id. Deliberately does not filter on
    // `aborted` (Decision 63): a jingle/station-id/envelope cut short still
    // occupied a rotation slot and must stay deprioritized for LRP purposes
    // — only Campaign's billing/pacing counters exclude aborted plays.
    const lastPlayed = await this.db
      .select({
        media_id: playHistoryTable.media_id,
        latest: sql<number>`MAX(${playHistoryTable.started_at})`.as('latest'),
      })
      .from(playHistoryTable)
      .where(inArray(playHistoryTable.media_id, mediaIds))
      .groupBy(playHistoryTable.media_id);
    const latestByMediaId = new Map<number, number>();
    for (const r of lastPlayed) {
      if (r.media_id == null) continue;
      const ts = typeof r.latest === 'number' ? r.latest : Number(r.latest);
      latestByMediaId.set(r.media_id, ts);
    }

    return mediaIds
      .slice()
      .sort((a, b) => {
        const ta = latestByMediaId.get(a) ?? -Infinity;
        const tb = latestByMediaId.get(b) ?? -Infinity;
        return ta - tb;
      })
      .map<BrandingCandidate | null>((id) => {
        const m = mediaById.get(id);
        if (!m) return null;
        return {
          id: namespace * NS_STRIDE + id,
          media_id: id,
          duration_seconds: effectiveDuration(m),
          content_subtype: subtype,
          playlist_id: playlistId,
        };
      })
      .filter((c): c is BrandingCandidate => c !== null);
  }

  // Single envelope clip — configured directly by media id. A dangling id
  // (clip deleted from the library) resolves to no envelope, gracefully;
  // there is deliberately no FK on the config columns (CLAUDE.md gotcha).
  // playlist_id: 0 marks a single-media source per BrandingCandidate's
  // long-standing contract.
  private async singleClip(
    mediaId: number,
    subtype: BrandingContentSubtype,
    namespace: number,
  ): Promise<BrandingCandidate | undefined> {
    const [m] = await this.db
      .select({
        id: mediaTable.id,
        duration_seconds: mediaTable.duration_seconds,
        cue_in_seconds: mediaTable.cue_in_seconds,
        cue_out_seconds: mediaTable.cue_out_seconds,
      })
      .from(mediaTable)
      .where(eq(mediaTable.id, mediaId));
    if (!m) return undefined;
    return {
      id: namespace * NS_STRIDE + m.id,
      media_id: m.id,
      duration_seconds: effectiveDuration(m),
      content_subtype: subtype,
      playlist_id: 0,
    };
  }

  private async fetchShow(showId: number): Promise<{
    jingle_playlist_id: number | null;
    show_start_media_id: number | null;
    show_end_media_id: number | null;
  } | null> {
    const [show] = await this.db
      .select({
        jingle_playlist_id: showsTable.jingle_playlist_id,
        show_start_media_id: showsTable.show_start_media_id,
        show_end_media_id: showsTable.show_end_media_id,
      })
      .from(showsTable)
      .where(eq(showsTable.id, showId));
    return show ?? null;
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

