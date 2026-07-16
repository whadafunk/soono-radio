// Rundown content process — Phase 2.
//
// Handles news / bulletin / voice_track segments whose content is pre-assigned
// by an operator via the Rundown editor. Two assignment modes exist (see
// docs/rundown.md):
//
//   1. Per-slot file assignment in `rundown_assignments`, keyed by
//      (date, time_start, clock_id, segment_index). One media id per slot.
//
//   2. Show-content playlist assignment in `rundown_show_content`, keyed by
//      (date, time_start, clock_id, segment_type). The playlist's tracks are
//      sequenced across all segments of that type in the same clock
//      instance, by counting how many have already aired in play_history
//      (Decision 63's Rundown view, Decision 65) — not a separately
//      maintained cursor. `rundown_playback_cursors` still exists in the
//      schema but is dead: it was never written to anywhere, so an earlier
//      version of this sequencing always served the same first track. See
//      Decision 65 for the incident; dropping the now-unused table is a
//      separate cleanup.
//
// Per-slot assignments take precedence over show-content. If neither exists,
// the pool is empty and gap_estimate_seconds = segment_duration (Decision 18
// — the planner fills the gap from the segment's normal music/branding
// pools via coasting_order).
//
// State changes happen only on CONFIRM_USED — there's nothing to advance;
// sequencing position is derived fresh from play_history on every request,
// the same self-correcting pattern Music/Campaign/Branding already use.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db as defaultDb } from '../../../db/index.js';
import {
  clockSegments,
  media as mediaTable,
  planItems as planItemsTable,
  playHistory as playHistoryTable,
  playlists as playlistsTable,
  playlistMedia as playlistMediaTable,
  plans as plansTable,
  rundownAssignments as rundownAssignmentsTable,
  rundownDurationOverrides as rundownDurationOverridesTable,
  rundownShowContent as rundownShowContentTable,
  type ClockSegmentType,
} from '../../../db/schema.js';
import { bus, type BusMessage, type ContentProcessName } from '../bus.js';
import type { SLogger } from '../supervisorLogger.js';
import type { RundownCandidatePool, RundownItem } from '../types.js';

const PROCESS_NAME: ContentProcessName = 'rundown';
// Segment types whose content can be assigned via show-content playlists.
const SHOW_CONTENT_TYPES = new Set(['news', 'bulletin']);
// Segment types this process responds for at all. voice_track only supports
// per-slot file assignments.
const RUNDOWN_SEGMENT_TYPES = new Set(['news', 'bulletin', 'voice_track']);

