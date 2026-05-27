// Branding content process — Phase 2.
//
// Returns a BrandingCandidatePool containing:
//   - jingles: LRP-ordered pool from the assigned-show jingle playlist if any,
//     else the clock-level jingle_playlist_id
//   - station_ids: LRP-ordered pool from clock.station_id_playlist_id
//   - segment_start / segment_end: single LRP picks from
//     clock_segments.start_clip_playlist_id / end_clip_playlist_id
//   - show_start / show_end: single picks from show.intro_media_id /
//     outro_media_id (single media, not playlists — per schema)
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
import {
  calendarEntries as calendarEntriesTable,
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
    const pool = await this.buildPool(msg.segment_id, msg.clock_instance_started_at);
    this._bus.emit({
      type: 'CANDIDATES',
      request_id: msg.request_id,
      process: PROCESS_NAME,
      payload: pool,
    });
  }

  async buildPool(
    segmentId: number,
    clockInstanceStartedAt: number,
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

    const show = await this.resolveShow(clockInstanceStartedAt);

    // Jingle source preference: assigned show's jingle playlist if set, else
    // the clock-level jingle_playlist_id (used for unassigned clocks per the
    // schema comment).
    const jinglePlaylistId =
      show?.jingle_playlist_id ?? clock?.jingle_playlist_id ?? null;
    const jingles = jinglePlaylistId
      ? await this.lrpPlaylist(jinglePlaylistId, 'jingle', NS_JINGLE)
      : [];

    const stationIdPlaylistId = clock?.station_id_playlist_id ?? null;
    const stationIds = stationIdPlaylistId
      ? await this.lrpPlaylist(stationIdPlaylistId, 'station_id', NS_STATION_ID)
      : [];

    const segmentStart = segment.start_clip_playlist_id
      ? await this.lrpSingle(
          segment.start_clip_playlist_id,
          'segment_start',
          NS_SEGMENT_START,
        )
      : undefined;
    const segmentEnd = segment.end_clip_playlist_id
      ? await this.lrpSingle(
          segment.end_clip_playlist_id,
          'segment_end',
          NS_SEGMENT_END,
        )
      : undefined;

    const showStart = show?.intro_media_id
      ? await this.singleMedia(show.intro_media_id, 'show_start', NS_SHOW_START)
      : undefined;
    const showEnd = show?.outro_media_id
      ? await this.singleMedia(show.outro_media_id, 'show_end', NS_SHOW_END)
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

  // Single envelope pick — uses LRP within the envelope playlist to choose
  // the "next in sequence" feel without needing an explicit cursor.
  private async lrpSingle(
    playlistId: number,
    subtype: BrandingContentSubtype,
    namespace: number,
  ): Promise<BrandingCandidate | undefined> {
    const pool = await this.lrpPlaylist(playlistId, subtype, namespace);
    return pool[0];
  }

  private async singleMedia(
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
      // 0 = single-media source (show.intro_media_id / outro_media_id), not
      // drawn from a playlist.
      playlist_id: 0,
    };
  }

  // Resolve the show that owns this clock instance by walking calendar entries
  // for the day. Falls back to null when the clock isn't part of a show.
  private async resolveShow(
    clockInstanceStartedAt: number,
  ): Promise<{
    intro_media_id: number | null;
    outro_media_id: number | null;
    jingle_playlist_id: number | null;
  } | null> {
    const date = ymdFromMs(clockInstanceStartedAt);
    const hhmm = hhmmFromMs(clockInstanceStartedAt);
    const rows = await this.db
      .select({
        show_id: calendarEntriesTable.show_id,
        time_start: calendarEntriesTable.time_start,
        time_end: calendarEntriesTable.time_end,
      })
      .from(calendarEntriesTable)
      .where(eq(calendarEntriesTable.date, date));
    for (const r of rows) {
      if (r.time_start <= hhmm && hhmm < r.time_end && r.show_id != null) {
        const [show] = await this.db
          .select({
            intro_media_id: showsTable.intro_media_id,
            outro_media_id: showsTable.outro_media_id,
            jingle_playlist_id: showsTable.jingle_playlist_id,
          })
          .from(showsTable)
          .where(eq(showsTable.id, r.show_id));
        return show ?? null;
      }
    }
    return null;
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

function ymdFromMs(nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function hhmmFromMs(nowMs: number): string {
  const d = new Date(nowMs);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
