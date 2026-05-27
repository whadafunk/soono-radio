// Queue Feeder — Phase 4.
//
// Triggered by the LS_TRACK_ENDING bus event, which originates from the
// LiquidSoap `on_end` webhook a few seconds before the current track ends.
// The Queue Feeder reads the next pending plan_item from the active plan,
// writes a play_history row, and pushes an annotated URI to the LS harbor.
//
// The Queue Feeder is intentionally dumb: it has no opinions about pacing,
// drift, or scheduling. It executes the plan the Supervisor / Planner laid
// out. The only fallback is the safety fill — if the plan is exhausted or
// missing, push a random music track so the station doesn't go silent.
//
// During live takeover the Supervisor emits LIVE_STATUS_CHANGED with
// active=true; the Queue Feeder remembers this and stops pushing until the
// matching active=false message arrives.

import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { db as defaultDb } from '../../../db/index.js';
import {
  media as mediaTable,
  planItems as planItemsTable,
  supervisorState as supervisorStateTable,
  type Media,
  type PlanItem,
} from '../../../db/schema.js';
import { mediaPathForSha } from '../../ingest/paths.js';
import { bus, type BusMessage } from '../bus.js';
import { HarborClient } from '../harborClient.js';
import { insertPushed } from '../playHistoryService.js';

export class QueueFeederProcess {
  private readonly unsubscribers: Array<() => void> = [];
  // Tracks whether a live takeover is currently in effect. Updated by the
  // Supervisor via LIVE_STATUS_CHANGED so the Queue Feeder doesn't have to
  // share mutable state with another process module.
  private liveActive = false;

  constructor(
    private readonly _bus: typeof bus,
    private readonly db: typeof defaultDb = defaultDb,
    private readonly logger: FastifyBaseLogger | null = null,
  ) {}

  start(): void {
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'LS_TRACK_ENDING' }>('LS_TRACK_ENDING', (msg) => {
        void this.handleTrackEnding(msg).catch((err) => {
          this.logger?.error(
            { err, process: 'queueFeeder', event: 'HANDLER_FAILED' },
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

  private async handleTrackEnding(
    _msg: BusMessage & { type: 'LS_TRACK_ENDING' },
  ): Promise<void> {
    if (this.liveActive) {
      this.logger?.info(
        { process: 'queueFeeder', event: 'PUSH_SUPPRESSED', reason: 'live_takeover' },
        'queueFeeder: skipping push, live takeover active',
      );
      return;
    }

    const state = await this.loadSupervisorState();
    const activePlanId = state?.active_plan_id ?? null;

    if (activePlanId == null) {
      await this.safetyFill('no_active_plan');
      return;
    }

    const nextItem = await this.findNextPendingItem(activePlanId);
    if (!nextItem) {
      await this.safetyFill('plan_exhausted', activePlanId);
      return;
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
        'queueFeeder: media row missing for plan_item; falling back to safety fill',
      );
      await this.markPlanItemDropped(nextItem.id);
      await this.safetyFill('media_missing', activePlanId);
      return;
    }

    await this.pushPlanItem(nextItem, mediaRow);
  }

  // ─── Active-plan path ───────────────────────────────────────────────────────

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
      this.logger?.error(
        {
          err,
          process: 'queueFeeder',
          event: 'PUSH_ERROR',
          plan_item_id: item.id,
          play_history_id: playHistoryId,
        },
        'queueFeeder: harbor push failed',
      );
      // Mark the item dropped so we don't loop on the same broken row.
      await this.markPlanItemDropped(item.id);
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
        reason: item.reason,
      },
      'queueFeeder: push sent',
    );
  }

  // ─── Safety fill path ───────────────────────────────────────────────────────

  // Picks a random music media row and pushes it. Used when there is no
  // active plan or the plan is exhausted. No plan_item_id is attached.
  private async safetyFill(reason: string, planId: number | null = null): Promise<void> {
    const mediaRow = await this.pickRandomMusic();
    if (!mediaRow) {
      this.logger?.error(
        { process: 'queueFeeder', event: 'EMERGENCY_FILL_FAILED', reason },
        'queueFeeder: no music media available for safety fill',
      );
      return;
    }

    const pushedAtMs = Date.now();
    const playHistoryId = await insertPushed(this.db, {
      media_id: mediaRow.id,
      source: 'auto',
      plan_item_id: null,
      campaign_id: null,
      music_campaign_id: null,
      pushed_at_ms: pushedAtMs,
      pick_reason: `emergency fill (${reason})`,
    });

    const annotated = buildAnnotatedUri(mediaRow, {
      play_history_id: playHistoryId,
      emergency_fill: true,
    });

    try {
      await HarborClient.push(annotated);
    } catch (err) {
      this.logger?.error(
        {
          err,
          process: 'queueFeeder',
          event: 'PUSH_ERROR',
          play_history_id: playHistoryId,
          reason: 'emergency_fill_push_failed',
        },
        'queueFeeder: harbor push failed during safety fill',
      );
      return;
    }

    this.logger?.info(
      {
        process: 'queueFeeder',
        event: 'EMERGENCY_FILL',
        play_history_id: playHistoryId,
        media_id: mediaRow.id,
        plan_id: planId,
        reason,
      },
      'queueFeeder: emergency fill pushed',
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async loadSupervisorState(): Promise<{ active_plan_id: number | null } | null> {
    const [row] = await this.db
      .select({ active_plan_id: supervisorStateTable.active_plan_id })
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

  private async pickRandomMusic(): Promise<Media | null> {
    const rows = await this.db
      .select()
      .from(mediaTable)
      .where(eq(mediaTable.category, 'music'))
      .orderBy(sql`RANDOM()`)
      .limit(1);
    return rows[0] ?? null;
  }
}

// Build an annotate: URI for LiquidSoap. The annotations are surfaced back to
// us in the on_track / on_end webhooks so we can correlate the playing audio
// to the play_history row that triggered it.
function buildAnnotatedUri(
  mediaRow: Media,
  extras: { play_history_id: number; plan_item_id?: number; emergency_fill?: boolean },
): string {
  const filePath = mediaPathForSha(mediaRow.sha256);
  const annotations: string[] = [];
  annotations.push(`play_history_id="${extras.play_history_id}"`);
  if (extras.plan_item_id != null) {
    annotations.push(`plan_item_id="${extras.plan_item_id}"`);
  }
  if (extras.emergency_fill) {
    annotations.push('emergency_fill="true"');
  }
  const title = mediaRow.title ?? mediaRow.original_filename;
  annotations.push(`title=${JSON.stringify(title)}`);
  if (mediaRow.artist) {
    annotations.push(`artist=${JSON.stringify(mediaRow.artist)}`);
  }
  return `annotate:${annotations.join(',')}:${filePath}`;
}
