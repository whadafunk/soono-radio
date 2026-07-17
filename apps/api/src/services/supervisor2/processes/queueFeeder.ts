// Queue Feeder — Phase 4.
//
// Two triggers keep the harbor queue populated:
//   - PUSH_NEXT_REQUESTED: emitted by the Supervisor on its 500ms tick (primary)
//   - LS_TRACK_ENDING:     LiquidSoap on_end webhook fired a few seconds before
//                          the current track ends (acceleration trigger)
//
// The pushInFlight guard prevents concurrent pushes when both fire close together.
//
// Zero decision logic (D42). The feeder reads the next pending item from the
// active plan and pushes it — falling back to the next (locked-in, not yet
// activated) plan once the active plan has nothing left, since activation
// now waits for the next plan's first item to actually start airing (D44).
// All fallback decisions (gap fill, early fire, plan extension) belong to
// the Supervisor. When there is nothing to push the feeder logs QUEUE_STALL
// and exits; the Supervisor's next tick resolves it.

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { SLogger } from '../supervisorLogger.js';

import { db as defaultDb } from '../../../db/index.js';
import {
  media as mediaTable,
  planItems as planItemsTable,
  playHistory as playHistoryTable,
  supervisorState as supervisorStateTable,
  type Media,
  type PlanItem,
} from '../../../db/schema.js';
import { lsMediaPathForSha } from '../../ingest/paths.js';
import { bus, type BusMessage } from '../bus.js';
import { HarborClient } from '../harborClient.js';
import { deleteFailedPushAttempt, insertPushed } from '../playHistoryService.js';

export class QueueFeederProcess {
  private readonly unsubscribers: Array<() => void> = [];
  // Tracks whether a live takeover is currently in effect. Updated by the
  // Supervisor via LIVE_STATUS_CHANGED so the Queue Feeder doesn't have to
  // share mutable state with another process module.
  private liveActive = false;
  // Prevents concurrent pushes when PUSH_NEXT_REQUESTED and LS_TRACK_ENDING
  // fire close together.
  private pushInFlight = false;
  // Rate-limit QUEUE_STALL: null means not stalling; set to the ms when stall
  // began. Only logs INFO on entry and exit; intermediate ticks log at DEBUG.
  private stallingSince: number | null = null;

  constructor(
    private readonly _bus: typeof bus,
    private readonly db: typeof defaultDb = defaultDb,
    private readonly logger: SLogger | null = null,
  ) {}

