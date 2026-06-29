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
// Boundary drift model:
//   boundaryDrift(N) = planActivatedAtMs - scheduledSegmentStartMs(N)
//   scheduledSegmentStartMs(N) = segmentEndMs(N) - segment.duration_seconds * 1000
//   Positive = started late. Negative = started early.
//
//   firstPassTarget(N+1) = nominal(N+1) - (boundaryDrift(N) + plannedOvershoot(N))
//
//   This ensures accumulated drift self-corrects in one plan cycle. The old
//   continuous rawDrift signal is gone — drift is only meaningful at boundaries.
//
// Hard-start monitoring (checked every tick, only when next segment is 'hard'):
//   estimated_remaining = time_left_on_playing_item + sum(pending_planned_durations)
//   gap = time_to_hard_boundary - estimated_remaining
//   Fill trigger:  estimated_remaining ≤ 30s AND gap > 30s   → request filler content
//   Trim trigger:  time_to_boundary ≤ 30s AND estimated > boundary + 30s → skip items
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
import type { SLogger } from '../supervisorLogger.js';

import { db as defaultDb } from '../../../db/index.js';
import {
  clockSegments as clockSegmentsTable,
  liveEvents as liveEventsTable,
  planItems as planItemsTable,
  plans as plansTable,
  playHistory as playHistoryTable,
  supervisorState as supervisorStateTable,
  type PlanItemContentType,
} from '../../../db/schema.js';
import { bus, type BusMessage } from '../bus.js';
import { HarborClient } from '../harborClient.js';
import { resolveCurrentSegment, type ResolvedSegment } from '../clockResolver.js';
import {
  closeMostRecentOpenRow,
  closeOpenRowsBefore,
  stampStarted,
} from '../playHistoryService.js';

// ── Thresholds ────────────────────────────────────────────────────────────────
const SECOND_PASS_LEAD_TIME_S = 30;           // T-30s finalization gate (D31)
const HARD_START_TOLERANCE_S = 30;            // fill/trim tolerance for hard boundaries
const SILENCE_ALERT_THRESHOLD_S = 30;         // seconds of no pushes before WARN

export class SupervisorProcess {
  private readonly unsubscribers: Array<() => void> = [];
  private tickTimer: NodeJS.Timeout | null = null;

  // ── Two-plan model (D29) ────────────────────────────────────────────────────
  private activePlanId: number | null = null;
  private nextPlanId: number | null = null;
  // Segment the next plan was drafted for — used to guard against premature
  // advancement to a future segment when the active plan exhausts early.
  private nextPlanSegmentId: number | null = null;
  // Boundary drift at the moment the first-pass draft for the next plan was
  // requested. Compared against boundaryDrift at T-30s to compute drift_delta.
  private nextPlanDraftDriftSeconds = 0;
  // Planned overshoot of the active plan (D51). Accounted drift — subtracted
  // from nominal when computing the next plan's first-pass target.
  private plannedOvershootSeconds = 0;
  // Always 0 until fire-early/late is implemented (D45).
  private readonly intentionalOffsetSeconds = 0;

  // ── Boundary drift (new model) ───────────────────────────────────────────────
  // Drift computed once at plan activation: how early/late the segment actually
  // started vs its scheduled wall-clock start time.
  private boundaryDriftSeconds = 0;
  // segmentEndMs of the next plan's segment, set when requesting the draft.
  // Used to compute boundaryDrift at activation.
  private nextPlanScheduledEndMs: number | null = null;

  // ── Segment tracking ────────────────────────────────────────────────────────
  private currentSegmentId: number | null = null;
  private currentSegmentEndMs: number | null = null;
  private currentClockInstanceMs: number | null = null;
  // Stored in DB as current_drift_seconds; kept equal to boundaryDriftSeconds.
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

  // ── Segment observability ────────────────────────────────────────────────────
  private segmentEntryDriftSeconds = 0;
  // Tracks which part of tick() is executing for richer TICK_FAILED logs (B4).
  private tickOperation = 'init';

