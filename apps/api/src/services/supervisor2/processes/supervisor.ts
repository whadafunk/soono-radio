// Supervisor — Phase 4.
//
// Central orchestration hub. Receives every LiquidSoap webhook event, drives
// the Planner at segment boundaries, accumulates drift, applies drift
// correction via catching_up_order / coasting_order, and manages live
// takeover. Owns the `supervisor_state` row (id=1) for crash-resilient
// runtime state.
//
// Design references:
//   Decision 17 — Supervisor as central hub; Deviation Monitor folded in.
//   Decision 19 — Live is a Supervisor state event, not a content process.
//   Decision 20 — Drift correction framework (catching_up_order / coasting_order).
//   Decision 21 — Queue Feeder is the cut-short executor; Supervisor calls skip.
//   Decision 27 — DRIFT_EVENT_TYPES vocabulary.

import { randomUUID } from 'crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { db as defaultDb } from '../../../db/index.js';
import {
  liveEvents as liveEventsTable,
  planItems as planItemsTable,
  plans as plansTable,
  supervisorState as supervisorStateTable,
  type PlanItem,
  type PlanItemContentType,
} from '../../../db/schema.js';
import type { DriftEventType } from '@radio/shared';
import { bus, type BusMessage } from '../bus.js';
import { HarborClient } from '../harborClient.js';
import { resolveCurrentSegment, type ResolvedSegment } from '../clockResolver.js';
import {
  closeMostRecentOpenRow,
  closeOpenRowsBefore,
  closeRow,
  stampStarted,
} from '../playHistoryService.js';
import { playHistory as playHistoryTable } from '../../../db/schema.js';

// How far ahead of the segment boundary we trigger finalization.
const FINALIZATION_LEAD_SECONDS = 60;
// Drift thresholds (Decision 20).
const DRIFT_CORRECTION_THRESHOLD_SECONDS = 10;
const COASTING_CORRECTION_THRESHOLD_SECONDS = 5;
// Safety-net heartbeat period.
const SAFETY_NET_INTERVAL_MS = 30_000;

// Maps DriftEventType vocabulary to the plan_items.content_type values used
// when filtering items for catching_up_order skipping.
const DRIFT_TYPE_TO_CONTENT_TYPES: Record<DriftEventType, PlanItemContentType[]> = {
  songs: ['music'],
  jingles: ['jingle', 'branding'],
  station_ids: ['station_id', 'branding'],
  spots: ['campaign'],
  promos: ['promo'],
};

export class SupervisorProcess {
  private readonly unsubscribers: Array<() => void> = [];
  private safetyNetTimer: NodeJS.Timeout | null = null;

  // In-memory state. The DB still holds the durable copy; these are caches
  // populated on first read and kept current on each event.
  private currentSegmentId: number | null = null;
  private currentSegmentEndMs: number | null = null;
  private currentClockInstanceMs: number | null = null;
  private currentDriftSeconds = 0;
  private activePlanId: number | null = null;
  // Plan currently being prepared for the *next* segment. Tracks which
  // segment instance we have already drafted so we don't double-draft.
  private draftedForSegmentInstance: { segmentId: number; instanceMs: number } | null =
    null;
  // Set after we have emitted PLAN_FINALIZE_REQUESTED for the active plan.
  private finalizedForPlanId: number | null = null;
  // Currently-playing play_history row, used by drift skip logic to decide
  // whether to call HarborClient.skip() (only when the offender is on air).
  private currentPlayHistoryId: number | null = null;
  // Live takeover state — also written to the bus so the Queue Feeder
  // suppresses pushes.
  private liveTakeoverActive = false;
  private liveTakeoverRowId: number | null = null;
  // Bookkeeping for replan request_ids so we can correlate PLAN_REPLANNED
  // responses with the segment they were issued for.
  private pendingReplanForPlanId: number | null = null;

  constructor(
    private readonly _bus: typeof bus,
    private readonly db: typeof defaultDb = defaultDb,
    private readonly logger: FastifyBaseLogger | null = null,
  ) {}

