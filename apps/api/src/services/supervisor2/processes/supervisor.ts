// Supervisor — two-plan proactive model (V2 Step 3).
//
// The supervisor tracks two plans simultaneously (D29):
//   active_plan  — executing now; Queue Feeder reads from it one item at a time.
//   next_plan    — being assembled for the following segment; becomes active
//                  the moment the active plan's last item transitions to 'playing'.
//
// State machine per segment N:
//   Segment N starts (calendar boundary) → maybeRequestNextDraft(N+1)
//   PLAN_DRAFT_READY for N+1           → nextPlanId set, drift_at_first_pass recorded
//   T−30s before N ends                → PLAN_FINALIZE_REQUESTED with drift_delta / adjusted_target
//   PLAN_FINALIZED for next plan        → plan sits in DB until transition fires
//   Last item of plan N starts playing  → activateNextPlan() → activePlanId = N+1 plan
//
// Cold start (supervisor starts mid-segment, no plan):
//   Draft current segment with remaining_seconds as target.
//   On draft ready: immediately finalize (no T-30s gate).
//   On finalized: activate immediately (no last-item trigger needed).
//   Then: maybeRequestNextDraft for the following segment.
//
// Drift model (D51):
//   planned_overshoot = sum(plan items durations) - nominal_segment_duration
//   execution_drift   = actual_drift - planned_overshoot
//   Corrections only trigger when |execution_drift| > threshold.
//   planned_overshoot is already baked into the next plan's first_pass_target.
//
// Decision references:
//   D29 — Two-plan model + cold start
//   D30 — Minimum 120s segment, draft fallback on boundary without finalization
//   D31 — Drift delta, adjusted target formula
//   D34 — cut_allowed / skip_allowed on plan items
//   D40 — Show context (show_id / show_name) in PLAN_DRAFT_REQUESTED
//   D43 — prefer_early / prefer_late defaults
//   D44 — Plan transition on last item playing
//   D49 — Fire-early 30s window (placeholder; full algorithm in later step)
//   D50 — Schema additions for two-plan model
//   D51 — Organic drift vs execution drift; boundary decision at activation