export class RundownProcess {
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
              { err, process: 'rundown', event: 'CANDIDATES_REQUEST_FAILED', request_id: msg.request_id, segment_id: msg.segment_id },
              'rundown: REQUEST_CANDIDATES handler failed',
            );
          });
        },
      ),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'CONFIRM_USED' }>('CONFIRM_USED', (msg) => {
        if (msg.process !== PROCESS_NAME) return;
        // No state to advance — show-content sequence position is derived
        // fresh from play_history on the next request (Decision 65), not
        // tracked here.
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
  ): Promise<RundownCandidatePool> {
    const [segment] = await this.db
      .select()
      .from(clockSegments)
      .where(eq(clockSegments.id, segmentId));
    if (!segment) return emptyPool(0);

    if (!RUNDOWN_SEGMENT_TYPES.has(segment.type)) {
      // Not a rundown segment — empty pool, full gap. The planner will fall
      // through to music/branding for this segment.
      return emptyPool(segment.duration_seconds);
    }

    // Resolve the 0-based segment_index within the clock's segment list.
    const siblings = await this.db
      .select({ id: clockSegments.id, sort_order: clockSegments.sort_order })
      .from(clockSegments)
      .where(eq(clockSegments.clock_id, segment.clock_id));
    siblings.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    const segmentIndex = siblings.findIndex((s) => s.id === segment.id);
    if (segmentIndex < 0) {
      return emptyPool(segment.duration_seconds);
    }

    const date = ymdFromMs(clockInstanceStartedAt);
    const timeStart = hhmmFromMs(clockInstanceStartedAt);

    // ── Effective segment duration: per-slot override takes precedence ──
    const [override] = await this.db
      .select({ duration_seconds: rundownDurationOverridesTable.duration_seconds })
      .from(rundownDurationOverridesTable)
      .where(
        and(
          eq(rundownDurationOverridesTable.date, date),
          eq(rundownDurationOverridesTable.time_start, timeStart),
          eq(rundownDurationOverridesTable.clock_id, segment.clock_id),
          eq(rundownDurationOverridesTable.segment_index, segmentIndex),
        ),
      );
    const effectiveDuration =
      override?.duration_seconds ?? segment.duration_seconds;

    // ── Per-slot file assignment takes precedence over show-content ────
    const [assignment] = await this.db
      .select({ media_id: rundownAssignmentsTable.media_id })
      .from(rundownAssignmentsTable)
      .where(
        and(
          eq(rundownAssignmentsTable.date, date),
          eq(rundownAssignmentsTable.time_start, timeStart),
          eq(rundownAssignmentsTable.clock_id, segment.clock_id),
          eq(rundownAssignmentsTable.segment_index, segmentIndex),
        ),
      );
    if (assignment?.media_id != null) {
      const item = await this.loadMediaAsItem(assignment.media_id, 0);
      if (item) {
        return {
          items: [item],
          total_duration_seconds: item.duration_seconds,
          gap_estimate_seconds: Math.max(0, effectiveDuration - item.duration_seconds),
        };
      }
    }

    // ── Show-content playlist (news / bulletin only) ──────────────────
    if (SHOW_CONTENT_TYPES.has(segment.type)) {
      const [content] = await this.db
        .select({ playlist_id: rundownShowContentTable.playlist_id })
        .from(rundownShowContentTable)
        .where(
          and(
            eq(rundownShowContentTable.date, date),
            eq(rundownShowContentTable.time_start, timeStart),
            eq(rundownShowContentTable.clock_id, segment.clock_id),
            eq(rundownShowContentTable.segment_type, segment.type),
          ),
        );
      if (content?.playlist_id != null) {
        const item = await this.nextFromShowContentPlaylist(
          content.playlist_id,
          segment.clock_id,
          segment.type,
          clockInstanceStartedAt,
        );
        if (item) {
          return {
            items: [item],
            total_duration_seconds: item.duration_seconds,
            gap_estimate_seconds: Math.max(0, effectiveDuration - item.duration_seconds),
          };
        }
      }
    }

    // ── Fallback playlist (clock segment-level) ───────────────────────
    // The fallback was added in migration 0039: a playlist that the
    // supervisor draws from when no rundown assignment exists. Returning
    // every track gives the planner the option to fill the whole segment;
    // it is responsible for staying within the duration budget.
    if (segment.fallback_playlist_id != null) {
      const items = await this.loadPlaylistAsItems(segment.fallback_playlist_id);
      const total = items.reduce((sum, i) => sum + i.duration_seconds, 0);
      return {
        items,
        total_duration_seconds: total,
        gap_estimate_seconds: Math.max(0, effectiveDuration - total),
      };
    }

    return emptyPool(effectiveDuration);
  }

  private async loadMediaAsItem(
    mediaId: number,
    position: number,
  ): Promise<RundownItem | null> {
    const [m] = await this.db
      .select({
        id: mediaTable.id,
        duration_seconds: mediaTable.duration_seconds,
        cue_in_seconds: mediaTable.cue_in_seconds,
        cue_out_seconds: mediaTable.cue_out_seconds,
      })
      .from(mediaTable)
      .where(eq(mediaTable.id, mediaId));
    if (!m) return null;
    return {
      id: m.id,
      media_id: m.id,
      position,
      duration_seconds: effectiveDuration(m),
    };
  }

  // Determines the next track in sequence by counting how many of this
  // playlist's tracks have already aired in this clock instance (Decision
  // 63's Rundown view, Decision 65) — replaces a cursor table
  // (`rundown_playback_cursors`) that was never written to anywhere in the
  // codebase, so show-content sequencing had always silently served the
  // same first track. `count % tracks.length` is the same modulo math the
  // dead cursor read used; only the source of the index changed, from a
  // phantom row to ground truth.
  private async nextFromShowContentPlaylist(
    playlistId: number,
    clockId: number,
    segmentType: ClockSegmentType,
    clockInstanceStartedAt: number,
  ): Promise<RundownItem | null> {
    const [playlist] = await this.db
      .select({ id: playlistsTable.id })
      .from(playlistsTable)
      .where(eq(playlistsTable.id, playlistId));
    if (!playlist) return null;

    const tracks = await this.db
      .select({
        media_id: playlistMediaTable.media_id,
        sort_order: playlistMediaTable.sort_order,
        duration_seconds: mediaTable.duration_seconds,
        cue_in_seconds: mediaTable.cue_in_seconds,
        cue_out_seconds: mediaTable.cue_out_seconds,
        media_pk: mediaTable.id,
      })
      .from(playlistMediaTable)
      .innerJoin(mediaTable, eq(playlistMediaTable.media_id, mediaTable.id))
      .where(eq(playlistMediaTable.playlist_id, playlistId));
    if (tracks.length === 0) return null;
    tracks.sort(
      (a, b) => a.sort_order - b.sort_order || a.media_id - b.media_id,
    );

    const mediaIds = tracks.map((t) => t.media_pk);
    const alreadyPlayed = await this.countShowContentPlays(
      clockId,
      segmentType,
      clockInstanceStartedAt,
      mediaIds,
    );
    const cursorIdx = alreadyPlayed % tracks.length;
    const track = tracks[cursorIdx];
    return {
      id: track.media_pk,
      media_id: track.media_pk,
      position: 0,
      duration_seconds: effectiveDuration(track),
    };
  }

  // Decision 63/65's Rundown view: counts how many of `mediaIds` have
  // already aired, scoped to this clock instance and segment type — i.e.
  // every news/bulletin segment of `segmentType` within the same clock hour
  // shares one sequence, matching the dead cursor's original
  // (clock_id, segment_type)-scoped intent. Counts any row regardless of
  // `aborted`: a cut-short rundown clip still occupied a sequence position.
  private async countShowContentPlays(
    clockId: number,
    segmentType: ClockSegmentType,
    clockInstanceStartedAt: number,
    mediaIds: number[],
  ): Promise<number> {
    if (mediaIds.length === 0) return 0;
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)`.as('n') })
      .from(playHistoryTable)
      .innerJoin(planItemsTable, eq(planItemsTable.id, playHistoryTable.plan_item_id))
      .innerJoin(plansTable, eq(plansTable.id, planItemsTable.plan_id))
      .innerJoin(clockSegments, eq(clockSegments.id, plansTable.segment_id))
      .where(
        and(
          eq(planItemsTable.content_type, 'rundown'),
          eq(plansTable.clock_instance_started_at, clockInstanceStartedAt),
          eq(clockSegments.clock_id, clockId),
          eq(clockSegments.type, segmentType),
          inArray(playHistoryTable.media_id, mediaIds),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  private async loadPlaylistAsItems(playlistId: number): Promise<RundownItem[]> {
    const rows = await this.db
      .select({
        sort_order: playlistMediaTable.sort_order,
        media_id: mediaTable.id,
        duration_seconds: mediaTable.duration_seconds,
        cue_in_seconds: mediaTable.cue_in_seconds,
        cue_out_seconds: mediaTable.cue_out_seconds,
      })
      .from(playlistMediaTable)
      .innerJoin(mediaTable, eq(playlistMediaTable.media_id, mediaTable.id))
      .where(eq(playlistMediaTable.playlist_id, playlistId));
    rows.sort((a, b) => a.sort_order - b.sort_order || a.media_id - b.media_id);
    return rows.map((r, idx) => ({
      id: r.media_id,
      media_id: r.media_id,
      position: idx,
      duration_seconds: effectiveDuration(r),
    }));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptyPool(segmentDuration: number): RundownCandidatePool {
  return {
    items: [],
    total_duration_seconds: 0,
    gap_estimate_seconds: segmentDuration,
  };
}

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