  start(): void {
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'LS_TRACK_STARTED' }>('LS_TRACK_STARTED', (msg) => {
        void this.handleTrackStarted(msg).catch((err) => {
          this.logger?.error(
            { err, process: 'supervisor', event: 'HANDLER_FAILED', source: 'LS_TRACK_STARTED' },
            'supervisor: LS_TRACK_STARTED handler failed',
          );
        });
      }),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'LS_TRACK_ENDING' }>('LS_TRACK_ENDING', (msg) => {
        void this.handleTrackEnding(msg).catch((err) => {
          this.logger?.error(
            { err, process: 'supervisor', event: 'HANDLER_FAILED', source: 'LS_TRACK_ENDING' },
            'supervisor: LS_TRACK_ENDING handler failed',
          );
        });
      }),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'LS_LIVE_STARTED' }>('LS_LIVE_STARTED', (msg) => {
        void this.handleLiveStarted(msg).catch((err) => {
          this.logger?.error(
            { err, process: 'supervisor', event: 'HANDLER_FAILED', source: 'LS_LIVE_STARTED' },
            'supervisor: LS_LIVE_STARTED handler failed',
          );
        });
      }),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'LS_LIVE_ENDED' }>('LS_LIVE_ENDED', (msg) => {
        void this.handleLiveEnded(msg).catch((err) => {
          this.logger?.error(
            { err, process: 'supervisor', event: 'HANDLER_FAILED', source: 'LS_LIVE_ENDED' },
            'supervisor: LS_LIVE_ENDED handler failed',
          );
        });
      }),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'PLAN_DRAFT_READY' }>('PLAN_DRAFT_READY', (msg) => {
        this.logger?.info(
          {
            process: 'supervisor',
            event: 'PLAN_DRAFT_READY_OBSERVED',
            plan_id: msg.plan_id,
            segment_id: msg.segment_id,
          },
          'supervisor: planner produced draft plan',
        );
      }),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'PLAN_FINALIZED' }>('PLAN_FINALIZED', (msg) => {
        void this.handlePlanFinalized(msg).catch((err) => {
          this.logger?.error(
            { err, process: 'supervisor', event: 'HANDLER_FAILED', source: 'PLAN_FINALIZED' },
            'supervisor: PLAN_FINALIZED handler failed',
          );
        });
      }),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'PLAN_REPLANNED' }>('PLAN_REPLANNED', (msg) => {
        this.logger?.info(
          {
            process: 'supervisor',
            event: 'PLAN_REPLANNED_OBSERVED',
            plan_id: msg.plan_id,
          },
          'supervisor: planner returned replan',
        );
        if (this.pendingReplanForPlanId === msg.plan_id) {
          this.pendingReplanForPlanId = null;
        }
      }),
    );

    // Hydrate from supervisor_state on boot. Best-effort — if the DB read
    // fails we keep the in-memory defaults.
    void this.hydrateFromDb();

    // Safety-net heartbeat.
    this.safetyNetTimer = setInterval(() => {
      void this.safetyNetTick().catch((err) => {
        this.logger?.error(
          { err, process: 'supervisor', event: 'SAFETY_NET_FAILED' },
          'supervisor: safety net tick failed',
        );
      });
    }, SAFETY_NET_INTERVAL_MS);
  }

  stop(): void {
    if (this.safetyNetTimer) {
      clearInterval(this.safetyNetTimer);
      this.safetyNetTimer = null;
    }
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }

  // Inspection helpers (used by tests / status endpoints later).
  getCurrentDriftSeconds(): number {
    return this.currentDriftSeconds;
  }
  getActivePlanId(): number | null {
    return this.activePlanId;
  }
  isLiveTakeoverActive(): boolean {
    return this.liveTakeoverActive;
  }

  // ─── Hydration ──────────────────────────────────────────────────────────────

  private async hydrateFromDb(): Promise<void> {
    try {
      const [row] = await this.db
        .select()
        .from(supervisorStateTable)
        .where(eq(supervisorStateTable.id, 1));
      if (!row) return;
      this.currentSegmentId = row.current_segment_id ?? null;
      this.currentDriftSeconds = row.current_drift_seconds ?? 0;
      this.activePlanId = row.active_plan_id ?? null;
    } catch (err) {
      this.logger?.error(
        { err, process: 'supervisor', event: 'HYDRATE_FAILED' },
        'supervisor: failed to hydrate state from DB',
      );
    }
  }

  // ─── LS_TRACK_STARTED ───────────────────────────────────────────────────────

  private async handleTrackStarted(
    msg: BusMessage & { type: 'LS_TRACK_STARTED' },
  ): Promise<void> {
    const nowMs = Date.now();
    const onAirMs = Math.floor(msg.on_air_timestamp * 1000);

    // (1) Stamp started_at + close any previously-open play_history row.
    let currentPhid = msg.play_history_id;
    if (currentPhid == null) {
      // Try to recover the id from the annotated URI metadata.
      const fromMeta = parsePhidFromMetadata(msg.metadata);
      if (fromMeta != null) currentPhid = fromMeta;
    }

    if (currentPhid != null) {
      try {
        await stampStarted(this.db, currentPhid, onAirMs);
        await closeOpenRowsBefore(this.db, currentPhid, onAirMs);
      } catch (err) {
        this.logger?.error(
          { err, process: 'supervisor', event: 'PLAY_HISTORY_STAMP_FAILED', play_history_id: currentPhid },
          'supervisor: failed to stamp/close play_history',
        );
      }
      this.currentPlayHistoryId = currentPhid;
    } else {
      // Untagged play — close whatever was previously open so it doesn't
      // hang forever, then leave currentPlayHistoryId null.
      const closed = await closeMostRecentOpenRow(this.db, onAirMs).catch(() => null);
      this.currentPlayHistoryId = null;
      if (closed != null) {
        this.logger?.info(
          { process: 'supervisor', event: 'PLAY_HISTORY_CLOSE_FALLBACK', closed_id: closed },
          'supervisor: closed open play_history without phid match',
        );
      }
    }

    // (2) Heartbeat.
    await this.updateHeartbeat(nowMs);

    // (3) Drift update — only meaningful when the started track has a
    //     plan_item we can compare against the planned start time.
    if (currentPhid != null) {
      await this.updateDriftFromPlayHistory(currentPhid, msg.on_air_timestamp);
    }

    // (4) Segment boundary check.
    await this.maybeAdvanceSegmentState(nowMs);

    // (5) Finalization check — if the active plan is still in draft status
    //     and the boundary is within the finalization window.
    await this.maybeFinalize(nowMs);

    // (6) Drift correction decisions.
    await this.maybeApplyDriftCorrection(nowMs);
  }

  // ─── LS_TRACK_ENDING ────────────────────────────────────────────────────────

  private async handleTrackEnding(
    _msg: BusMessage & { type: 'LS_TRACK_ENDING' },
  ): Promise<void> {
    await this.updateHeartbeat(Date.now());
    // Queue Feeder handles the push. No further work in the Supervisor.
  }

  // ─── Live takeover ──────────────────────────────────────────────────────────

  private async handleLiveStarted(
    msg: BusMessage & { type: 'LS_LIVE_STARTED' },
  ): Promise<void> {
    this.liveTakeoverActive = true;
    const nowMs = Date.now();
    const [inserted] = await this.db
      .insert(liveEventsTable)
      .values({
        started_at: nowMs,
        ended_at: null,
        segment_id: this.currentSegmentId,
        plan_id: this.activePlanId,
      })
      .returning({ id: liveEventsTable.id });
    this.liveTakeoverRowId = inserted?.id ?? null;
    this._bus.emit({ type: 'LIVE_STATUS_CHANGED', active: true });
    this.logger?.info(
      {
        process: 'supervisor',
        event: 'LIVE_TAKEOVER_STARTED',
        source_name: msg.source_name,
        segment_id: this.currentSegmentId,
        plan_id: this.activePlanId,
        live_event_id: this.liveTakeoverRowId,
      },
      'supervisor: live takeover started',
    );
  }

  private async handleLiveEnded(
    msg: BusMessage & { type: 'LS_LIVE_ENDED' },
  ): Promise<void> {
    this.liveTakeoverActive = false;
    const nowMs = Date.now();
    let elapsedSeconds = 0;
    if (this.liveTakeoverRowId != null) {
      const [row] = await this.db
        .select({ started_at: liveEventsTable.started_at })
        .from(liveEventsTable)
        .where(eq(liveEventsTable.id, this.liveTakeoverRowId));
      if (row?.started_at != null) {
        elapsedSeconds = (nowMs - row.started_at) / 1000;
      }
      await this.db
        .update(liveEventsTable)
        .set({ ended_at: nowMs })
        .where(eq(liveEventsTable.id, this.liveTakeoverRowId));
      this.liveTakeoverRowId = null;
    }
    this._bus.emit({ type: 'LIVE_STATUS_CHANGED', active: false });

    // Replan the remaining segment if we have one and there's meaningful
    // time left to fill. Threshold matches the design's 30-second rule.
    if (this.activePlanId != null && this.currentSegmentEndMs != null) {
      const remainingMs = this.currentSegmentEndMs - nowMs;
      if (remainingMs > 30_000) {
        const fromPosition = await this.firstPendingPosition(this.activePlanId);
        const requestId = randomUUID();
        this.pendingReplanForPlanId = this.activePlanId;
        this._bus.emit({
          type: 'PLAN_REPLAN_REQUESTED',
          request_id: requestId,
          plan_id: this.activePlanId,
          from_position: fromPosition,
          remaining_seconds: Math.floor(remainingMs / 1000),
          now_ms: nowMs,
        });
      }
    }

    this.logger?.info(
      {
        process: 'supervisor',
        event: 'LIVE_TAKEOVER_ENDED',
        source_name: msg.source_name,
        elapsed_seconds: elapsedSeconds,
      },
      'supervisor: live takeover ended',
    );
  }

  // ─── Planner responses ──────────────────────────────────────────────────────

  private async handlePlanFinalized(
    msg: BusMessage & { type: 'PLAN_FINALIZED' },
  ): Promise<void> {
    // Promote the finalized plan to active when it covers the *next* segment
    // boundary. The plan was created with status='draft' by the Planner and
    // is now status='finalized'. We set status='active' and update
    // supervisor_state.active_plan_id so the Queue Feeder picks from it.
    const [plan] = await this.db
      .select()
      .from(plansTable)
      .where(eq(plansTable.id, msg.plan_id));
    if (!plan) return;

    await this.db
      .update(plansTable)
      .set({ status: 'active' })
      .where(eq(plansTable.id, msg.plan_id));

    this.activePlanId = msg.plan_id;
    await this.db
      .update(supervisorStateTable)
      .set({ active_plan_id: msg.plan_id })
      .where(eq(supervisorStateTable.id, 1));

    this.logger?.info(
      {
        process: 'supervisor',
        event: 'PLAN_ACTIVATED',
        plan_id: msg.plan_id,
        segment_id: plan.segment_id,
      },
      'supervisor: finalized plan promoted to active',
    );
  }

  // ─── Segment boundary handling ──────────────────────────────────────────────

  // Whenever we observe a new track start, we may have crossed into a new
  // segment. If so, we request a draft plan for that segment from the Planner.
  private async maybeAdvanceSegmentState(nowMs: number): Promise<void> {
    const resolved = await resolveCurrentSegment(nowMs, this.db);
    if (!resolved) return;

    const becameNewSegment = this.currentSegmentId !== resolved.segment.id;
    this.currentSegmentEndMs = resolved.segmentEndMs;
    this.currentClockInstanceMs = resolved.clockInstanceStartedAt;

    if (becameNewSegment) {
      const previousId = this.currentSegmentId;
      this.currentSegmentId = resolved.segment.id;
      await this.db
        .update(supervisorStateTable)
        .set({ current_segment_id: resolved.segment.id })
        .where(eq(supervisorStateTable.id, 1));

      this.logger?.info(
        {
          process: 'supervisor',
          event: 'SEGMENT_START',
          segment_id: resolved.segment.id,
          previous_segment_id: previousId,
          segment_type: resolved.segment.type,
          clock_id: resolved.clock_id,
          clock_instance_started_at: resolved.clockInstanceStartedAt,
        },
        'supervisor: segment boundary crossed',
      );

      await this.requestDraftForSegment(resolved, nowMs);
    }
  }

  private async requestDraftForSegment(
    resolved: ResolvedSegment,
    nowMs: number,
  ): Promise<void> {
    const key = {
      segmentId: resolved.segment.id,
      instanceMs: resolved.clockInstanceStartedAt,
    };
    if (
      this.draftedForSegmentInstance &&
      this.draftedForSegmentInstance.segmentId === key.segmentId &&
      this.draftedForSegmentInstance.instanceMs === key.instanceMs
    ) {
      return;
    }
    this.draftedForSegmentInstance = key;

    const driftAdjustment = -this.currentDriftSeconds;
    const targetDuration = Math.max(
      0,
      resolved.segment.duration_seconds + driftAdjustment,
    );
    const requestId = randomUUID();
    this.logger?.info(
      {
        process: 'supervisor',
        event: 'PLAN_DRAFT_REQUESTED',
        segment_id: resolved.segment.id,
        target_duration_seconds: targetDuration,
        drift_adjustment_seconds: driftAdjustment,
        request_id: requestId,
      },
      'supervisor: requesting draft plan',
    );
    this._bus.emit({
      type: 'PLAN_DRAFT_REQUESTED',
      request_id: requestId,
      segment_id: resolved.segment.id,
      clock_instance_started_at: resolved.clockInstanceStartedAt,
      target_duration_seconds: targetDuration,
      now_ms: nowMs,
    });
  }

  // Finalize the draft plan that covers the *current* segment when we are
  // close enough to the boundary, and the plan still has status='draft'.
  //
  // The active plan model the supervisor follows in Phase 4: a draft is
  // requested at segment start (above). The same draft becomes the active
  // plan after finalization, since Phase 4 plans only one segment ahead of
  // the queue feeder.
  private async maybeFinalize(nowMs: number): Promise<void> {
    if (this.currentSegmentId == null || this.currentSegmentEndMs == null) return;
    if (this.currentClockInstanceMs == null) return;

    // Find the draft plan for the current segment instance.
    const [draft] = await this.db
      .select()
      .from(plansTable)
      .where(
        and(
          eq(plansTable.segment_id, this.currentSegmentId),
          eq(plansTable.clock_instance_started_at, this.currentClockInstanceMs),
          eq(plansTable.status, 'draft'),
        ),
      );
    if (!draft) return;

    if (this.finalizedForPlanId === draft.id) return;
    if (nowMs < this.currentSegmentEndMs - FINALIZATION_LEAD_SECONDS * 1000) return;

    this.finalizedForPlanId = draft.id;
    const requestId = randomUUID();
    this.logger?.info(
      {
        process: 'supervisor',
        event: 'PLAN_FINALIZE_REQUESTED',
        plan_id: draft.id,
        segment_id: draft.segment_id,
        request_id: requestId,
      },
      'supervisor: requesting plan finalization',
    );
    this._bus.emit({
      type: 'PLAN_FINALIZE_REQUESTED',
      request_id: requestId,
      plan_id: draft.id,
      now_ms: nowMs,
    });
  }

  // ─── Drift accounting ───────────────────────────────────────────────────────

  // Compares the on-air timestamp of the just-started track against the plan's
  // expected start time for that item. Updates supervisor_state.
  private async updateDriftFromPlayHistory(
    playHistoryId: number,
    onAirSeconds: number,
  ): Promise<void> {
    const [phRow] = await this.db
      .select({ plan_item_id: playHistoryTable.plan_item_id })
      .from(playHistoryTable)
      .where(eq(playHistoryTable.id, playHistoryId));
    if (!phRow?.plan_item_id) return;

    const [planItem] = await this.db
      .select()
      .from(planItemsTable)
      .where(eq(planItemsTable.id, phRow.plan_item_id));
    if (!planItem) return;

    const [plan] = await this.db
      .select()
      .from(plansTable)
      .where(eq(plansTable.id, planItem.plan_id));
    if (!plan) return;

    // Sum planned durations of every prior item in this plan (by position).
    const priors = await this.db
      .select({
        position: planItemsTable.position,
        planned_duration_seconds: planItemsTable.planned_duration_seconds,
      })
      .from(planItemsTable)
      .where(eq(planItemsTable.plan_id, plan.id));
    let sumBefore = 0;
    for (const row of priors) {
      if (row.position < planItem.position) {
        sumBefore += row.planned_duration_seconds ?? 0;
      }
    }
    const expectedStartUnixSeconds =
      plan.clock_instance_started_at / 1000 + sumBefore;
    const driftSeconds = onAirSeconds - expectedStartUnixSeconds;

    this.currentDriftSeconds = driftSeconds;
    await this.db
      .update(supervisorStateTable)
      .set({ current_drift_seconds: driftSeconds })
      .where(eq(supervisorStateTable.id, 1));

    this.logger?.info(
      {
        process: 'supervisor',
        event: 'DRIFT_UPDATE',
        drift_seconds: driftSeconds,
        plan_item_id: planItem.id,
        plan_id: plan.id,
        segment_id: plan.segment_id,
      },
      'supervisor: drift updated',
    );
  }

  // ─── Drift correction ───────────────────────────────────────────────────────

  private async maybeApplyDriftCorrection(nowMs: number): Promise<void> {
    if (this.activePlanId == null || this.currentSegmentId == null) return;

    if (this.currentDriftSeconds > DRIFT_CORRECTION_THRESHOLD_SECONDS) {
      await this.correctRunningBehind(nowMs);
      return;
    }
    if (this.currentDriftSeconds < -COASTING_CORRECTION_THRESHOLD_SECONDS) {
      await this.correctRunningAhead(nowMs);
      return;
    }
  }

  // Walk catching_up_order on the current segment and skip pending plan_items
  // by content type until drift is absorbed.
  private async correctRunningBehind(nowMs: number): Promise<void> {
    const segment = await this.loadCurrentSegment();
    if (!segment) return;
    const order = parseDriftOrder(segment.catching_up_order);
    if (order.length === 0) return;

    const driftBefore = this.currentDriftSeconds;
    let remainingDrift = driftBefore;

    for (const type of order) {
      if (remainingDrift <= DRIFT_CORRECTION_THRESHOLD_SECONDS) break;
      const planItem = await this.findSkipCandidate(this.activePlanId!, type);
      if (!planItem) continue;
      if (planItem.mandatory) continue; // never skip mandatory items

      const isCurrentlyPlaying =
        this.currentPlayHistoryId != null &&
        planItem.play_history_id === this.currentPlayHistoryId;

      await this.db
        .update(planItemsTable)
        .set({ status: 'supervisor_skipped' })
        .where(eq(planItemsTable.id, planItem.id));

      if (isCurrentlyPlaying) {
        try {
          await HarborClient.skip();
        } catch (err) {
          this.logger?.error(
            { err, process: 'supervisor', event: 'HARBOR_SKIP_FAILED', plan_item_id: planItem.id },
            'supervisor: harbor skip failed',
          );
        }
      }

      remainingDrift -= planItem.planned_duration_seconds ?? 0;
      this.logger?.info(
        {
          process: 'supervisor',
          event: 'CORRECTION_SKIP',
          plan_item_id: planItem.id,
          content_type: planItem.content_type,
          drift_before_seconds: driftBefore,
          drift_after_seconds: remainingDrift,
          on_air: isCurrentlyPlaying,
        },
        'supervisor: correction skip applied',
      );
    }
    void nowMs;
  }

  // Running ahead — request a replan to inject filler. The Planner handles
  // the actual coasting_order content selection.
  private async correctRunningAhead(nowMs: number): Promise<void> {
    if (this.activePlanId == null) return;
    if (this.pendingReplanForPlanId === this.activePlanId) return; // already in flight

    const fromPosition = await this.firstPendingPosition(this.activePlanId);
    const baseRemainingSeconds =
      this.currentSegmentEndMs != null
        ? Math.max(0, Math.floor((this.currentSegmentEndMs - nowMs) / 1000))
        : 0;
    const targetRemainingSeconds =
      baseRemainingSeconds + Math.abs(this.currentDriftSeconds);
    const requestId = randomUUID();
    this.pendingReplanForPlanId = this.activePlanId;
    this._bus.emit({
      type: 'PLAN_REPLAN_REQUESTED',
      request_id: requestId,
      plan_id: this.activePlanId,
      from_position: fromPosition,
      remaining_seconds: Math.floor(targetRemainingSeconds),
      now_ms: nowMs,
    });
    this.logger?.info(
      {
        process: 'supervisor',
        event: 'CORRECTION_FILL',
        drift_seconds: this.currentDriftSeconds,
        plan_id: this.activePlanId,
        from_position: fromPosition,
        target_remaining_seconds: targetRemainingSeconds,
        request_id: requestId,
      },
      'supervisor: coasting correction replan requested',
    );
  }

  private async findSkipCandidate(
    planId: number,
    type: DriftEventType,
  ): Promise<PlanItem | null> {
    const contentTypes = DRIFT_TYPE_TO_CONTENT_TYPES[type];
    if (!contentTypes || contentTypes.length === 0) return null;
    // We look at status='pending' AND status='playing' so the Supervisor can
    // also pull the on-air item via skip(). dropping / supervisor_skipped /
    // played are not eligible.
    const rows = await this.db
      .select()
      .from(planItemsTable)
      .where(eq(planItemsTable.plan_id, planId))
      .orderBy(asc(planItemsTable.position));
    for (const row of rows) {
      if (row.status !== 'pending' && row.status !== 'playing') continue;
      if (row.mandatory) continue;
      if (!contentTypes.includes(row.content_type)) continue;
      return row;
    }
    return null;
  }

  private async loadCurrentSegment(): Promise<
    | {
        catching_up_order: unknown;
        coasting_order: unknown;
        id: number;
      }
    | null
  > {
    if (this.currentSegmentId == null) return null;
    // Lightweight read — we only need the two ordering columns.
    const resolved = await resolveCurrentSegment(Date.now(), this.db);
    if (!resolved) return null;
    if (resolved.segment.id !== this.currentSegmentId) return null;
    return {
      id: resolved.segment.id,
      catching_up_order: resolved.segment.catching_up_order,
      coasting_order: resolved.segment.coasting_order,
    };
  }

  private async firstPendingPosition(planId: number): Promise<number> {
    const [row] = await this.db
      .select({ position: planItemsTable.position })
      .from(planItemsTable)
      .where(
        and(eq(planItemsTable.plan_id, planId), eq(planItemsTable.status, 'pending')),
      )
      .orderBy(asc(planItemsTable.position))
      .limit(1);
    return row?.position ?? 0;
  }

  // ─── Safety net ─────────────────────────────────────────────────────────────

  private async safetyNetTick(): Promise<void> {
    if (this.liveTakeoverActive) return;
    try {
      const queue = await HarborClient.getQueue();
      if (queue.depth === 0) {
        this.logger?.warn(
          {
            process: 'supervisor',
            event: 'SAFETY_NET_TRIGGERED',
            queue_depth: queue.depth,
          },
          'supervisor: safety net detected empty queue',
        );
        // The Queue Feeder normally recovers on the next LS_TRACK_ENDING.
        // We don't push directly here — instead we lean on a fresh emit so
        // the QueueFeeder runs its handler off-track. This mirrors what the
        // LS on_end webhook would have produced.
        this._bus.emit({
          type: 'LS_TRACK_ENDING',
          remaining_seconds: 0,
          uri: '',
          play_history_id: null,
          metadata: { safety_net: 'true' },
        });
      }
    } catch (err) {
      // Harbor not reachable — log and move on.
      this.logger?.warn(
        { err, process: 'supervisor', event: 'SAFETY_NET_HARBOR_UNREACHABLE' },
        'supervisor: safety net could not reach harbor',
      );
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async updateHeartbeat(nowMs: number): Promise<void> {
    await this.db
      .update(supervisorStateTable)
      .set({ last_heartbeat_at: nowMs })
      .where(eq(supervisorStateTable.id, 1));
  }
}

// Pulls a play_history_id out of LS metadata when the webhook body didn't
// include it as a top-level field (e.g. the LS script chose to surface only
// title/artist).
function parsePhidFromMetadata(meta: Record<string, string>): number | null {
  const raw = meta['play_history_id'];
  if (typeof raw !== 'string' || raw === '') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function parseDriftOrder(raw: unknown): DriftEventType[] {
  const acceptable: DriftEventType[] = [
    'songs',
    'jingles',
    'station_ids',
    'spots',
    'promos',
  ];
  const out: DriftEventType[] = [];
  let arr: unknown = raw;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch {
      return out;
    }
  }
  if (!Array.isArray(arr)) return out;
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    if (acceptable.includes(v as DriftEventType)) {
      out.push(v as DriftEventType);
    }
  }
  return out;
}