  // ── Silence alert (Phase F) ──────────────────────────────────────────────────
  private lastPushSentMs = Date.now();
  private silenceAlertFired = false;

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
    private readonly logger: SLogger | null = null,
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
    // Track last push for silence alerting (Phase F).
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'PUSH_SENT' }>('PUSH_SENT', () => {
        this.lastPushSentMs = Date.now();
        this.silenceAlertFired = false;
      }),
    );

    void this.hydrateFromDb();

    this.tickTimer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger?.error({ err, process: 'supervisor', event: 'TICK_FAILED', operation: this.tickOperation }, 'supervisor: clock tick failed');
      });
    }, this.TICK_INTERVAL_MS);

    void this.tick().catch((err) => {
      this.logger?.error({ err, process: 'supervisor', event: 'TICK_FAILED', operation: this.tickOperation }, 'supervisor: initial tick failed');
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
      this.boundaryDriftSeconds = row.boundary_drift_seconds ?? 0;
      this.currentDriftSeconds = this.boundaryDriftSeconds;

      if (this.nextPlanId != null) {
        const [nextPlanRow] = await this.db
          .select({ segment_id: plansTable.segment_id })
          .from(plansTable)
          .where(eq(plansTable.id, this.nextPlanId));
        this.nextPlanSegmentId = nextPlanRow?.segment_id ?? null;
      }
      this.plannedOvershootSeconds = row.planned_overshoot_seconds ?? 0;
      this.isPaused = row.paused ?? false;

      if (this.activePlanId != null) {
        // Reset any 'playing' items to 'pending' — across a restart we have no
        // idea what LiquidSoap was actually playing. Leaving them as 'playing'
        // causes computePlanPlayhead to read their stale play_history.started_at
        // (hours old), producing a massive negative drift that triggers a
        // runaway loop on every tick.
        await this.db
          .update(planItemsTable)
          .set({ status: 'pending' })
          .where(and(
            eq(planItemsTable.plan_id, this.activePlanId),
            eq(planItemsTable.status, 'playing'),
          ));

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
      }
    } catch (err) {
      this.logger?.error({ err, process: 'supervisor', event: 'HYDRATE_FAILED' }, 'supervisor: failed to hydrate state from DB');
    }
  }

  // ─── Clock loop ─────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    this.tickOperation = 'load_state';
    const [stateRow] = await this.db
      .select({ paused: supervisorStateTable.paused })
      .from(supervisorStateTable)
      .where(eq(supervisorStateTable.id, 1));
    this.isPaused = stateRow?.paused ?? false;
    if (this.isPaused) return;

    const nowMs = Date.now();

    this.tickOperation = 'heartbeat';
    if (nowMs - this.lastHeartbeatWriteMs >= this.HEARTBEAT_WRITE_INTERVAL_MS) {
      await this.updateHeartbeat(nowMs);
      this.lastHeartbeatWriteMs = nowMs;
    }

    this.tickOperation = 'segment_resolve';
    const resolved = await this.getCachedSegment(nowMs);
    if (!resolved) return;

    // ── Segment boundary detection ─────────────────────────────────────────
    this.tickOperation = 'boundary_detection';
    const isNewSegment =
      resolved.segment.id !== this.currentSegmentId ||
      resolved.clockInstanceStartedAt !== this.currentClockInstanceMs;

    if (isNewSegment) {
      const previousId = this.currentSegmentId;
      const previousPlanId = this.activePlanId;

      // B5: Log summary of the segment that just ended.
      if (previousId != null && previousPlanId != null) {
        const summary = await this.computeSegmentSummary(previousPlanId);
        this.logger?.info({
          process: 'supervisor', event: 'SEGMENT_SUMMARY',
          segment_id: previousId, plan_id: previousPlanId,
          items_played: summary.items_played,
          items_skipped: summary.items_skipped,
          actual_duration_seconds: summary.actual_duration_seconds,
          drift_at_entry_seconds: this.segmentEntryDriftSeconds,
          drift_at_exit_seconds: this.currentDriftSeconds,
        }, 'supervisor: segment ended');
      }

      this.currentSegmentId = resolved.segment.id;
      this.currentSegmentEndMs = resolved.segmentEndMs;
      this.currentClockInstanceMs = resolved.clockInstanceStartedAt;

      await this.db.update(supervisorStateTable)
        .set({ current_segment_id: resolved.segment.id })
        .where(eq(supervisorStateTable.id, 1));

      // B1: Enrich SEGMENT_START with type/name/duration/clock/show context.
      this.logger?.info({
        process: 'supervisor', event: 'SEGMENT_START',
        segment_id: resolved.segment.id,
        segment_type: resolved.segment.type,
        segment_name: resolved.segment.name,
        duration_seconds: resolved.segment.duration_seconds,
        clock_id: resolved.clock_id,
        show_id: resolved.show_id,
        show_name: resolved.show_name,
        previous_segment_id: previousId,
        clock_instance_started_at: resolved.clockInstanceStartedAt,
      }, 'supervisor: segment boundary crossed');

      this.segmentEntryDriftSeconds = this.currentDriftSeconds;

      // Cold start: no active plan and no next plan building.
      if (this.activePlanId == null && this.nextPlanId == null && !this.coldStartFinalizeSent) {
        await this.requestColdStartDraft(resolved, nowMs);
        return;
      }

      // Normal operation: request a draft for the segment that follows this one.
      await this.maybeRequestNextDraft(resolved, nowMs);
    }

    // ── T-30s finalization gate (D31) ──────────────────────────────────────
    this.tickOperation = 'finalization_check';
    await this.maybeRequestFinalization(nowMs);

    if (this.activePlanId == null) return;

    // ── Plan playhead (for push timing) ───────────────────────────────────
    this.tickOperation = 'playhead_calc';
    const { expectedEndMs } = await this.computePlanPlayhead(nowMs);

    // ── Silence alert (Phase F) ────────────────────────────────────────────
    const stallSeconds = (nowMs - this.lastPushSentMs) / 1000;
    if (stallSeconds > SILENCE_ALERT_THRESHOLD_S && !this.silenceAlertFired) {
      this.silenceAlertFired = true;
      this.logger?.warn({
        process: 'supervisor', event: 'SILENCE_ALERT',
        stall_duration_seconds: Math.floor(stallSeconds),
        active_plan_id: this.activePlanId,
      }, 'supervisor: no push sent for >30s — station may be silent');
    }

    // ── Push timing ─────────────────────────────────────────────────────────
    this.tickOperation = 'push_decision';
    // Treat a stale 'playing' item (expectedEndMs far in the past) as null so
    // the exhausted-plan path fires instead of endlessly re-emitting pushes
    // that the queue feeder can't act on (no pending items remain).
    const isStale = expectedEndMs != null && expectedEndMs < nowMs - 5_000;
    if (expectedEndMs == null || isStale) {
      const hasPending = await this.hasPendingItems(this.activePlanId);
      if (hasPending) {
        this._bus.emit({ type: 'PUSH_NEXT_REQUESTED', reason: 'clock_lead' });
      } else {
        await this.handleExhaustedPlan(nowMs);
      }
    } else if (expectedEndMs - nowMs <= this.PUSH_LEAD_MS) {
      this._bus.emit({ type: 'PUSH_NEXT_REQUESTED', reason: 'clock_lead' });
    }

    // ── Hard-start gate ────────────────────────────────────────────────────
    this.tickOperation = 'hard_start_gate';
    await this.maybeHandleHardStartGate(nowMs);
  }

  // Counts played/skipped items in a plan for SEGMENT_SUMMARY.
  private async computeSegmentSummary(planId: number): Promise<{
    items_played: number;
    items_skipped: number;
    actual_duration_seconds: number;
  }> {
    const items = await this.db
      .select({ status: planItemsTable.status, planned_duration_seconds: planItemsTable.planned_duration_seconds })
      .from(planItemsTable)
      .where(eq(planItemsTable.plan_id, planId));
    const skippedStatuses = new Set(['supervisor_skipped', 'operator_skipped', 'dropped']);
    let played = 0, skipped = 0, playedSeconds = 0;
    for (const item of items) {
      if (item.status === 'played') {
        played++;
        playedSeconds += item.planned_duration_seconds ?? 0;
      } else if (skippedStatuses.has(item.status)) {
        skipped++;
      }
    }
    return { items_played: played, items_skipped: skipped, actual_duration_seconds: playedSeconds };
  }

  // Called when the active plan has no pending and no playing items. Activates
  // the next plan immediately so the queue feeder can push content without
  // waiting for an LS_TRACK_STARTED webhook that will never arrive.
  private async handleExhaustedPlan(nowMs: number): Promise<void> {
    if (this.nextPlanId == null) {
      this.logger?.warn({
        process: 'supervisor', event: 'PLAN_STALL', reason: 'no_next_plan',
        active_plan_id: this.activePlanId,
      }, 'supervisor: active plan exhausted with nothing playing; no next plan ready');
      return;
    }
    const [nextPlan] = await this.db
      .select({ status: plansTable.status, segment_id: plansTable.segment_id, clock_instance_started_at: plansTable.clock_instance_started_at })
      .from(plansTable)
      .where(eq(plansTable.id, this.nextPlanId));
    if (!nextPlan) return;
    if (nextPlan.status !== 'draft' && nextPlan.status !== 'finalized') return;

    // Don't advance to a plan that belongs to a clock instance that hasn't
    // started yet. This prevents the last segment of one clock hour from
    // exhausting early and immediately consuming content from the next hour.
    // Within the same clock instance, early advancement is intentional —
    // organic drift means a short plan legitimately hands off to the next
    // segment's plan before the wall-clock boundary.
    if (
      nextPlan.clock_instance_started_at != null &&
      nowMs < nextPlan.clock_instance_started_at
    ) {
      return;
    }

    this.logger?.info({
      process: 'supervisor', event: 'PLAN_ADVANCE_FORCED',
      active_plan_id: this.activePlanId, next_plan_id: this.nextPlanId,
      next_plan_status: nextPlan.status,
    }, 'supervisor: forcing plan advance — active plan exhausted, nothing playing');
    await this.activateNextPlan(nowMs);
    this._bus.emit({ type: 'PUSH_NEXT_REQUESTED', reason: 'plan_exhausted_advance' });
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

  // ─── Hard-start gate ─────────────────────────────────────────────────────────
  //
  // Checked every tick. Only active when next segment has hard start_policy.
  // Fill trigger: plan running short → request filler to bridge to hard boundary.
  // Trim trigger: plan running long → skip items near hard boundary.

  private async maybeHandleHardStartGate(nowMs: number): Promise<void> {
    if (this.activePlanId == null || this.currentSegmentEndMs == null) return;

    const resolved = await this.getCachedSegment(nowMs);
    if (!resolved) return;

    const next = await resolveCurrentSegment(resolved.segmentEndMs + 1, this.db);
    if (!next) return;

    const policy = readStartPolicy(next.segment.start_policy);
    if (policy.type !== 'hard') return;

    const estimatedRemainingSec = await this.computeEstimatedRemaining(nowMs);
    const timeToHardBoundarySec = (this.currentSegmentEndMs - nowMs) / 1000;
    const gapSec = timeToHardBoundarySec - estimatedRemainingSec;

    // Fill trigger: plan is running short, gap exceeds tolerance.
    if (
      estimatedRemainingSec <= HARD_START_TOLERANCE_S &&
      gapSec > HARD_START_TOLERANCE_S &&
      this.pendingReplanForPlanId !== this.activePlanId
    ) {
      const fromPosition = await this.firstPendingPosition(this.activePlanId);
      const requestId = randomUUID();
      this.pendingReplanForPlanId = this.activePlanId;
      this.logger?.info({
        process: 'supervisor', event: 'HARD_START_FILL',
        plan_id: this.activePlanId,
        estimated_remaining_seconds: estimatedRemainingSec,
        time_to_boundary_seconds: timeToHardBoundarySec,
        gap_seconds: gapSec,
        request_id: requestId,
      }, 'supervisor: hard-start fill triggered — plan running short');
      this._bus.emit({
        type: 'PLAN_REPLAN_REQUESTED',
        request_id: requestId,
        plan_id: this.activePlanId,
        from_position: fromPosition,
        remaining_seconds: Math.floor(timeToHardBoundarySec),
        now_ms: nowMs,
      });
      return;
    }

    // Trim trigger: within 30s of hard boundary and plan will run over.
    if (
      timeToHardBoundarySec <= HARD_START_TOLERANCE_S &&
      estimatedRemainingSec > timeToHardBoundarySec + HARD_START_TOLERANCE_S
    ) {
      await this.applyHardStartTrim(nowMs);
    }
  }

  // Returns how many seconds of content remain in the active plan.
  private async computeEstimatedRemaining(nowMs: number): Promise<number> {
    if (this.activePlanId == null) return 0;

    const items = await this.db
      .select({
        status: planItemsTable.status,
        planned_duration_seconds: planItemsTable.planned_duration_seconds,
        play_history_id: planItemsTable.play_history_id,
      })
      .from(planItemsTable)
      .where(eq(planItemsTable.plan_id, this.activePlanId))
      .orderBy(asc(planItemsTable.position));

    let remaining = 0;
    for (const item of items) {
      if (item.status === 'playing') {
        if (item.play_history_id != null) {
          const [ph] = await this.db
            .select({ started_at: playHistoryTable.started_at })
            .from(playHistoryTable)
            .where(eq(playHistoryTable.id, item.play_history_id));
          const startedAtMs = ph?.started_at ? new Date(ph.started_at).getTime() : nowMs;
          const elapsed = (nowMs - startedAtMs) / 1000;
          remaining += Math.max(0, (item.planned_duration_seconds ?? 0) - elapsed);
        } else {
          remaining += (item.planned_duration_seconds ?? 0) * 0.5;
        }
      } else if (item.status === 'pending') {
        remaining += item.planned_duration_seconds ?? 0;
      }
    }
    return remaining;
  }

  // Skip one item near the hard boundary (highest-priority skippable type first).
  // Called one item per tick so the gate re-evaluates after each removal.
  private async applyHardStartTrim(nowMs: number): Promise<void> {
    if (this.activePlanId == null) return;

    const items = await this.db
      .select()
      .from(planItemsTable)
      .where(eq(planItemsTable.plan_id, this.activePlanId))
      .orderBy(asc(planItemsTable.position));

    const liveItems = items.filter((i) => i.status === 'pending' || i.status === 'playing');

    // Skip order: branding/jingle/station_id first, then music (cut_allowed).
    const priorityGroups: Array<{ types: PlanItemContentType[]; allowCut: boolean }> = [
      { types: ['jingle', 'branding', 'station_id'], allowCut: true },
      { types: ['music'], allowCut: true },
    ];

    for (const { types, allowCut } of priorityGroups) {
      for (const item of liveItems) {
        if (!types.includes(item.content_type)) continue;
        if (item.mandatory) continue;
        const isPlaying = item.status === 'playing';
        if (isPlaying && (!allowCut || !item.cut_allowed)) continue;
        if (!isPlaying && !item.skip_allowed) continue;

        await this.db.update(planItemsTable)
          .set({ status: 'supervisor_skipped' })
          .where(eq(planItemsTable.id, item.id));

        if (isPlaying) {
          try {
            await HarborClient.skip();
          } catch (err) {
            this.logger?.error({ err, process: 'supervisor', event: 'HARBOR_SKIP_FAILED', plan_item_id: item.id }, 'supervisor: hard-start trim harbor skip failed');
          }
        }

        this.logger?.info({
          process: 'supervisor', event: 'HARD_START_TRIM',
          plan_item_id: item.id, content_type: item.content_type, on_air: isPlaying,
        }, 'supervisor: hard-start trim — item removed');

        void nowMs;
        return; // one item per tick; gate re-evaluates next tick
      }
    }

    this.logger?.warn({
      process: 'supervisor', event: 'HARD_START_TRIM_STUCK',
      plan_id: this.activePlanId,
    }, 'supervisor: hard-start trim — no skippable items available');
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
        // Notify queue feeder so it starts pushing the newly activated plan
        // immediately — without this, it would wait for the next LS_TRACK_ENDING
        // webhook, which may never arrive if LS falls through to blank().
        this._bus.emit({ type: 'PUSH_NEXT_REQUESTED', reason: 'plan_transition' });
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
    const [item] = await this.db
      .select({ id: planItemsTable.id })
      .from(planItemsTable)
      .where(and(
        eq(planItemsTable.plan_id, planId),
        eq(planItemsTable.play_history_id, phid),
      ))
      .limit(1);
    if (!item) return false;

    const hasPending = await this.hasPendingItems(planId);
    return !hasPending;
  }

  // ─── Plan activation (D44, D51) ─────────────────────────────────────────────

  private async activateNextPlan(nowMs: number): Promise<void> {
    if (this.nextPlanId == null) return;
    const planId = this.nextPlanId;

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

    // Compute boundary drift: how late/early this segment actually started
    // vs its scheduled wall-clock start time.
    //   scheduledStartMs = segmentEndMs - segment.duration_seconds * 1000
    //   boundaryDrift = planActivatedAtMs - scheduledStartMs
    //
    // nextPlanScheduledEndMs is set by maybeRequestNextDraft; fall back to
    // currentSegmentEndMs for cold-start and exhausted-plan paths.
    const segEndMs = this.nextPlanScheduledEndMs ?? this.currentSegmentEndMs ?? nowMs;
    const scheduledStartMs = segEndMs - nominal * 1000;
    this.boundaryDriftSeconds = (nowMs - scheduledStartMs) / 1000;
    this.currentDriftSeconds = this.boundaryDriftSeconds;

    // Update in-memory state.
    this.activePlanId = planId;
    this.nextPlanId = null;
    this.nextPlanSegmentId = null;
    this.nextPlanScheduledEndMs = null;
    this.planActivatedAtMs = nowMs;
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
        current_drift_seconds: this.boundaryDriftSeconds,
        boundary_drift_seconds: this.boundaryDriftSeconds,
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
      boundary_drift_seconds: this.boundaryDriftSeconds,
    }, 'supervisor: plan activated');
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

  private async handlePlanDraftReady(msg: BusMessage & { type: 'PLAN_DRAFT_READY' }): Promise<void> {
    this.logger?.info({
      process: 'supervisor', event: 'PLAN_DRAFT_READY',
      plan_id: msg.plan_id, segment_id: msg.segment_id,
    }, 'supervisor: planner produced draft plan');

    const isColdStartDraft = msg.segment_id === this.currentSegmentId && this.activePlanId == null;

    this.nextPlanId = msg.plan_id;
    this.nextPlanSegmentId = msg.segment_id;
    this.nextPlanDraftDriftSeconds = this.boundaryDriftSeconds;

    await this.db.update(supervisorStateTable)
      .set({
        next_plan_id: msg.plan_id,
        next_plan_draft_drift_seconds: this.boundaryDriftSeconds,
      })
      .where(eq(supervisorStateTable.id, 1));

    if (isColdStartDraft && !this.coldStartFinalizeSent) {
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

  private async handlePlanFinalized(msg: BusMessage & { type: 'PLAN_FINALIZED' }): Promise<void> {
    this.logger?.info({
      process: 'supervisor', event: 'PLAN_FINALIZED',
      plan_id: msg.plan_id,
    }, 'supervisor: plan finalized and ready');

    if (this.activePlanId == null && this.nextPlanId === msg.plan_id) {
      await this.activateNextPlan(Date.now());
      if (this.cachedSegment) {
        await this.maybeRequestNextDraft(this.cachedSegment, Date.now());
      }
    }
  }

  // ─── Draft request helpers ───────────────────────────────────────────────────

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

  // Requests a draft for the segment that follows `current`.
  // first_pass_target = nominal(N+1) - (boundaryDrift(N) + plannedOvershoot(N))
  //
  // Both terms estimate how much over/under the active plan will run at segment
  // N's boundary, so N+1's plan is pre-corrected before the T-30s second pass.
  private async maybeRequestNextDraft(current: ResolvedSegment, nowMs: number): Promise<void> {
    const next = await resolveCurrentSegment(current.segmentEndMs + 1, this.db);
    if (!next) {
      this.logger?.info({
        process: 'supervisor', event: 'NO_NEXT_SEGMENT',
        after_segment_id: current.segment.id,
      }, 'supervisor: no segment follows current; no draft requested');
      return;
    }

    if (
      this.draftedForNextSegment &&
      this.draftedForNextSegment.segmentId === next.segment.id &&
      this.draftedForNextSegment.instanceMs === next.clockInstanceStartedAt
    ) {
      return;
    }

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
      // Wire up nextPlanId so handleExhaustedPlan can activate when the active
      // plan runs out — without this, PLAN_STALL fires after every restart.
      if (this.nextPlanId == null) {
        this.nextPlanId = existing.id;
        this.nextPlanSegmentId = next.segment.id;
        await this.db.update(supervisorStateTable)
          .set({ next_plan_id: existing.id })
          .where(eq(supervisorStateTable.id, 1));
      }
      return;
    }

    const nominalNext = next.segment.duration_seconds;
    // Both boundaryDrift and plannedOvershoot represent accumulated lateness at
    // the upcoming segment boundary. Subtracting both from nominal pre-corrects
    // the draft so boundary drift self-corrects in one plan cycle.
    // Cap at nominalNext: the first pass should never request MORE than one full
    // segment of content. When plannedOvershoot is very negative (previous plan
    // ran far short), the raw formula overshoots upward and the planner fills
    // with whatever it can find (often branding) instead of segment-appropriate
    // content. The T-30s finalization gate can still extend up to 140% of nominal
    // if the boundary drift turns out to be negative (segment started early).
    const firstPassTarget = Math.max(
      30,
      Math.min(
        nominalNext,
        nominalNext - (this.boundaryDriftSeconds + this.plannedOvershootSeconds),
      ),
    );

    // Store segment end time so activateNextPlan can compute boundary drift.
    this.nextPlanScheduledEndMs = next.segmentEndMs;
    this.draftedForNextSegment = { segmentId: next.segment.id, instanceMs: next.clockInstanceStartedAt };
    const requestId = randomUUID();
    this.logger?.info({
      process: 'supervisor', event: 'PLAN_DRAFT_REQUESTED',
      segment_id: next.segment.id,
      target_duration_seconds: firstPassTarget,
      nominal_duration_seconds: nominalNext,
      boundary_drift_seconds: this.boundaryDriftSeconds,
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
  // Uses boundary drift (stable, boundary-based) instead of per-tick rawDrift.
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

    // driftDelta = how much drift changed since the first pass was requested.
    // Since boundaryDrift is stable within a segment, delta is typically 0 — but
    // may differ in edge cases where plan was forced-advanced to a new segment.
    const driftDelta = this.boundaryDriftSeconds - this.nextPlanDraftDriftSeconds;
    const rawTarget = nominal - this.boundaryDriftSeconds;
    const adjustedTarget = Math.max(
      nominal * 0.6,
      Math.min(nominal * 1.4, rawTarget),
    );

    this.finalizationRequestedForPlanId = this.nextPlanId;
    const requestId = randomUUID();
    this.logger?.info({
      process: 'supervisor', event: 'PLAN_FINALIZE_REQUESTED',
      plan_id: this.nextPlanId, segment_id: plan.segment_id,
      drift_delta_seconds: driftDelta,
      adjusted_target_seconds: adjustedTarget,
      boundary_drift_seconds: this.boundaryDriftSeconds,
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
      current_drift_seconds: this.boundaryDriftSeconds,
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Module-level helpers ─────────────────────────────────────────────────────

function parsePhidFromMetadata(meta: Record<string, string>): number | null {
  const raw = meta['play_history_id'];
  if (typeof raw !== 'string' || raw === '') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
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