import { randomUUID } from 'crypto';
import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { db as defaultDb } from '../../../db/index.js';
import {
  clockSegments as clockSegmentsTable,
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

// ── Thresholds (will be read from supervisor_config in a later step) ──────────
const SECOND_PASS_LEAD_TIME_S = 30;           // T-30s finalization gate (D31)
const DRIFT_CORRECTION_THRESHOLD_S = 10;       // execution drift threshold (D51)
const COASTING_CORRECTION_THRESHOLD_S = 30;    // coasting threshold (D51)
const ADJUSTED_TARGET_MIN_RATIO = 0.6;
const ADJUSTED_TARGET_MAX_RATIO = 1.4;

// DriftEventType → plan_items.content_type mapping
const DRIFT_TYPE_TO_CONTENT_TYPES: Record<DriftEventType, PlanItemContentType[]> = {
  songs: ['music'],
  jingles: ['jingle', 'branding'],
  station_ids: ['station_id', 'branding'],
  spots: ['campaign'],
  promos: ['promo'],
};

type BoundaryDecision =
  | 'accept_late'
  | 'correct_immediately'
  | 'accept_early'
  | 'gap_fill_in_plan';

export class SupervisorProcess {
  private readonly unsubscribers: Array<() => void> = [];
  private tickTimer: NodeJS.Timeout | null = null;

  // ── Two-plan model (D29) ────────────────────────────────────────────────────
  private activePlanId: number | null = null;
  private nextPlanId: number | null = null;
  // Drift at the moment the first-pass draft for the next plan was requested.
  // Compared against current_drift at T-30s to compute drift_delta (D31).
  private nextPlanDraftDriftSeconds = 0;
  // Planned overshoot of the active plan (D51). Accounted drift — subtracted
  // from raw drift before deciding whether corrections are needed.
  private plannedOvershootSeconds = 0;
  // Always 0 until fire-early/late is implemented (D45).
  private readonly intentionalOffsetSeconds = 0;
  private boundaryDecision: BoundaryDecision | null = null;

  // ── Segment tracking ────────────────────────────────────────────────────────
  private currentSegmentId: number | null = null;
  private currentSegmentEndMs: number | null = null;
  private currentClockInstanceMs: number | null = null;
  private currentDriftSeconds = 0;
  private planActivatedAtMs = 0;

  // ── Guards to prevent duplicate requests ───────────────────────────────────
  // Prevents double-emitting PLAN_FINALIZE_REQUESTED for the same plan.
  private finalizationRequestedForPlanId: number | null = null;
  // Prevents double-requesting a draft for the same next segment.
  private draftedForNextSegment: { segmentId: number; instanceMs: number } | null = null;
  // Prevents double-emitting a cold-start finalization.
  private coldStartFinalizeSent = false;

  // ── Other state ─────────────────────────────────────────────────────────────
  private currentPlayHistoryId: number | null = null;
  private liveTakeoverActive = false;
  private liveTakeoverRowId: number | null = null;
  private pendingReplanForPlanId: number | null = null;
  private isPaused = false;

  // ── Segment cache ───────────────────────────────────────────────────────────
  private cachedSegment: ResolvedSegment | null = null;
  private cachedSegmentValidUntilMs = 0;

  private lastHeartbeatWriteMs = 0;
  private readonly TICK_INTERVAL_MS = 500;
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
          this.logger?.error({ err, process: 'supervisor', event: 'HANDLER_FAILED', source: 'LS_TRACK_STARTED' }, 'supervisor: LS_TRACK_STARTED handler failed');
        });
      }),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'LS_LIVE_STARTED' }>('LS_LIVE_STARTED', (msg) => {
        void this.handleLiveStarted(msg).catch((err) => {
          this.logger?.error({ err, process: 'supervisor', event: 'HANDLER_FAILED', source: 'LS_LIVE_STARTED' }, 'supervisor: LS_LIVE_STARTED handler failed');
        });
      }),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'LS_LIVE_ENDED' }>('LS_LIVE_ENDED', (msg) => {
        void this.handleLiveEnded(msg).catch((err) => {
          this.logger?.error({ err, process: 'supervisor', event: 'HANDLER_FAILED', source: 'LS_LIVE_ENDED' }, 'supervisor: LS_LIVE_ENDED handler failed');
        });
      }),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'PLAN_DRAFT_READY' }>('PLAN_DRAFT_READY', (msg) => {
        void this.handlePlanDraftReady(msg).catch((err) => {
          this.logger?.error({ err, process: 'supervisor', event: 'HANDLER_FAILED', source: 'PLAN_DRAFT_READY' }, 'supervisor: PLAN_DRAFT_READY handler failed');
        });
      }),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'PLAN_FINALIZED' }>('PLAN_FINALIZED', (msg) => {
        void this.handlePlanFinalized(msg).catch((err) => {
          this.logger?.error({ err, process: 'supervisor', event: 'HANDLER_FAILED', source: 'PLAN_FINALIZED' }, 'supervisor: PLAN_FINALIZED handler failed');
        });
      }),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'PLAN_REPLANNED' }>('PLAN_REPLANNED', (msg) => {
        this.logger?.info({ process: 'supervisor', event: 'PLAN_REPLANNED_OBSERVED', plan_id: msg.plan_id }, 'supervisor: planner returned replan');
        if (this.pendingReplanForPlanId === msg.plan_id) this.pendingReplanForPlanId = null;
      }),
    );

    void this.hydrateFromDb();

    this.tickTimer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger?.error({ err, process: 'supervisor', event: 'TICK_FAILED' }, 'supervisor: clock tick failed');
      });
    }, this.TICK_INTERVAL_MS);

    void this.tick().catch((err) => {
      this.logger?.error({ err, process: 'supervisor', event: 'TICK_FAILED' }, 'supervisor: initial tick failed');
    });
  }

  stop(): void {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }

  getCurrentDriftSeconds(): number { return this.currentDriftSeconds; }
  getActivePlanId(): number | null { return this.activePlanId; }
  isLiveTakeoverActive(): boolean { return this.liveTakeoverActive; }

  // ─── Hydration ──────────────────────────────────────────────────────────────

  private async hydrateFromDb(): Promise<void> {
    try {
      const [row] = await this.db.select().from(supervisorStateTable).where(eq(supervisorStateTable.id, 1));
      if (!row) return;
      this.currentSegmentId = row.current_segment_id ?? null;
      this.activePlanId = row.active_plan_id ?? null;
      this.nextPlanId = row.next_plan_id ?? null;
      this.nextPlanDraftDriftSeconds = row.next_plan_draft_drift_seconds ?? 0;
      this.plannedOvershootSeconds = row.planned_overshoot_seconds ?? 0;
      this.isPaused = row.paused ?? false;

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
        this.currentDriftSeconds = 0;
        await this.db.update(supervisorStateTable)
          .set({ current_drift_seconds: 0 })
          .where(eq(supervisorStateTable.id, 1));
      }
    } catch (err) {
      this.logger?.error({ err, process: 'supervisor', event: 'HYDRATE_FAILED' }, 'supervisor: failed to hydrate state from DB');
    }
  }

  // ─── Clock loop ─────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    const [stateRow] = await this.db
      .select({ paused: supervisorStateTable.paused })
      .from(supervisorStateTable)
      .where(eq(supervisorStateTable.id, 1));
    this.isPaused = stateRow?.paused ?? false;
    if (this.isPaused) return;

    const nowMs = Date.now();

    if (nowMs - this.lastHeartbeatWriteMs >= this.HEARTBEAT_WRITE_INTERVAL_MS) {
      await this.updateHeartbeat(nowMs);
      this.lastHeartbeatWriteMs = nowMs;
    }

    const resolved = await this.getCachedSegment(nowMs);
    if (!resolved) return;

    // ── Segment boundary detection ─────────────────────────────────────────
    const isNewSegment =
      resolved.segment.id !== this.currentSegmentId ||
      resolved.clockInstanceStartedAt !== this.currentClockInstanceMs;

    if (isNewSegment) {
      const previousId = this.currentSegmentId;
      this.currentSegmentId = resolved.segment.id;
      this.currentSegmentEndMs = resolved.segmentEndMs;
      this.currentClockInstanceMs = resolved.clockInstanceStartedAt;

      await this.db.update(supervisorStateTable)
        .set({ current_segment_id: resolved.segment.id })
        .where(eq(supervisorStateTable.id, 1));

      this.logger?.info({
        process: 'supervisor', event: 'SEGMENT_START',
        segment_id: resolved.segment.id, previous_segment_id: previousId,
        clock_instance_started_at: resolved.clockInstanceStartedAt,
      }, 'supervisor: segment boundary crossed');

      // Cold start: no active plan and no next plan building.
      if (this.activePlanId == null && this.nextPlanId == null && !this.coldStartFinalizeSent) {
        await this.requestColdStartDraft(resolved, nowMs);
        return;
      }

      // Normal operation: request a draft for the segment that follows this one.
      await this.maybeRequestNextDraft(resolved, nowMs);
    }

    // ── T-30s finalization gate (D31) ──────────────────────────────────────
    await this.maybeRequestFinalization(nowMs);

    if (this.activePlanId == null) return;

    // ── Plan playhead + drift ──────────────────────────────────────────────
    const { consumedSeconds, expectedEndMs } = await this.computePlanPlayhead(nowMs);

    const planRelativeElapsedSeconds =
      this.planActivatedAtMs > 0 ? (nowMs - this.planActivatedAtMs) / 1000 : 0;
    const rawDrift = planRelativeElapsedSeconds - consumedSeconds;
    if (Math.abs(rawDrift - this.currentDriftSeconds) > 0.5) {
      this.currentDriftSeconds = rawDrift;
      await this.db.update(supervisorStateTable)
        .set({ current_drift_seconds: rawDrift })
        .where(eq(supervisorStateTable.id, 1));
      this.logger?.info({
        process: 'supervisor', event: 'DRIFT_UPDATE',
        drift_seconds: rawDrift,
        planned_overshoot_seconds: this.plannedOvershootSeconds,
        execution_drift_seconds: rawDrift - this.plannedOvershootSeconds,
        plan_relative_elapsed: planRelativeElapsedSeconds,
        plan_consumed: consumedSeconds,
      }, 'supervisor: drift updated from playheads');
    }

    // ── Push timing ─────────────────────────────────────────────────────────
    const shouldPush =
      (expectedEndMs != null && expectedEndMs - nowMs <= this.PUSH_LEAD_MS) ||
      (expectedEndMs == null && await this.hasPendingItems(this.activePlanId));

    if (shouldPush) {
      this._bus.emit({ type: 'PUSH_NEXT_REQUESTED', reason: 'clock_lead' });
    }

    // ── Drift correction (execution drift only — D51) ───────────────────────
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
    this.cachedSegmentValidUntilMs = resolved ? resolved.segmentEndMs - 100 : nowMs + 30_000;
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
          startedAtMs = ph?.started_at ? new Date(ph.started_at).getTime() : nowMs - 5_000;
        } else {
          startedAtMs = nowMs - 5_000;
        }
        consumedSeconds += (nowMs - startedAtMs) / 1000;
        expectedEndMs = startedAtMs + (item.planned_duration_seconds ?? 0) * 1_000;
        break;
      } else {
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

  private async handleTrackStarted(msg: BusMessage & { type: 'LS_TRACK_STARTED' }): Promise<void> {
    const onAirMs = Math.floor(msg.on_air_timestamp * 1000);

    let currentPhid = msg.play_history_id;
    if (currentPhid == null) {
      const fromMeta = parsePhidFromMetadata(msg.metadata);
      if (fromMeta != null) currentPhid = fromMeta;
    }

    if (currentPhid != null) {
      try {
        await stampStarted(this.db, currentPhid, onAirMs);
        await closeOpenRowsBefore(this.db, currentPhid, onAirMs);
        await this.db.update(planItemsTable)
          .set({ status: 'played' })
          .where(and(
            eq(planItemsTable.status, 'playing'),
            isNotNull(planItemsTable.play_history_id),
            lt(planItemsTable.play_history_id, currentPhid),
          ));
      } catch (err) {
        this.logger?.error({ err, process: 'supervisor', event: 'PLAY_HISTORY_STAMP_FAILED', play_history_id: currentPhid }, 'supervisor: failed to stamp/close play_history');
      }
      this.currentPlayHistoryId = currentPhid;
    } else {
      const closed = await closeMostRecentOpenRow(this.db, onAirMs).catch(() => null);
      this.currentPlayHistoryId = null;
      if (closed != null) {
        await this.db.update(planItemsTable)
          .set({ status: 'played' })
          .where(and(
            eq(planItemsTable.status, 'playing'),
            eq(planItemsTable.play_history_id, closed),
          ));
        this.logger?.info({ process: 'supervisor', event: 'PLAY_HISTORY_CLOSE_FALLBACK', closed_id: closed }, 'supervisor: closed open play_history without phid match');
      }
    }

    // Invalidate segment cache so tick() re-resolves on next run.
    this.cachedSegment = null;
    this.cachedSegmentValidUntilMs = 0;

    // ── Plan transition (D44) ────────────────────────────────────────────────
    // When the last pending item of the active plan starts playing, promote
    // nextPlan → activePlan. The tick then picks up the new segment and
    // requests a draft for the segment after next.
    if (this.activePlanId != null && this.nextPlanId != null && currentPhid != null) {
      const isTransition = await this.isLastPendingNowPlaying(this.activePlanId, currentPhid);
      if (isTransition) {
        await this.activateNextPlan(Date.now());
      }
    }

    this.logger?.info({
      process: 'supervisor', event: 'TRACK_STARTED',
      play_history_id: currentPhid, on_air_ms: onAirMs,
    }, 'supervisor: track started');
  }

  // Returns true when the plan item that just transitioned to 'playing' is the
  // last one in `planId` — i.e. there are no more pending items left.
  private async isLastPendingNowPlaying(planId: number, phid: number): Promise<boolean> {
    // Check if the item with this phid is in the active plan.
    const [item] = await this.db
      .select({ id: planItemsTable.id })
      .from(planItemsTable)
      .where(and(
        eq(planItemsTable.plan_id, planId),
        eq(planItemsTable.play_history_id, phid),
      ))
      .limit(1);
    if (!item) return false;

    // Check if there are any pending items remaining.
    const hasPending = await this.hasPendingItems(planId);
    return !hasPending;
  }

  // ─── Plan activation (D44, D51) ─────────────────────────────────────────────

  private async activateNextPlan(nowMs: number): Promise<void> {
    if (this.nextPlanId == null) return;
    const planId = this.nextPlanId;

    // Look up segment nominal duration to compute planned overshoot (D51).
    const [plan] = await this.db
      .select({ segment_id: plansTable.segment_id })
      .from(plansTable)
      .where(eq(plansTable.id, planId));
    if (!plan) {
      this.logger?.error({ process: 'supervisor', event: 'ACTIVATE_PLAN_MISSING', plan_id: planId }, 'supervisor: plan not found during activation');
      return;
    }

    const [segment] = await this.db
      .select({ duration_seconds: clockSegmentsTable.duration_seconds })
      .from(clockSegmentsTable)
      .where(eq(clockSegmentsTable.id, plan.segment_id));

    const items = await this.db
      .select({ planned_duration_seconds: planItemsTable.planned_duration_seconds, status: planItemsTable.status })
      .from(planItemsTable)
      .where(eq(planItemsTable.plan_id, planId));

    const liveStatuses = new Set(['pending', 'playing']);
    const totalPlanned = items
      .filter((i) => liveStatuses.has(i.status))
      .reduce((s, i) => s + i.planned_duration_seconds, 0);
    const nominal = segment?.duration_seconds ?? 0;
    this.plannedOvershootSeconds = totalPlanned - nominal;

    // Determine boundary decision from the segment after next (D51).
    // The segment that follows the newly activated plan's segment.
    this.boundaryDecision = await this.computeBoundaryDecision(plan.segment_id, this.plannedOvershootSeconds);

    // Update in-memory state.
    this.activePlanId = planId;
    this.nextPlanId = null;
    this.planActivatedAtMs = nowMs;
    this.currentDriftSeconds = 0;
    this.finalizationRequestedForPlanId = null;
    this.draftedForNextSegment = null;

    // DB writes.
    await this.db.update(plansTable)
      .set({ status: 'active' })
      .where(eq(plansTable.id, planId));
    await this.db.update(supervisorStateTable)
      .set({
        active_plan_id: planId,
        next_plan_id: null,
        current_drift_seconds: 0,
        planned_overshoot_seconds: this.plannedOvershootSeconds,
        intentional_offset_seconds: this.intentionalOffsetSeconds,
        next_plan_draft_drift_seconds: null,
        next_plan_drift_delta_seconds: null,
      })
      .where(eq(supervisorStateTable.id, 1));

    this.logger?.info({
      process: 'supervisor', event: 'PLAN_ACTIVATED',
      plan_id: planId, segment_id: plan.segment_id,
      planned_overshoot_seconds: this.plannedOvershootSeconds,
      boundary_decision: this.boundaryDecision,
    }, 'supervisor: plan activated');

    // Trigger immediately_correct when the plan will run long into a hard boundary.
    if (this.boundaryDecision === 'correct_immediately') {
      this.logger?.info({
        process: 'supervisor', event: 'BOUNDARY_CORRECTION_PENDING',
        plan_id: planId, planned_overshoot_seconds: this.plannedOvershootSeconds,
      }, 'supervisor: plan will overshoot hard boundary — correction will be applied');
      // The tick's drift correction loop will act once drift exceeds threshold.
    }
  }

  // Evaluates what the supervisor should do at the boundary of the newly
  // activated plan (D51). Looks up the start_policy of the segment that
  // follows the active plan's segment.
  private async computeBoundaryDecision(
    activeSegmentId: number,
    plannedOvershootSeconds: number,
  ): Promise<BoundaryDecision> {
    // Find the segment that comes after activeSegmentId in the same clock.
    const [activeSeg] = await this.db
      .select({ clock_id: clockSegmentsTable.clock_id, sort_order: clockSegmentsTable.sort_order })
      .from(clockSegmentsTable)
      .where(eq(clockSegmentsTable.id, activeSegmentId));
    if (!activeSeg) return 'accept_late';

    const allSegs = await this.db
      .select({ sort_order: clockSegmentsTable.sort_order, start_policy: clockSegmentsTable.start_policy })
      .from(clockSegmentsTable)
      .where(eq(clockSegmentsTable.clock_id, activeSeg.clock_id))
      .orderBy(asc(clockSegmentsTable.sort_order));

    const nextSeg = allSegs.find((s) => s.sort_order > activeSeg.sort_order);
    if (!nextSeg) return 'accept_late'; // end of clock — no fixed boundary

    const policy = readStartPolicy(nextSeg.start_policy);

    if (plannedOvershootSeconds > 0) {
      return policy.type === 'hard' ? 'correct_immediately' : 'accept_late';
    } else {
      const earlySeconds = policy.type === 'flexible' ? (policy.early_seconds ?? null) : 0;
      return earlySeconds !== 0 ? 'accept_early' : 'gap_fill_in_plan';
    }
  }

  // ─── Live takeover ──────────────────────────────────────────────────────────

  private async handleLiveStarted(msg: BusMessage & { type: 'LS_LIVE_STARTED' }): Promise<void> {
    this.liveTakeoverActive = true;
    const nowMs = Date.now();
    const [inserted] = await this.db
      .insert(liveEventsTable)
      .values({ started_at: nowMs, ended_at: null, segment_id: this.currentSegmentId, plan_id: this.activePlanId })
      .returning({ id: liveEventsTable.id });
    this.liveTakeoverRowId = inserted?.id ?? null;
    this._bus.emit({ type: 'LIVE_STATUS_CHANGED', active: true });
    this.logger?.info({
      process: 'supervisor', event: 'LIVE_TAKEOVER_STARTED',
      source_name: msg.source_name, segment_id: this.currentSegmentId, plan_id: this.activePlanId,
    }, 'supervisor: live takeover started');
  }

  private async handleLiveEnded(msg: BusMessage & { type: 'LS_LIVE_ENDED' }): Promise<void> {
    this.liveTakeoverActive = false;
    const nowMs = Date.now();
    let elapsedSeconds = 0;
    if (this.liveTakeoverRowId != null) {
      const [row] = await this.db
        .select({ started_at: liveEventsTable.started_at })
        .from(liveEventsTable)
        .where(eq(liveEventsTable.id, this.liveTakeoverRowId));
      if (row?.started_at != null) elapsedSeconds = (nowMs - row.started_at) / 1000;
      await this.db.update(liveEventsTable)
        .set({ ended_at: nowMs })
        .where(eq(liveEventsTable.id, this.liveTakeoverRowId));
      this.liveTakeoverRowId = null;
    }
    this._bus.emit({ type: 'LIVE_STATUS_CHANGED', active: false });

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
    this.logger?.info({
      process: 'supervisor', event: 'LIVE_TAKEOVER_ENDED',
      source_name: msg.source_name, elapsed_seconds: elapsedSeconds,
    }, 'supervisor: live takeover ended');
  }

  // ─── Planner responses ──────────────────────────────────────────────────────

  // PLAN_DRAFT_READY fires when the planner finishes the first pass.
  // Normal case: store as nextPlanId, record drift at first-pass time.
  // Cold start case: also immediately request finalization (no T-30s gate).
  private async handlePlanDraftReady(msg: BusMessage & { type: 'PLAN_DRAFT_READY' }): Promise<void> {
    this.logger?.info({
      process: 'supervisor', event: 'PLAN_DRAFT_READY',
      plan_id: msg.plan_id, segment_id: msg.segment_id,
    }, 'supervisor: planner produced draft plan');

    const isColdStartDraft = msg.segment_id === this.currentSegmentId && this.activePlanId == null;

    // Store as next plan candidate.
    this.nextPlanId = msg.plan_id;
    this.nextPlanDraftDriftSeconds = this.currentDriftSeconds;

    await this.db.update(supervisorStateTable)
      .set({
        next_plan_id: msg.plan_id,
        next_plan_draft_drift_seconds: this.currentDriftSeconds,
      })
      .where(eq(supervisorStateTable.id, 1));

    if (isColdStartDraft && !this.coldStartFinalizeSent) {
      // Cold start: skip T-30s gate, finalize immediately with no drift adjustment.
      this.coldStartFinalizeSent = true;
      this.finalizationRequestedForPlanId = msg.plan_id;
      const requestId = randomUUID();
      this.logger?.info({
        process: 'supervisor', event: 'PLAN_FINALIZE_REQUESTED',
        plan_id: msg.plan_id, request_id: requestId, cold_start: true,
      }, 'supervisor: cold start — immediately finalizing draft');
      this._bus.emit({
        type: 'PLAN_FINALIZE_REQUESTED',
        request_id: requestId,
        plan_id: msg.plan_id,
        now_ms: Date.now(),
        adjusted_target_seconds: 0,
        drift_delta_seconds: 0,
        current_drift_seconds: 0,
      });
    }
  }

  // PLAN_FINALIZED fires when the planner completes the second pass.
  // Cold start: activate immediately (no last-item trigger available).
  // Normal: plan sits in DB until last item of active plan starts playing.
  private async handlePlanFinalized(msg: BusMessage & { type: 'PLAN_FINALIZED' }): Promise<void> {
    this.logger?.info({
      process: 'supervisor', event: 'PLAN_FINALIZED',
      plan_id: msg.plan_id,
    }, 'supervisor: plan finalized and ready');

    // Cold start: activePlanId is null — activate the just-finalized plan immediately.
    if (this.activePlanId == null && this.nextPlanId === msg.plan_id) {
      await this.activateNextPlan(Date.now());
      // Now request draft for the following segment.
      if (this.cachedSegment) {
        await this.maybeRequestNextDraft(this.cachedSegment, Date.now());
      }
    }
    // Otherwise: normal path — plan becomes active when last item starts playing.
  }

  // ─── Draft request helpers ───────────────────────────────────────────────────

  // Requests a draft for the current segment on cold start. Uses remaining time
  // as target (not nominal, since we're mid-segment).
  private async requestColdStartDraft(resolved: ResolvedSegment, nowMs: number): Promise<void> {
    const remainingMs = Math.max(0, resolved.segmentEndMs - nowMs);
    const targetDuration = Math.floor(remainingMs / 1000);
    const requestId = randomUUID();
    this.logger?.info({
      process: 'supervisor', event: 'PLAN_DRAFT_REQUESTED',
      segment_id: resolved.segment.id, target_duration_seconds: targetDuration,
      cold_start: true, request_id: requestId,
    }, 'supervisor: cold start — requesting draft for current segment');
    this._bus.emit({
      type: 'PLAN_DRAFT_REQUESTED',
      request_id: requestId,
      segment_id: resolved.segment.id,
      clock_instance_started_at: resolved.clockInstanceStartedAt,
      target_duration_seconds: targetDuration,
      now_ms: nowMs,
      show_id: resolved.show_id,
      show_name: resolved.show_name,
    });
  }

  // Requests a draft for the segment that follows `current` (segment N+1 when
  // we just entered segment N). Uses first_pass_target = nominal_N+1 - planned_overshoot_N (D51).
  private async maybeRequestNextDraft(current: ResolvedSegment, nowMs: number): Promise<void> {
    // Resolve the following segment.
    const next = await resolveCurrentSegment(current.segmentEndMs + 1, this.db);
    if (!next) {
      this.logger?.info({
        process: 'supervisor', event: 'NO_NEXT_SEGMENT',
        after_segment_id: current.segment.id,
      }, 'supervisor: no segment follows current; no draft requested');
      return;
    }

    // Dedup guard — don't re-request for the same segment instance.
    if (
      this.draftedForNextSegment &&
      this.draftedForNextSegment.segmentId === next.segment.id &&
      this.draftedForNextSegment.instanceMs === next.clockInstanceStartedAt
    ) {
      return;
    }

    // Don't request if a plan already exists for this segment instance.
    const [existing] = await this.db
      .select({ id: plansTable.id, status: plansTable.status })
      .from(plansTable)
      .where(and(
        eq(plansTable.segment_id, next.segment.id),
        eq(plansTable.clock_instance_started_at, next.clockInstanceStartedAt),
        inArray(plansTable.status, ['draft', 'finalized', 'active']),
      ))
      .limit(1);
    if (existing) {
      this.logger?.info({
        process: 'supervisor', event: 'DRAFT_SKIPPED_EXISTING',
        existing_plan_id: existing.id, status: existing.status,
      }, 'supervisor: plan already exists for next segment, skipping draft request');
      this.draftedForNextSegment = { segmentId: next.segment.id, instanceMs: next.clockInstanceStartedAt };
      return;
    }

    // first_pass_target = nominal_N+1 - planned_overshoot_N (D51)
    const nominalNext = next.segment.duration_seconds;
    const firstPassTarget = Math.max(
      30,
      nominalNext - Math.max(0, this.plannedOvershootSeconds),
    );

    this.draftedForNextSegment = { segmentId: next.segment.id, instanceMs: next.clockInstanceStartedAt };
    const requestId = randomUUID();
    this.logger?.info({
      process: 'supervisor', event: 'PLAN_DRAFT_REQUESTED',
      segment_id: next.segment.id,
      target_duration_seconds: firstPassTarget,
      nominal_duration_seconds: nominalNext,
      planned_overshoot_applied_seconds: this.plannedOvershootSeconds,
      request_id: requestId,
    }, 'supervisor: requesting first-pass draft for next segment');
    this._bus.emit({
      type: 'PLAN_DRAFT_REQUESTED',
      request_id: requestId,
      segment_id: next.segment.id,
      clock_instance_started_at: next.clockInstanceStartedAt,
      target_duration_seconds: firstPassTarget,
      now_ms: nowMs,
      show_id: next.show_id,
      show_name: next.show_name,
    });
  }

  // T-30s gate: emit PLAN_FINALIZE_REQUESTED with drift_delta and adjusted_target (D31).
  private async maybeRequestFinalization(nowMs: number): Promise<void> {
    if (this.nextPlanId == null) return;
    if (this.finalizationRequestedForPlanId === this.nextPlanId) return;
    if (this.currentSegmentEndMs == null) return;

    const timeToEnd = this.currentSegmentEndMs - nowMs;
    if (timeToEnd > SECOND_PASS_LEAD_TIME_S * 1_000) return;

    const [plan] = await this.db
      .select({ segment_id: plansTable.segment_id })
      .from(plansTable)
      .where(eq(plansTable.id, this.nextPlanId));
    if (!plan) return;

    const [segment] = await this.db
      .select({ duration_seconds: clockSegmentsTable.duration_seconds })
      .from(clockSegmentsTable)
      .where(eq(clockSegmentsTable.id, plan.segment_id));
    const nominal = segment?.duration_seconds ?? 0;

    const driftDelta = this.currentDriftSeconds - this.nextPlanDraftDriftSeconds;
    // adjusted_target = nominal - current_drift, clamped to [60%, 140%] of nominal (D31)
    const rawTarget = nominal - this.currentDriftSeconds;
    const adjustedTarget = Math.max(
      nominal * ADJUSTED_TARGET_MIN_RATIO,
      Math.min(nominal * ADJUSTED_TARGET_MAX_RATIO, rawTarget),
    );

    this.finalizationRequestedForPlanId = this.nextPlanId;
    const requestId = randomUUID();
    this.logger?.info({
      process: 'supervisor', event: 'PLAN_FINALIZE_REQUESTED',
      plan_id: this.nextPlanId, segment_id: plan.segment_id,
      drift_delta_seconds: driftDelta,
      adjusted_target_seconds: adjustedTarget,
      current_drift_seconds: this.currentDriftSeconds,
      time_to_segment_end_seconds: timeToEnd / 1000,
      request_id: requestId,
    }, 'supervisor: T-30s finalization gate fired');

    await this.db.update(supervisorStateTable)
      .set({ next_plan_drift_delta_seconds: driftDelta })
      .where(eq(supervisorStateTable.id, 1));

    this._bus.emit({
      type: 'PLAN_FINALIZE_REQUESTED',
      request_id: requestId,
      plan_id: this.nextPlanId,
      now_ms: nowMs,
      adjusted_target_seconds: adjustedTarget,
      drift_delta_seconds: driftDelta,
      current_drift_seconds: this.currentDriftSeconds,
    });
  }

  // ─── Drift correction (execution drift only) ─────────────────────────────────

  private async maybeApplyDriftCorrection(nowMs: number): Promise<void> {
    if (this.activePlanId == null || this.currentSegmentId == null) return;

    // Execution drift strips out the accounted organic overshoot (D51).
    const executionDrift = this.currentDriftSeconds - this.plannedOvershootSeconds;

    if (executionDrift > DRIFT_CORRECTION_THRESHOLD_S) {
      await this.correctRunningBehind(nowMs);
      return;
    }
    if (executionDrift < -COASTING_CORRECTION_THRESHOLD_S) {
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
      if (remainingDrift - this.plannedOvershootSeconds <= DRIFT_CORRECTION_THRESHOLD_S) break;
      const planItem = await this.findSkipCandidate(this.activePlanId!, type);
      if (!planItem) continue;
      // D34: never skip mandatory items or items where skip_allowed=false.
      if (planItem.mandatory || !planItem.skip_allowed) continue;

      const isCurrentlyPlaying =
        this.currentPlayHistoryId != null && planItem.play_history_id === this.currentPlayHistoryId;

      await this.db.update(planItemsTable)
        .set({ status: 'supervisor_skipped' })
        .where(eq(planItemsTable.id, planItem.id));

      if (isCurrentlyPlaying) {
        try {
          await HarborClient.skip();
        } catch (err) {
          this.logger?.error({ err, process: 'supervisor', event: 'HARBOR_SKIP_FAILED', plan_item_id: planItem.id }, 'supervisor: harbor skip failed');
        }
      }

      remainingDrift -= planItem.planned_duration_seconds ?? 0;
      this.logger?.info({
        process: 'supervisor', event: 'CORRECTION_SKIP',
        plan_item_id: planItem.id, content_type: planItem.content_type,
        drift_before_seconds: driftBefore, drift_after_seconds: remainingDrift,
        on_air: isCurrentlyPlaying,
      }, 'supervisor: correction skip applied');
    }
    void nowMs;
  }

  private async correctRunningAhead(nowMs: number): Promise<void> {
    if (this.activePlanId == null) return;
    if (this.pendingReplanForPlanId === this.activePlanId) return;

    const fromPosition = await this.firstPendingPosition(this.activePlanId);
    const executionDrift = this.currentDriftSeconds - this.plannedOvershootSeconds;
    const baseRemainingSeconds =
      this.currentSegmentEndMs != null
        ? Math.max(0, Math.floor((this.currentSegmentEndMs - nowMs) / 1000))
        : 0;
    const targetRemainingSeconds = baseRemainingSeconds + Math.abs(executionDrift);
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
    this.logger?.info({
      process: 'supervisor', event: 'CORRECTION_FILL',
      drift_seconds: this.currentDriftSeconds,
      execution_drift_seconds: executionDrift,
      plan_id: this.activePlanId,
      from_position: fromPosition,
      target_remaining_seconds: targetRemainingSeconds,
      request_id: requestId,
    }, 'supervisor: coasting correction replan requested');
  }

  private async findSkipCandidate(planId: number, type: DriftEventType): Promise<PlanItem | null> {
    const contentTypes = DRIFT_TYPE_TO_CONTENT_TYPES[type];
    if (!contentTypes || contentTypes.length === 0) return null;
    const rows = await this.db
      .select()
      .from(planItemsTable)
      .where(eq(planItemsTable.plan_id, planId))
      .orderBy(asc(planItemsTable.position));
    for (const row of rows) {
      if (row.status !== 'pending' && row.status !== 'playing') continue;
      if (row.mandatory || !row.skip_allowed) continue;
      if (!contentTypes.includes(row.content_type)) continue;
      return row;
    }
    return null;
  }

  private async firstPendingPosition(planId: number): Promise<number> {
    const [row] = await this.db
      .select({ position: planItemsTable.position })
      .from(planItemsTable)
      .where(and(eq(planItemsTable.plan_id, planId), eq(planItemsTable.status, 'pending')))
      .orderBy(asc(planItemsTable.position))
      .limit(1);
    return row?.position ?? 0;
  }

  private async updateHeartbeat(nowMs: number): Promise<void> {
    await this.db.update(supervisorStateTable)
      .set({ last_heartbeat_at: nowMs })
      .where(eq(supervisorStateTable.id, 1));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parsePhidFromMetadata(meta: Record<string, string>): number | null {
  const raw = meta['play_history_id'];
  if (typeof raw !== 'string' || raw === '') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function parseDriftOrder(raw: unknown): DriftEventType[] {
  const acceptable: DriftEventType[] = ['songs', 'jingles', 'station_ids', 'spots', 'promos'];
  const out: DriftEventType[] = [];
  let arr: unknown = raw;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return out; }
  }
  if (!Array.isArray(arr)) return out;
  for (const v of arr) {
    if (typeof v === 'string' && acceptable.includes(v as DriftEventType)) {
      out.push(v as DriftEventType);
    }
  }
  return out;
}

function readStartPolicy(raw: unknown): { type: 'hard' | 'flexible'; early_seconds?: number | null } {
  if (raw && typeof raw === 'object' && 'type' in raw) {
    const t = (raw as { type: unknown; early_seconds?: unknown }).type;
    if (t === 'hard') return { type: 'hard' };
    if (t === 'flexible') {
      const es = (raw as { early_seconds?: unknown }).early_seconds;
      return { type: 'flexible', early_seconds: typeof es === 'number' ? es : null };
    }
  }
  if (typeof raw === 'string') {
    try { return readStartPolicy(JSON.parse(raw)); } catch { /* fall through */ }
  }
  return { type: 'flexible', early_seconds: null };
}
