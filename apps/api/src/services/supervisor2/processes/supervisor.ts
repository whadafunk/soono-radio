// Supervisor — Phase 4 (clock-loop rewrite).
//
// Drives all scheduling proactively via a 500ms setInterval tick instead of
// relying solely on LiquidSoap webhooks. This eliminates the bootstrap
// deadlock (empty queue → no webhooks → no plan → empty queue).
//
// Two playheads are tracked each tick:
//   Calendar playhead: (nowMs - segmentStartMs) / 1000
//   Plan playhead:     sum of planned_duration_seconds for terminal items +
//                      elapsed time of the currently-playing item
//   Drift = calendarElapsed − planConsumed (positive = running late)
//
// Design references:
//   Decision 17 — Supervisor as central hub; Deviation Monitor folded in.
//   Decision 19 — Live is a Supervisor state event, not a content process.
//   Decision 20 — Drift correction framework (catching_up_order / coasting_order).
//   Decision 21 — Queue Feeder is the cut-short executor; Supervisor calls skip.
//   Decision 27 — DRIFT_EVENT_TYPES vocabulary.

import { randomUUID } from 'crypto';
import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { db as defaultDb } from '../../../db/index.js';
import {
  liveEvents as liveEventsTable,
  planItems as planItemsTable,
  plans as plansTable,
  playHistory as playHistoryTable,
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
  stampStarted,
} from '../playHistoryService.js';