  start(): void {
    // Primary trigger: 500ms supervisor tick.
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'PUSH_NEXT_REQUESTED' }>('PUSH_NEXT_REQUESTED', (msg) => {
        void this.handlePushRequest(msg.reason).catch((err) => {
          this.logger?.error(
            { err, process: 'queueFeeder', event: 'HANDLER_FAILED', source: 'PUSH_NEXT_REQUESTED' },
            'queueFeeder: unhandled error in PUSH_NEXT_REQUESTED handler',
          );
        });
      }),
    );
    // Acceleration trigger: LiquidSoap on_end webhook, fires a few seconds
    // before the current track ends.
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'LS_TRACK_ENDING' }>('LS_TRACK_ENDING', (_msg) => {
        void this.handlePushRequest('ls_track_ending').catch((err) => {
          this.logger?.error(
            { err, process: 'queueFeeder', event: 'HANDLER_FAILED', source: 'LS_TRACK_ENDING' },
            'queueFeeder: unhandled error in LS_TRACK_ENDING handler',
          );
        });
      }),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'LIVE_STATUS_CHANGED' }>(
        'LIVE_STATUS_CHANGED',
        (msg) => {
          this.liveActive = msg.active;
          this.logger?.info(
            { process: 'queueFeeder', event: 'LIVE_STATUS_CHANGED', active: msg.active },
            'queueFeeder: live status updated',
          );
        },
      ),
    );
  }

  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }

  // Test/inspection helpers — not part of the bus protocol.
  isLiveActive(): boolean {
    return this.liveActive;
  }

  private async handlePushRequest(source: string): Promise<void> {
    if (this.liveActive || this.pushInFlight) {
      if (this.liveActive) {
        this.logger?.info(
          { process: 'queueFeeder', event: 'PUSH_SUPPRESSED', reason: 'live_takeover', source },
          'queueFeeder: skipping push, live takeover active',
        );
      }
      return;
    }
    this.pushInFlight = true;
    try {
      await this.doPush(source);
    } finally {
      this.pushInFlight = false;
    }
  }

  private async doPush(source: string): Promise<void> {
    const state = await this.loadSupervisorState();
    const activePlanId = state?.active_plan_id ?? null;
    const nextPlanId = state?.next_plan_id ?? null;

    if (activePlanId == null && nextPlanId == null) {
      this.emitStall('no_active_plan', null, source);
      return;
    }

    // Queue-depth cap: at most 1 playing + 1 pre-queued, in the PHYSICAL
    // LiquidSoap queue. Decision 88: ask LiquidSoap's real queue via
    // /now-playing instead of counting our own plan_items.status='playing'
    // rows — that count is a shadow belief (items flip to 'playing' at push
    // time in our DB, not at LS's actual on-air moment) that can silently
    // desync from what's really queued. Falls back to the DB count only if
    // the harbor call itself fails (e.g. a transient network hiccup) — this
    // is a hot path and shouldn't hard-fail the whole push on one bad call.
    let physicalQueueDepth: number | null = null;
    try {
      const nowPlaying = await HarborClient.getNowPlaying();
      physicalQueueDepth = nowPlaying.queue_depth + (nowPlaying.current != null ? 1 : 0);
    } catch (err) {
      this.logger?.warn({ process: 'queueFeeder', event: 'NOW_PLAYING_CHECK_FAILED', err: String(err) }, 'queueFeeder: /now-playing check failed, falling back to DB count for queue cap');
      const planIdsToCap = [activePlanId, nextPlanId].filter((id): id is number => id != null);
      if (planIdsToCap.length > 0) {
        // Count only 'playing' rows that can PLAUSIBLY still occupy the
        // physical queue: play_history open, and either not yet confirmed
        // (queued, waiting to start) or confirmed with the clock still
        // inside its planned duration + grace. A row stuck at 'playing'
        // forever (an unclosed diary entry from a past incident) would
        // otherwise read as "queue full" for the rest of time — wedging the
        // feeder into silence exactly while LS is already unreachable, the
        // only time this fallback runs.
        const rows = await this.db
          .select({
            planned_duration_seconds: planItemsTable.planned_duration_seconds,
            ph_started_at: playHistoryTable.started_at,
            ph_ended_at: playHistoryTable.ended_at,
            ph_confirmed: playHistoryTable.confirmed,
          })
          .from(planItemsTable)
          .leftJoin(playHistoryTable, eq(playHistoryTable.id, planItemsTable.play_history_id))
          .where(and(inArray(planItemsTable.plan_id, planIdsToCap), eq(planItemsTable.status, 'playing')));
        const nowMs = Date.now();
        const STALE_GRACE_MS = 120_000;
        physicalQueueDepth = rows.filter((r) => {
          if (r.ph_started_at == null) return false; // no play_history at all — corrupt link, can't be queued
          if (r.ph_ended_at != null) return false; // already finished
          if (!r.ph_confirmed) return true; // pushed, not yet started — occupies a queue slot
          const startedMs = new Date(r.ph_started_at).getTime();
          return nowMs < startedMs + (r.planned_duration_seconds ?? 0) * 1_000 + STALE_GRACE_MS;
        }).length;
      }
    }
    if (physicalQueueDepth != null && physicalQueueDepth >= 2) {
      this.logger?.debug(
        { process: 'queueFeeder', event: 'PUSH_SKIPPED', reason: 'queue_full', physical_queue_depth: physicalQueueDepth, source },
        'queueFeeder: queue full, skipping push',
      );
      return;
    }

    // Prefer the active plan; fall back to the next (locked-in, not yet
    // activated) plan once the active plan has nothing left to give. This is
    // what keeps the queue fed across a plan transition now that activation
    // waits for the next plan's first item to actually start airing (D44) —
    // the active plan can run dry for a while before that happens.
    let nextItem = activePlanId != null ? await this.findNextPendingItem(activePlanId) : null;
    let pushPlanId = activePlanId;
    if (!nextItem && nextPlanId != null) {
      nextItem = await this.findNextPendingItem(nextPlanId);
      pushPlanId = nextPlanId;
    }
    if (!nextItem) {
      this.emitStall('no_pending_items', activePlanId, source);
      return;
    }

    // Stall resolved — log exit if we were stalling.
    if (this.stallingSince != null) {
      const stalledSeconds = (Date.now() - this.stallingSince) / 1000;
      this.logger?.info(
        { process: 'queueFeeder', event: 'QUEUE_STALL', stall_phase: 'exit', stalled_seconds: Math.round(stalledSeconds), plan_id: pushPlanId, source },
        'queueFeeder: stall resolved — found pending item',
      );
      this.stallingSince = null;
    }

    const mediaRow = await this.loadMedia(nextItem.media_id);
    if (!mediaRow) {
      this.logger?.error(
        {
          process: 'queueFeeder',
          event: 'PUSH_ERROR',
          plan_item_id: nextItem.id,
          media_id: nextItem.media_id,
        },
        'queueFeeder: media row missing for plan_item, dropping item',
      );
      await this.markPlanItemDropped(nextItem.id);
      return;
    }

    await this.pushPlanItem(nextItem, mediaRow);
  }

  // Logs QUEUE_STALL at INFO on entry; at DEBUG on subsequent ticks.
  private emitStall(reason: string, planId: number | null, source: string): void {
    if (this.stallingSince == null) {
      this.stallingSince = Date.now();
      this.logger?.info(
        { process: 'queueFeeder', event: 'QUEUE_STALL', stall_phase: 'entry', reason, plan_id: planId, source },
        'queueFeeder: stall started',
      );
    } else {
      this.logger?.debug(
        { process: 'queueFeeder', event: 'QUEUE_STALL', stall_phase: 'ongoing', reason, plan_id: planId, source },
        'queueFeeder: stall ongoing',
      );
    }
  }

  private async pushPlanItem(item: PlanItem, mediaRow: Media): Promise<void> {
    const pushedAtMs = Date.now();
    const playHistoryId = await insertPushed(this.db, {
      media_id: mediaRow.id,
      source: 'auto',
      plan_item_id: item.id,
      campaign_id: item.campaign_id ?? null,
      music_campaign_id: item.music_campaign_id ?? null,
      pushed_at_ms: pushedAtMs,
      pick_reason: item.reason,
    });

    const annotated = buildAnnotatedUri(mediaRow, {
      play_history_id: playHistoryId,
      plan_item_id: item.id,
    });

    try {
      await HarborClient.push(annotated);
    } catch (err) {
      // Harbor unavailable (LS not yet running, network error, etc.).
      // Leave the plan_item as 'pending' so it will be retried on the
      // next push trigger. Dropping it would inflate consumedSeconds with
      // 0-airtime content and trigger a runaway coasting replan spiral.
      //
      // But the play_history row created above was never linked to the
      // plan_item (that link only happens after a successful push, below)
      // and never represented a real play — left in place it would sit
      // forever as an unconfirmed, never-closed row that recent_plays and
      // the rotation/separation-window queries in music.ts/campaign.ts
      // still read unfiltered, making a failed attempt look like the track
      // actually aired. Clean it up so only a real push ever leaves a trace.
      await deleteFailedPushAttempt(this.db, playHistoryId);
      this.logger?.error(
        {
          err,
          process: 'queueFeeder',
          event: 'PUSH_ERROR',
          plan_item_id: item.id,
          play_history_id: playHistoryId,
          note: 'item left pending for retry',
        },
        'queueFeeder: harbor push failed — item kept pending for retry',
      );
      return;
    }

    await this.db
      .update(planItemsTable)
      .set({ status: 'playing', play_history_id: playHistoryId })
      .where(eq(planItemsTable.id, item.id));

    this.logger?.info(
      {
        process: 'queueFeeder',
        event: 'PUSH_SENT',
        plan_id: item.plan_id,
        plan_item_id: item.id,
        play_history_id: playHistoryId,
        media_id: mediaRow.id,
        content_type: item.content_type,
        title: mediaRow.title ?? mediaRow.original_filename,
        artist: mediaRow.artist ?? null,
        reason: item.reason,
      },
      'queueFeeder: push sent',
    );

    // Notify the Supervisor so it can reset its silence-alert timer.
    this._bus.emit({ type: 'PUSH_SENT', plan_item_id: item.id, play_history_id: playHistoryId });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async loadSupervisorState(): Promise<{ active_plan_id: number | null; next_plan_id: number | null } | null> {
    const [row] = await this.db
      .select({
        active_plan_id: supervisorStateTable.active_plan_id,
        next_plan_id: supervisorStateTable.next_plan_id,
      })
      .from(supervisorStateTable)
      .where(eq(supervisorStateTable.id, 1));
    return row ?? null;
  }

  private async findNextPendingItem(planId: number): Promise<PlanItem | null> {
    const rows = await this.db
      .select()
      .from(planItemsTable)
      .where(
        and(eq(planItemsTable.plan_id, planId), eq(planItemsTable.status, 'pending')),
      )
      .orderBy(asc(planItemsTable.position))
      .limit(1);
    return rows[0] ?? null;
  }

  private async loadMedia(mediaId: number): Promise<Media | null> {
    const [row] = await this.db
      .select()
      .from(mediaTable)
      .where(eq(mediaTable.id, mediaId));
    return row ?? null;
  }

  private async markPlanItemDropped(itemId: number): Promise<void> {
    await this.db
      .update(planItemsTable)
      .set({ status: 'dropped' })
      .where(eq(planItemsTable.id, itemId));
  }
}

// Build an annotate: URI for LiquidSoap. The annotations are surfaced back to
// us in the on_track / on_end webhooks so we can correlate the playing audio
// to the play_history row that triggered it.
function buildAnnotatedUri(
  mediaRow: Media,
  extras: { play_history_id: number; plan_item_id: number },
): string {
  const filePath = lsMediaPathForSha(mediaRow.sha256);
  const annotations: string[] = [];
  annotations.push(`play_history_id="${extras.play_history_id}"`);
  annotations.push(`plan_item_id="${extras.plan_item_id}"`);
  const title = mediaRow.title ?? mediaRow.original_filename;
  annotations.push(`title=${JSON.stringify(title)}`);
  if (mediaRow.artist) {
    annotations.push(`artist=${JSON.stringify(mediaRow.artist)}`);
  }
  return `annotate:${annotations.join(',')}:${filePath}`;
}