// Drift thresholds (Decision 20).
const DRIFT_CORRECTION_THRESHOLD_SECONDS = 10;
// Coasting threshold deliberately high: a -5s baseline was triggering replans
// every few seconds when items were dropped (LS down on startup), creating a
// runaway 100+ item replan spiral. 30s gives real coasting time to stabilise.
const COASTING_CORRECTION_THRESHOLD_SECONDS = 30;

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
  private tickTimer: NodeJS.Timeout | null = null;

  // In-memory state. The DB still holds the durable copy; these are caches
  // populated on first read and kept current on each event.
  private currentSegmentId: number | null = null;
  private currentSegmentEndMs: number | null = null;
  private currentClockInstanceMs: number | null = null;
  private currentDriftSeconds = 0;
  // Timestamp when the active plan was activated (or when the supervisor last
  // restarted with an active plan). Used as the drift baseline so that
  // calendar lag from safety fills / restarts before the plan started does
  // not count as drift.
  private planActivatedAtMs = 0;
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
  // Paused flag — read from DB each tick so the control endpoint's writes
  // take effect immediately.
  private isPaused = false;

  // Segment cache — avoids a DB round-trip on every 500ms tick.
  private cachedSegment: ResolvedSegment | null = null;
  private cachedSegmentValidUntilMs = 0;

  // Heartbeat throttle — write at most once per 2.5s even though we tick at 500ms.
  private lastHeartbeatWriteMs = 0;
  private readonly TICK_INTERVAL_MS = 500;
  // How many milliseconds before expectedEndMs we emit PUSH_NEXT_REQUESTED.
  private readonly PUSH_LEAD_MS = 8_000;
  private readonly HEARTBEAT_WRITE_INTERVAL_MS = 2_500;

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
        void this.handlePlanDraftReady(msg).catch((err) => {
          this.logger?.error(
            { err, process: 'supervisor', event: 'HANDLER_FAILED', source: 'PLAN_DRAFT_READY' },
            'supervisor: PLAN_DRAFT_READY handler failed',
          );
        });
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

    // Start the clock loop — this is the primary driver of all scheduling.
    this.tickTimer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger?.error(
          { err, process: 'supervisor', event: 'TICK_FAILED' },
          'supervisor: clock tick failed',
        );
      });
    }, this.TICK_INTERVAL_MS);

    // Immediate first tick so we don't wait 500ms before the first check.
    void this.tick().catch((err) => {
      this.logger?.error(
        { err, process: 'supervisor', event: 'TICK_FAILED' },
        'supervisor: initial tick failed',
      );
    });
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
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
      this.activePlanId = row.active_plan_id ?? null;
      this.isPaused = row.paused ?? false;

      // On restart, set planActivatedAtMs so that drift starts near zero.
      // We compute how much content has already been consumed from the active
      // plan and back-date the baseline: planActivatedAtMs = now - consumed.
      // This avoids a massive false drift from items already played/skipped.
      if (this.activePlanId != null) {
        const items = await this.db
          .select({ status: planItemsTable.status, planned_duration_seconds: planItemsTable.planned_duration_seconds })
          .from(planItemsTable)
          .where(eq(planItemsTable.plan_id, this.activePlanId))
          .orderBy(asc(planItemsTable.position));
        const terminal = new Set(['played', 'supervisor_skipped', 'operator_skipped', 'dropped']);
        let consumedMs = 0;
        for (const item of items) {
          if (terminal.has(item.status)) {
            consumedMs += (item.planned_duration_seconds ?? 0) * 1_000;
          } else {
            break;
          }
        }
        this.planActivatedAtMs = Date.now() - consumedMs;
        this.currentDriftSeconds = 0; // restart fresh; let tick() recompute naturally
        await this.db
          .update(supervisorStateTable)
          .set({ current_drift_seconds: 0 })
          .where(eq(supervisorStateTable.id, 1));
      }
    } catch (err) {
      this.logger?.error(
        { err, process: 'supervisor', event: 'HYDRATE_FAILED' },
        'supervisor: failed to hydrate state from DB',
      );
    }
  }

  // ─── Clock loop ─────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    // Re-read paused flag from DB — control endpoint writes it directly.
    const [stateRow] = await this.db
      .select({ paused: supervisorStateTable.paused })
      .from(supervisorStateTable)
      .where(eq(supervisorStateTable.id, 1));
    this.isPaused = stateRow?.paused ?? false;

    if (this.isPaused) return;

    const nowMs = Date.now();

    // --- Heartbeat (throttled to once per 2.5s) ---
    if (nowMs - this.lastHeartbeatWriteMs >= this.HEARTBEAT_WRITE_INTERVAL_MS) {
      await this.updateHeartbeat(nowMs);
      this.lastHeartbeatWriteMs = nowMs;
    }

    // --- Calendar playhead ---
    const resolved = await this.getCachedSegment(nowMs);
    if (!resolved) return;

    // --- Segment boundary detection ---
    const isNewSegment =
      resolved.segment.id !== this.currentSegmentId ||
      resolved.clockInstanceStartedAt !== this.currentClockInstanceMs;

    if (isNewSegment) {
      const previousId = this.currentSegmentId;
      this.currentSegmentId = resolved.segment.id;
      this.currentSegmentEndMs = resolved.segmentEndMs;
      this.currentClockInstanceMs = resolved.clockInstanceStartedAt;

      await this.db
        .update(supervisorStateTable)
        .set({ current_segment_id: resolved.segment.id })
        .where(eq(supervisorStateTable.id, 1));

      this.logger?.info({
        process: 'supervisor', event: 'SEGMENT_START',
        segment_id: resolved.segment.id, previous_segment_id: previousId,
        clock_instance_started_at: resolved.clockInstanceStartedAt,
      }, 'supervisor: segment boundary crossed');

      await this.requestDraftForSegment(resolved, nowMs);
    }

    // --- Finalization ---
    await this.maybeFinalize(nowMs);

    if (this.activePlanId == null) return;

    // --- Plan playhead ---
    const { consumedSeconds, expectedEndMs } = await this.computePlanPlayhead(nowMs);

    // --- Drift (plan-relative baseline) ---
    // planRelativeElapsed counts only time since the plan was activated,
    // not since segment start. This prevents calendar lag from safety fills
    // or mid-segment restarts from being counted as drift.
    const planRelativeElapsedSeconds =
      this.planActivatedAtMs > 0 ? (nowMs - this.planActivatedAtMs) / 1000 : 0;
    const drift = planRelativeElapsedSeconds - consumedSeconds;
    if (Math.abs(drift - this.currentDriftSeconds) > 0.5) {
      this.currentDriftSeconds = drift;
      await this.db
        .update(supervisorStateTable)
        .set({ current_drift_seconds: drift })
        .where(eq(supervisorStateTable.id, 1));
      this.logger?.info({
        process: 'supervisor', event: 'DRIFT_UPDATE',
        drift_seconds: drift, plan_relative_elapsed: planRelativeElapsedSeconds,
        plan_consumed: consumedSeconds,
      }, 'supervisor: drift updated from playheads');
    }

    // --- Push timing ---
    const shouldPush =
      (expectedEndMs != null && expectedEndMs - nowMs <= this.PUSH_LEAD_MS) ||
      (expectedEndMs == null && await this.hasPendingItems(this.activePlanId));

    if (shouldPush) {
      this._bus.emit({ type: 'PUSH_NEXT_REQUESTED', reason: 'clock_lead' });
    }

    // --- Drift correction ---
    // Don't correct before any plan content has played: the initial calendar lag
    // is already baked into the plan's targetDuration, so skipping items here
    // would create unnecessary gaps.
    if (consumedSeconds > 0) {
      await this.maybeApplyDriftCorrection(nowMs);
    }
  }

  // ─── Segment cache ───────────────────────────────────────────────────────────

  private async getCachedSegment(nowMs: number): Promise<ResolvedSegment | null> {
    if (this.cachedSegment != null && nowMs < this.cachedSegmentValidUntilMs) {
      return this.cachedSegment;
    }
    const resolved = await resolveCurrentSegment(nowMs, this.db);
    this.cachedSegment = resolved;
    this.cachedSegmentValidUntilMs = resolved
      ? resolved.segmentEndMs - 100
      : nowMs + 30_000;
    return resolved;
  }

  // ─── Plan playhead ───────────────────────────────────────────────────────────

  private async computePlanPlayhead(nowMs: number): Promise<{
    consumedSeconds: number;
    expectedEndMs: number | null;
  }> {
    if (this.activePlanId == null) return { consumedSeconds: 0, expectedEndMs: null };

    const items = await this.db
      .select()
      .from(planItemsTable)
      .where(eq(planItemsTable.plan_id, this.activePlanId))
      .orderBy(asc(planItemsTable.position));

    // 'dropped' is NOT counted — a dropped item was not played; it consumed 0s
    // of actual airtime. Counting it inflates consumedSeconds and creates false
    // negative drift that triggers runaway coasting replans.
    const terminalStatuses = new Set(['played', 'supervisor_skipped', 'operator_skipped']);
    let consumedSeconds = 0;
    let expectedEndMs: number | null = null;

    for (const item of items) {
      if (terminalStatuses.has(item.status)) {
        consumedSeconds += item.planned_duration_seconds ?? 0;
      } else if (item.status === 'playing') {
        let startedAtMs: number;
        if (item.play_history_id != null) {
          const [ph] = await this.db
            .select({ started_at: playHistoryTable.started_at })
            .from(playHistoryTable)
            .where(eq(playHistoryTable.id, item.play_history_id));
          // play_history.started_at is stored as a Date by Drizzle (timestamp mode).
          startedAtMs = ph?.started_at ? new Date(ph.started_at).getTime() : nowMs - 5_000;
        } else {
          startedAtMs = nowMs - 5_000;
        }
        consumedSeconds += (nowMs - startedAtMs) / 1000;
        expectedEndMs = startedAtMs + (item.planned_duration_seconds ?? 0) * 1_000;
        break;
      } else {
        // pending — nothing more consumed
        break;
      }
    }

    return { consumedSeconds, expectedEndMs };
  }

  private async hasPendingItems(planId: number): Promise<boolean> {
    const [row] = await this.db
      .select({ id: planItemsTable.id })
      .from(planItemsTable)
      .where(and(eq(planItemsTable.plan_id, planId), eq(planItemsTable.status, 'pending')))
      .limit(1);
    return row != null;
  }

  // ─── LS_TRACK_STARTED ───────────────────────────────────────────────────────

  private async handleTrackStarted(
    msg: BusMessage & { type: 'LS_TRACK_STARTED' },
  ): Promise<void> {
    const onAirMs = Math.floor(msg.on_air_timestamp * 1000);

    // (1) Stamp started_at + close any previously-open play_history row.
    let currentPhid = msg.play_history_id;
    if (currentPhid == null) {
      const fromMeta = parsePhidFromMetadata(msg.metadata);
      if (fromMeta != null) currentPhid = fromMeta;
    }

    if (currentPhid != null) {
      try {
        await stampStarted(this.db, currentPhid, onAirMs);
        await closeOpenRowsBefore(this.db, currentPhid, onAirMs);
        // Mark plan_items whose play_history completed as 'played'. Any item
        // with play_history_id < currentPhid was pushed before the current
        // track and has now finished playing.
        await this.db
          .update(planItemsTable)
          .set({ status: 'played' })
          .where(
            and(
              eq(planItemsTable.status, 'playing'),
              isNotNull(planItemsTable.play_history_id),
              lt(planItemsTable.play_history_id, currentPhid),
            ),
          );
      } catch (err) {
        this.logger?.error(
          { err, process: 'supervisor', event: 'PLAY_HISTORY_STAMP_FAILED', play_history_id: currentPhid },
          'supervisor: failed to stamp/close play_history',
        );
      }
      this.currentPlayHistoryId = currentPhid;
    } else {
      // No play_history_id in LS metadata (silence/blank or unmapped track).
      // Close the most recent open play_history row and mark its plan_item as 'played'.
      const closed = await closeMostRecentOpenRow(this.db, onAirMs).catch(() => null);
      this.currentPlayHistoryId = null;
      if (closed != null) {
        await this.db
          .update(planItemsTable)
          .set({ status: 'played' })
          .where(
            and(
              eq(planItemsTable.status, 'playing'),
              eq(planItemsTable.play_history_id, closed),
            ),
          );
        this.logger?.info(
          { process: 'supervisor', event: 'PLAY_HISTORY_CLOSE_FALLBACK', closed_id: closed },
          'supervisor: closed open play_history without phid match',
        );
      }
    }

    // (2) Invalidate segment cache so tick() re-resolves on next run.
    this.cachedSegment = null;
    this.cachedSegmentValidUntilMs = 0;

    this.logger?.info(
      {
        process: 'supervisor', event: 'TRACK_STARTED',
        play_history_id: currentPhid, on_air_ms: onAirMs,
      },
      'supervisor: track started',
    );
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
    // Reset the plan-relative drift baseline to now. Any lag accumulated
    // before this plan activated (safety fills, restarts) is not "drift".
    this.planActivatedAtMs = Date.now();
    this.currentDriftSeconds = 0;
    await this.db
      .update(supervisorStateTable)
      .set({ active_plan_id: msg.plan_id, current_drift_seconds: 0 })
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

  // ─── Draft / finalize ───────────────────────────────────────────────────────

  // When the planner signals a draft is ready for the current segment,
  // finalize it immediately rather than waiting for the 60s-before-end gate.
  // Plans for future segments are left as drafts until their segment starts.
  private async handlePlanDraftReady(
    msg: BusMessage & { type: 'PLAN_DRAFT_READY' },
  ): Promise<void> {
    this.logger?.info(
      { process: 'supervisor', event: 'PLAN_DRAFT_READY', plan_id: msg.plan_id, segment_id: msg.segment_id },
      'supervisor: planner produced draft plan',
    );

    if (msg.segment_id !== this.currentSegmentId) {
      // Draft is for a future segment — let maybeFinalize handle it at segment start.
      return;
    }

    if (this.finalizedForPlanId === msg.plan_id) return;
    this.finalizedForPlanId = msg.plan_id;

    const requestId = randomUUID();
    this.logger?.info(
      { process: 'supervisor', event: 'PLAN_FINALIZE_REQUESTED', plan_id: msg.plan_id, request_id: requestId },
      'supervisor: immediately finalizing draft for current segment',
    );
    this._bus.emit({ type: 'PLAN_FINALIZE_REQUESTED', request_id: requestId, plan_id: msg.plan_id, now_ms: Date.now() });
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

    // Don't request a new draft if a plan already exists for this segment/instance.
    // This happens when the supervisor restarts mid-segment: the clock-instance
    // comparison fires isNewSegment but the planner already produced a plan.
    const [existingPlan] = await this.db
      .select({ id: plansTable.id, status: plansTable.status })
      .from(plansTable)
      .where(
        and(
          eq(plansTable.segment_id, key.segmentId),
          eq(plansTable.clock_instance_started_at, key.instanceMs),
          inArray(plansTable.status, ['draft', 'finalized', 'active']),
        ),
      )
      .limit(1);
    if (existingPlan) {
      this.logger?.info(
        {
          process: 'supervisor', event: 'DRAFT_SKIPPED_EXISTING',
          existing_plan_id: existingPlan.id, status: existingPlan.status,
        },
        'supervisor: plan already exists for segment instance, skipping draft request',
      );
      return;
    }

    // Target = remaining segment time from now, not the full segment duration.
    // Using remaining time handles both the normal case (plan requested at
    // segment start → remaining ≈ full duration) and the restart/late case
    // (plan requested mid-segment → remaining = actual time left).
    const remainingMs = Math.max(0, resolved.segmentEndMs - nowMs);
    const targetDuration = Math.floor(remainingMs / 1000);
    const requestId = randomUUID();
    this.logger?.info(
      {
        process: 'supervisor',
        event: 'PLAN_DRAFT_REQUESTED',
        segment_id: resolved.segment.id,
        target_duration_seconds: targetDuration,
        remaining_ms: remainingMs,
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

  private async maybeFinalize(nowMs: number): Promise<void> {
    if (this.currentSegmentId == null || this.currentSegmentEndMs == null) return;
    if (this.currentClockInstanceMs == null) return;

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

    // Finalize immediately — handlePlanDraftReady covers the live path; this
    // covers restart where PLAN_DRAFT_READY won't re-fire for an existing draft.
    void nowMs;
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

  private async correctRunningBehind(nowMs: number): Promise<void> {
    const resolved = await this.getCachedSegment(nowMs);
    if (!resolved) return;
    const order = parseDriftOrder(resolved.segment.catching_up_order);
    if (order.length === 0) return;

    const driftBefore = this.currentDriftSeconds;
    let remainingDrift = driftBefore;

    for (const type of order) {
      if (remainingDrift <= DRIFT_CORRECTION_THRESHOLD_SECONDS) break;
      const planItem = await this.findSkipCandidate(this.activePlanId!, type);
      if (!planItem) continue;
      if (planItem.mandatory) continue;

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

  private async correctRunningAhead(nowMs: number): Promise<void> {
    if (this.activePlanId == null) return;
    if (this.pendingReplanForPlanId === this.activePlanId) return;

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

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async updateHeartbeat(nowMs: number): Promise<void> {
    await this.db
      .update(supervisorStateTable)
      .set({ last_heartbeat_at: nowMs })
      .where(eq(supervisorStateTable.id, 1));
  }
}

// Pulls a play_history_id out of LS metadata when the webhook body didn't
// include it as a top-level field.
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
