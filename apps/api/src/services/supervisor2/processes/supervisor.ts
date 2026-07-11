// Supervisor — two-plan proactive model (V2 Step 3).
//
// The supervisor tracks two plans simultaneously (D29):
//   active_plan  — executing now; Queue Feeder reads from it one item at a time.
//   next_plan    — being assembled for the following segment; queued ahead into
//                  the harbor when the active plan's last item starts playing,
//                  but only becomes active once real content belonging to it
//                  is confirmed genuinely airing (ground-truth, via
//                  current_play_history_id — see handleTrackStarted) — never
//                  administratively ahead of time.
//
// State machine per segment N:
//   Plan N activates (ground truth,      → activatePlanById(): SEGMENT_START/SUMMARY logged,
//   via activatePlanById, see below)       currentSegmentId/EndMs updated from N's OWN
//                                           segment/clock_instance (not a wall-clock resolve —
//                                           see the drift note below), then maybeRequestNextDraft(N+1)
//   PLAN_DRAFT_READY for N+1           → nextPlanId set, drift_at_first_pass recorded
//                                         (deferred instead if nextPlanId already
//                                         points at a plan with pending content)
//   T−30s before N ends                → PLAN_FINALIZE_REQUESTED with drift_delta / adjusted_target
//   PLAN_FINALIZED for next plan        → plan sits in DB until transition fires
//   Last item of plan N starts playing  → PUSH_NEXT_REQUESTED (queue N+1's first item ahead)
//   LS_TRACK_STARTED for any item not   → activatePlanById() → activePlanId = that item's
//   belonging to the active plan           plan (ground truth, not a nextPlanId prediction)
//
// Segment/plan transitions are playhead-driven, not wall-clock-driven: every
// activation path (ground-truth on-air confirmation, handleExhaustedPlan's
// forced advance, reconcile's RECONCILE_ACTIVATE, cold-start's immediate
// activation) funnels through activatePlanById, which is the single place
// currentSegmentId/currentSegmentEndMs/currentClockInstanceMs get updated and
// the next draft gets requested — reconstructed from the activated plan's
// OWN segment_id/clock_instance via resolveActivePlanSegment, never from a
// fresh resolveCurrentSegment(Date.now()). tick() used to re-derive "current
// segment" from wall-clock nominal durations every ~500ms and treat a change
// there as the transition signal; under real drift (10+ minutes observed
// 2026-07-11) that nominal resolution can report a segment 2+ slots ahead of
// what's actually airing, silently orphaning whatever plan was drafted for
// the skipped segment(s) — see supervisor-plan-activation-timing-redesign
// memory for the incident this caused (536s of live dead air). Wall-clock
// resolution is still used, deliberately, where there's no playhead to be
// relative to (cold start, orphan recovery) or as an explicit re-grounding
// (reconcile() / align-to-wall-clock) — never to decide an ordinary
// transition.
//
// Cold start (supervisor starts mid-segment, no plan):
//   Draft current segment with remaining_seconds as target.
//   On draft ready: immediately finalize (no T-30s gate).
//   On finalized: activate immediately (no last-item trigger needed) —
//   activatePlanById requests the next segment's draft itself.
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
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
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
import { computeResolutionIdentity, resolveActivePlanSegment, resolveCurrentSegment, segmentBoundsWithinClock, type ResolvedSegment } from '../clockResolver.js';
import {
  abortRow,
  closeMostRecentOpenRow,
  closeOpenRowsBefore,
  stampStarted,
} from '../playHistoryService.js';

// ── Thresholds ────────────────────────────────────────────────────────────────
const SECOND_PASS_LEAD_TIME_S = 30;           // T-30s finalization gate (D31)
const HARD_START_TOLERANCE_S = 30;            // fill/trim tolerance for hard boundaries
const SILENCE_ALERT_THRESHOLD_S = 30;         // seconds of no pushes before WARN
// Runway model for reconcile() (validated against live data 2026-07-03: 369
// music tracks average 254.8s, so 300s is ~one song plus headroom; measured
// draft+finalize latency is 15-70ms, negligible, so there's no separate
// build-time margin).
const RUNWAY_WORTH_IT_THRESHOLD_S = 300;      // below this, not worth riding the current plan further
const RUNWAY_FLOOR_S = 3;                     // below this, skip the early-offset dance entirely

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
  // Prevents re-running the exhausted-plan runway reconcile every tick while
  // waiting for its async draft/finalize to land — keyed by the plan id that
  // was exhausted, not segment/instance (this fires on a plan, not a segment).
  private exhaustedPlanReconciledFor: number | null = null;

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
    // Reconcile requested from a route — either the operator's explicit
    // align-to-wall-clock action, or a schedule-affecting mutation
    // auto-triggering it (Decision 54: clock segment save/delete,
    // calendar/template CRUD, template run, show default-clock reassignment).
    // Routes can't hold a direct reference to this process (see
    // supervisorControl.ts), so this is the only way in — same pattern as
    // PUSH_NEXT_REQUESTED.
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'RECONCILE_REQUESTED' }>('RECONCILE_REQUESTED', (msg) => {
        void this.reconcile(msg.now_ms, msg.trigger).catch((err) => {
          this.logger?.error({ err, process: 'supervisor', event: 'HANDLER_FAILED', source: 'RECONCILE_REQUESTED' }, 'supervisor: RECONCILE_REQUESTED handler failed');
        });
      }),
    );

    // Startup covers both cold boot and restart — hydration just finds
    // different state either way. reconcile() runs right after to correct
    // anything hydration got wrong (stale/orphaned plan pointers, etc.).
    // Fire-and-forget, same as before: tick() already tolerates
    // activePlanId being null for the brief window before this resolves.
    void (async () => {
      await this.hydrateFromDb();
      await this.reconcile(Date.now(), 'startup');
    })().catch((err) => {
      this.logger?.error({ err, process: 'supervisor', event: 'HANDLER_FAILED', source: 'startup_reconcile' }, 'supervisor: startup reconcile failed');
    });

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
      if (this.currentSegmentId != null) {
        // Not persisted in supervisor_state — re-resolve so the first tick's
        // boundary detection doesn't see a null-vs-real mismatch and treat an
        // in-progress segment as having just started (spurious SEGMENT_START/
        // SEGMENT_SUMMARY pair on every restart).
        const resolved = await resolveCurrentSegment(Date.now(), this.db);
        if (resolved && resolved.segment.id === this.currentSegmentId) {
          this.currentClockInstanceMs = resolved.clockInstanceStartedAt;
          this.currentSegmentEndMs = resolved.segmentEndMs;
        }
      }
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
        await this.reconstructOrResetPlayingItem(this.activePlanId, row.current_play_history_id ?? null, row.last_heartbeat_at ?? null);

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

  // Restart continuation (Decision 59). Across a restart we previously had no
  // idea what LiquidSoap was actually playing, so every 'playing' plan_item
  // got blind-reset to 'pending' — even one that was legitimately mid-air,
  // which then got pushed and re-played from the top once the queue feeder
  // caught up. Reconstruct instead, using the persisted current_play_history_id
  // pointer, bounded against the last heartbeat the dead process wrote so a
  // stale/implausible pointer still falls back to the old reset behavior.
  private async reconstructOrResetPlayingItem(
    activePlanId: number,
    currentPlayHistoryId: number | null,
    lastHeartbeatAt: number | null,
  ): Promise<void> {
    const playingItems = await this.db
      .select({ id: planItemsTable.id, play_history_id: planItemsTable.play_history_id, planned_duration_seconds: planItemsTable.planned_duration_seconds })
      .from(planItemsTable)
      .where(and(eq(planItemsTable.plan_id, activePlanId), eq(planItemsTable.status, 'playing')));

    if (
      playingItems.length === 1 &&
      currentPlayHistoryId != null &&
      playingItems[0].play_history_id === currentPlayHistoryId &&
      lastHeartbeatAt != null
    ) {
      const [ph] = await this.db
        .select({ started_at: playHistoryTable.started_at })
        .from(playHistoryTable)
        .where(eq(playHistoryTable.id, currentPlayHistoryId));
      const startedAtMs = ph?.started_at ? new Date(ph.started_at).getTime() : null;
      // Plausible only if the item actually started before the process died —
      // otherwise this is exactly the stale-pointer scenario the old blind
      // reset was built to guard against.
      if (startedAtMs != null && startedAtMs <= lastHeartbeatAt) {
        const expectedEndMs = startedAtMs + (playingItems[0].planned_duration_seconds ?? 0) * 1_000;
        if (expectedEndMs <= Date.now()) {
          // Aired to completion during the downtime — close it out rather
          // than leaving it 'playing' (which would look never-started) or
          // resetting it to 'pending' (which would re-push and replay it).
          await this.db.update(planItemsTable).set({ status: 'played' }).where(eq(planItemsTable.id, playingItems[0].id));
          await this.db.update(playHistoryTable).set({ ended_at: new Date(expectedEndMs) }).where(eq(playHistoryTable.id, currentPlayHistoryId));
          await this.setCurrentPlayHistoryId(null);
        } else {
          // Still legitimately playing — leave status='playing' as-is.
          // computePlanPlayhead already reads play_history.started_at for
          // 'playing' items, so normal playhead/drift math continues unchanged.
          this.currentPlayHistoryId = currentPlayHistoryId;
        }
        return;
      }
    }

    // No trustworthy reconstruction — fall back to the original behavior.
    await this.db
      .update(planItemsTable)
      .set({ status: 'pending' })
      .where(and(eq(planItemsTable.plan_id, activePlanId), eq(planItemsTable.status, 'playing')));
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

    // ── Cold start ───────────────────────────────────────────────────────────
    // No active plan and no next plan building — the only case here with no
    // playhead to be relative to, so wall-clock resolution is the right
    // source. Runs unconditionally each tick (guarded by its own
    // coldStartFinalizeSent flag) rather than nested inside a wall-clock
    // segment-change check — that check used to also drive ordinary segment
    // transitions, which is exactly what let a nominal wall-clock jump skip
    // past a drafted segment under drift (see supervisor-plan-activation-
    // timing-redesign memory, 2026-07-11). Ordinary transitions are now
    // driven from activatePlanById, anchored to the plan that actually
    // activated, not to Date.now().
    this.tickOperation = 'cold_start';
    if (this.activePlanId == null && this.nextPlanId == null && !this.coldStartFinalizeSent) {
      await this.requestColdStartDraft(resolved, nowMs);
      return;
    }

    // ── T-30s finalization gate (D31) ──────────────────────────────────────
    this.tickOperation = 'finalization_check';
    await this.maybeRequestFinalization(nowMs);

    // ── Orphaned-plan self-heal ─────────────────────────────────────────────
    // A restart can leave activePlanId null while a plan for the CURRENT
    // segment already reached 'finalized' status under a previous process
    // instance (finalized but not yet activated when the process died).
    // hydrateFromDb() only restores nextPlanId (the segment AFTER current),
    // so that plan is otherwise invisible and the rest of the segment would
    // play silently until the next segment's own finalization cycle happens
    // to activate its plan instead.
    this.tickOperation = 'orphan_recovery';
    if (this.activePlanId == null) {
      const orphaned = await this.findOrphanedFinalizedPlan(resolved.segment.id, resolved.clockInstanceStartedAt);
      if (orphaned) {
        this.logger?.warn({
          process: 'supervisor', event: 'ORPHANED_PLAN_RECOVERED',
          plan_id: orphaned.id, segment_id: resolved.segment.id,
        }, 'supervisor: activating orphaned finalized plan for current segment');
        await this.activatePlanById(orphaned.id, nowMs, { clearNextPlan: false });
      }
    }

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
      } else if (await this.isCurrentPlayHistoryStillOpen()) {
        // computePlanPlayhead() found nothing 'playing' under activePlanId,
        // but ground truth (current_play_history_id) says something IS still
        // genuinely on air — it just belongs to a plan not yet promoted
        // (activation follows real airtime now, not administrative timing).
        // Not exhausted; don't force an advance.
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

      // Use the just-exhausted plan's OWN segment as the reference point, not
      // a fresh wall-clock resolve — the active plan can legitimately be
      // ahead of wall clock (organic early handoff, see the block above), and
      // resolving "now" would land back on the segment this plan already
      // superseded, asking the planner to fill an ever-shrinking remainder
      // that no track can ever fit. Confirmed live 2026-07-03: this produced
      // ~100 empty plans in a row and ~115s of real dead air on segment 195.
      // reconcileNext() applies the same runway model used at boot/restart/
      // operator-action — if there isn't enough runway left, it offsets into
      // whatever comes next (drift-corrected via computeFirstPassTarget)
      // instead of trying to fill a gap nothing can fit.
      if (this.exhaustedPlanReconciledFor !== this.activePlanId) {
        this.exhaustedPlanReconciledFor = this.activePlanId;
        const exhaustedSegmentEndMs = await this.exhaustedActivePlanSegmentEndMs();
        if (exhaustedSegmentEndMs != null) {
          this.logger?.info({
            process: 'supervisor', event: 'EXHAUSTED_PLAN_RECONCILE',
            active_plan_id: this.activePlanId, segment_end_ms: exhaustedSegmentEndMs,
          }, 'supervisor: reconciling from the exhausted plan\'s own segment instead of wall clock');
          await this.reconcileNext(exhaustedSegmentEndMs, nowMs);
        } else {
          // Unexpected: couldn't resolve the exhausted plan's own segment.
          // Fall back to the old wall-clock cold-start as a last resort.
          const resolved = await this.getCachedSegment(nowMs);
          if (resolved) {
            this.coldStartFinalizeSent = false;
            await this.requestColdStartDraft(resolved, nowMs);
          }
        }
      }
      return;
    }
    const [nextPlan] = await this.db
      .select({
        status: plansTable.status,
        segment_id: plansTable.segment_id,
        clock_instance_started_at: plansTable.clock_instance_started_at,
        start_policy: clockSegmentsTable.start_policy,
      })
      .from(plansTable)
      .innerJoin(clockSegmentsTable, eq(clockSegmentsTable.id, plansTable.segment_id))
      .where(eq(plansTable.id, this.nextPlanId));
    if (!nextPlan) return;
    if (nextPlan.status !== 'draft' && nextPlan.status !== 'finalized') return;

    // A plan for a clock instance that hasn't started yet is only blocked
    // from early activation when its own segment is hard-start — the same
    // hard/flexible decision used everywhere else for "is early OK," instead
    // of a blanket cross-instance rule. Within the same clock instance, or
    // into any flexible segment regardless of instance, early advancement is
    // intentional (organic drift, see the runway model).
    const notYetStarted =
      nextPlan.clock_instance_started_at != null && nowMs < nextPlan.clock_instance_started_at;
    if (notYetStarted && readStartPolicy(nextPlan.start_policy).type === 'hard') {
      // Can't jump into the next segment early, and reconcileNext already
      // determined there's nothing else scheduled between here and there.
      // Top up the exhausted plan itself instead of sitting silent — reuses
      // the same replan/assemble path maybeHandleHardStartGate's fill
      // trigger already uses, so a boundary this still can't fully close
      // gets the same cut_allowed=true fallback via the existing d2 logic.
      // Confirmed live 2026-07-04: without this, exhausting on the clock's
      // last segment produced ~125s of real dead air waiting for the next
      // hour, even though the exhausted plan's own segment still had open
      // runway that could have been filled.
      if (this.activePlanId != null && this.pendingReplanForPlanId !== this.activePlanId) {
        const remainingSeconds = (nextPlan.clock_instance_started_at! - nowMs) / 1000;
        const fromPosition = await this.nextAppendPosition(this.activePlanId);
        const requestId = randomUUID();
        this.pendingReplanForPlanId = this.activePlanId;
        this.logger?.info({
          process: 'supervisor', event: 'EXHAUSTED_PLAN_TOPUP',
          plan_id: this.activePlanId, next_plan_id: this.nextPlanId,
          remaining_seconds: remainingSeconds, request_id: requestId,
        }, 'supervisor: next segment is hard and not reachable yet — topping up the exhausted plan instead');
        this._bus.emit({
          type: 'PLAN_REPLAN_REQUESTED',
          request_id: requestId,
          plan_id: this.activePlanId,
          from_position: fromPosition,
          remaining_seconds: Math.max(0, Math.floor(remainingSeconds)),
          now_ms: nowMs,
        });
      }
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

  // One past the highest existing position in the plan (across all
  // statuses, not just pending) — where to append fresh items when a plan
  // has zero pending items left (fully exhausted), unlike firstPendingPosition
  // which assumes some pending tail already exists to splice into.
  private async nextAppendPosition(planId: number): Promise<number> {
    const [row] = await this.db
      .select({ position: planItemsTable.position })
      .from(planItemsTable)
      .where(eq(planItemsTable.plan_id, planId))
      .orderBy(desc(planItemsTable.position))
      .limit(1);
    return (row?.position ?? -1) + 1;
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

  // Ground truth: is the play_history row we last confirmed on-air still
  // open (LiquidSoap hasn't reported it ending)? Independent of which plan
  // it belongs to — unlike computePlanPlayhead, which only sees items under
  // activePlanId and would otherwise mistake "airing under next_plan,
  // not yet promoted" for silence.
  private async isCurrentPlayHistoryStillOpen(): Promise<boolean> {
    if (this.currentPlayHistoryId == null) return false;
    const [row] = await this.db
      .select({ id: playHistoryTable.id })
      .from(playHistoryTable)
      .where(and(eq(playHistoryTable.id, this.currentPlayHistoryId), isNull(playHistoryTable.ended_at)))
      .limit(1);
    return row != null;
  }

  // Unlike hasPendingItems, also counts a currently-playing item — a plan
  // mid-way through its last item (no 'pending' rows left) still has content
  // left and shouldn't be treated as exhausted by the reconcile trust check.
  private async hasPendingOrPlayingItems(planId: number): Promise<boolean> {
    const [row] = await this.db
      .select({ id: planItemsTable.id })
      .from(planItemsTable)
      .where(and(eq(planItemsTable.plan_id, planId), inArray(planItemsTable.status, ['pending', 'playing'])))
      .limit(1);
    return row != null;
  }

  private async sumPendingSeconds(planId: number): Promise<number> {
    const items = await this.db
      .select({ planned_duration_seconds: planItemsTable.planned_duration_seconds })
      .from(planItemsTable)
      .where(and(eq(planItemsTable.plan_id, planId), eq(planItemsTable.status, 'pending')));
    return items.reduce((sum, it) => sum + (it.planned_duration_seconds ?? 0), 0);
  }

  // ─── Hard-start gate ─────────────────────────────────────────────────────────
  //
  // Checked every tick. Only active when next segment has hard start_policy.
  // Fill trigger: plan running short → request filler to bridge to hard boundary.
  // Trim trigger: plan running long → skip items near hard boundary.

  private async maybeHandleHardStartGate(nowMs: number): Promise<void> {
    if (this.activePlanId == null || this.currentSegmentEndMs == null) return;

    // Anchored to the tracked (playhead-sourced) segment end, not a fresh
    // wall-clock resolve — under drift the two can point at different
    // segments, which would make this gate evaluate the wrong "next" one.
    const next = await resolveCurrentSegment(this.currentSegmentEndMs + 1, this.db);
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
          // Decision 63: this item was cut mid-air, not just skipped before
          // ever airing — mark its play_history row aborted so billing/pacing
          // counters (Campaign) can exclude it, while LRP/rotation queries
          // (Music, Branding) correctly keep counting it as "just used".
          if (item.play_history_id != null) {
            await abortRow(this.db, item.play_history_id, nowMs);
          }
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
      await this.setCurrentPlayHistoryId(currentPhid);
    } else {
      const closed = await closeMostRecentOpenRow(this.db, onAirMs).catch(() => null);
      await this.setCurrentPlayHistoryId(null);
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

    // ── Queue-ahead nudge (D44) ──────────────────────────────────────────────
    // When the last pending item of the active plan starts playing, push the
    // next plan's first item into the queue now — don't wait for the next
    // LS_TRACK_ENDING webhook, which may never arrive if LS falls through to
    // blank(). This does NOT activate the next plan; see below.
    if (this.activePlanId != null && this.nextPlanId != null && currentPhid != null) {
      const isLastPending = await this.isLastPendingNowPlaying(this.activePlanId, currentPhid);
      if (isLastPending) {
        this._bus.emit({ type: 'PUSH_NEXT_REQUESTED', reason: 'plan_transition' });
      }
    }

    // ── Plan activation (D44, ground-truth) ─────────────────────────────────
    // Whatever plan the item that JUST genuinely started airing belongs to
    // is now the active plan — no prediction against nextPlanId, no
    // dependency on its timing. This is deliberately independent of the
    // push-ahead nudge above: activation follows confirmed on-air reality,
    // not administrative queue-management bookkeeping.
    if (currentPhid != null) {
      const [airingItem] = await this.db
        .select({ plan_id: planItemsTable.plan_id })
        .from(planItemsTable)
        .where(eq(planItemsTable.play_history_id, currentPhid))
        .limit(1);
      if (airingItem && airingItem.plan_id !== this.activePlanId) {
        await this.activatePlanById(airingItem.plan_id, Date.now(), {
          clearNextPlan: this.nextPlanId === airingItem.plan_id,
        });
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
    await this.activatePlanById(planId, nowMs, { clearNextPlan: true });
  }

  // Looks up a plan that already reached 'finalized' status for the given
  // segment/clock-instance but was never activated — see ORPHANED_PLAN_RECOVERED
  // above for how this can happen.
  private async findOrphanedFinalizedPlan(
    segmentId: number,
    clockInstanceStartedAt: number,
  ): Promise<{ id: number } | null> {
    const [plan] = await this.db
      .select({ id: plansTable.id })
      .from(plansTable)
      .where(and(
        eq(plansTable.segment_id, segmentId),
        eq(plansTable.clock_instance_started_at, clockInstanceStartedAt),
        eq(plansTable.status, 'finalized'),
      ))
      .orderBy(desc(plansTable.id))
      .limit(1);
    return plan ?? null;
  }

  // Shared activation core used both for the normal next-plan transition
  // (D44) and for the orphaned-plan self-heal above. `clearNextPlan` must be
  // false for the self-heal case: the orphaned plan belongs to the CURRENT
  // segment, so the legitimately-tracked nextPlanId (the segment AFTER
  // current) must be left alone.
  private async activatePlanById(
    planId: number,
    nowMs: number,
    opts: { clearNextPlan: boolean },
  ): Promise<void> {
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

    // Captured before this activation overwrites in-memory state below —
    // needed for the outgoing segment's SEGMENT_SUMMARY.
    const previousActivePlanId = this.activePlanId;
    const previousSegmentId = this.currentSegmentId;
    const outgoingDriftAtExit = this.currentDriftSeconds;

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
    if (opts.clearNextPlan) {
      this.nextPlanId = null;
      this.nextPlanSegmentId = null;
      this.nextPlanScheduledEndMs = null;
    }
    this.planActivatedAtMs = nowMs;
    this.finalizationRequestedForPlanId = null;
    this.draftedForNextSegment = null;
    this.exhaustedPlanReconciledFor = null;

    // DB writes.
    await this.db.update(plansTable)
      .set({ status: 'active' })
      .where(eq(plansTable.id, planId));
    // Data hygiene (Decision 56): retire the plan being handed off from —
    // previously this just moved the pointer and left the old row stuck at
    // 'active' forever. Hasn't caused incorrect behavior (reconcileOccurrence
    // breaks ties by highest plan id) but Align to Clock's invalidate step is
    // the first code to explicitly retire a plan, so close this gap generally.
    if (previousActivePlanId != null && previousActivePlanId !== planId) {
      await this.db.update(plansTable)
        .set({ status: 'completed' })
        .where(and(eq(plansTable.id, previousActivePlanId), eq(plansTable.status, 'active')));
    }

    // ── Segment boundary bookkeeping (playhead-driven) ──────────────────────
    // This ground-truth activation IS the segment transition — anchored to
    // the plan that actually just activated, not a fresh wall-clock resolve.
    // A wall-clock resolve can jump forward past a segment under drift (see
    // supervisor-plan-activation-timing-redesign memory, 2026-07-11 incident);
    // reconstructing bounds from this plan's own segment_id/clock_instance
    // can't skip anything, because it only ever describes what's actually
    // airing right now.
    if (previousActivePlanId != null && previousSegmentId != null) {
      const summary = await this.computeSegmentSummary(previousActivePlanId);
      this.logger?.info({
        process: 'supervisor', event: 'SEGMENT_SUMMARY',
        segment_id: previousSegmentId, plan_id: previousActivePlanId,
        items_played: summary.items_played,
        items_skipped: summary.items_skipped,
        actual_duration_seconds: summary.actual_duration_seconds,
        drift_at_entry_seconds: this.segmentEntryDriftSeconds,
        drift_at_exit_seconds: outgoingDriftAtExit,
      }, 'supervisor: segment ended');
    }

    const activeSegment = await resolveActivePlanSegment(this.db, planId);
    if (activeSegment) {
      this.currentSegmentId = activeSegment.segment.id;
      this.currentSegmentEndMs = activeSegment.segmentEndMs;
      this.currentClockInstanceMs = activeSegment.clockInstanceStartedAt;
      this.segmentEntryDriftSeconds = this.boundaryDriftSeconds;

      this.logger?.info({
        process: 'supervisor', event: 'SEGMENT_START',
        segment_id: activeSegment.segment.id,
        segment_type: activeSegment.segment.type,
        segment_name: activeSegment.segment.name,
        duration_seconds: activeSegment.segment.duration_seconds,
        clock_id: activeSegment.clock_id,
        previous_segment_id: previousSegmentId,
        clock_instance_started_at: activeSegment.clockInstanceStartedAt,
      }, 'supervisor: segment boundary crossed');
    } else {
      this.logger?.warn({
        process: 'supervisor', event: 'ACTIVATE_PLAN_SEGMENT_UNRESOLVED', plan_id: planId,
      }, 'supervisor: could not reconstruct segment bounds for activated plan');
    }

    await this.db.update(supervisorStateTable)
      .set({
        active_plan_id: planId,
        current_segment_id: this.currentSegmentId,
        ...(opts.clearNextPlan
          ? { next_plan_id: null, next_plan_draft_drift_seconds: null, next_plan_drift_delta_seconds: null }
          : {}),
        current_drift_seconds: this.boundaryDriftSeconds,
        boundary_drift_seconds: this.boundaryDriftSeconds,
        planned_overshoot_seconds: this.plannedOvershootSeconds,
        intentional_offset_seconds: this.intentionalOffsetSeconds,
      })
      .where(eq(supervisorStateTable.id, 1));

    this.logger?.info({
      process: 'supervisor', event: 'PLAN_ACTIVATED',
      plan_id: planId, segment_id: plan.segment_id,
      planned_overshoot_seconds: this.plannedOvershootSeconds,
      boundary_drift_seconds: this.boundaryDriftSeconds,
    }, 'supervisor: plan activated');

    // Request a draft for the segment that follows this one — replaces the
    // trigger that used to live in tick()'s wall-clock isNewSegment block.
    if (activeSegment) {
      await this.maybeRequestNextDraft(activeSegment, nowMs);
    }
  }

  // ─── Reconcile ──────────────────────────────────────────────────────────────
  //
  // Unlike tick(), which only reacts to bus events and assumes each one fires
  // exactly once on the same process instance, reconcile() re-derives "what
  // should be active right now" from scratch against a fresh resolve and the
  // plans table. This is deliberately NOT run on every tick — only at process
  // startup (covers cold boot and restart identically; hydrateFromDb() just
  // finds different state either way) and on an explicit operator action
  // (align-to-wall-clock). Ordinary segment-to-segment handoffs keep using
  // the existing tick()/isNewSegment/D44 machinery untouched.
  private async reconcile(nowMs: number, trigger: string): Promise<void> {
    const resolved = await resolveCurrentSegment(nowMs, this.db);
    if (!resolved) {
      this.logger?.warn({
        process: 'supervisor', event: 'RECONCILE_NO_SCHEDULE', trigger,
      }, 'reconcile: no segment resolves for now');
      return;
    }

    this.logger?.info({
      process: 'supervisor', event: 'RECONCILE_START', trigger,
      segment_id: resolved.segment.id, clock_instance_started_at: resolved.clockInstanceStartedAt,
    }, 'reconcile: starting');

    // The active plan may already legitimately be AHEAD of what wall-clock
    // resolution alone says is current — organic early handoff within a
    // clock instance is intentional (see handleExhaustedPlan: a short plan
    // can hand off to the next segment's plan before the wall-clock
    // boundary). Confirmed live 2026-07-03: reconcile() forced activation
    // back to the wall-clock-resolved (but already-superseded) segment,
    // undoing a correct organic advance — masked that time only because the
    // very next thing it checked (the following segment) happened to be the
    // plan that was actually right. Once something is truly active we let
    // it ride rather than yanking it back (same philosophy as not
    // interrupting in-progress content on a live schedule edit).
    const trustedEndMs = await this.activePlanSegmentEndMs(resolved, nowMs);
    if (trustedEndMs != null) {
      this.currentSegmentEndMs = trustedEndMs;
      await this.reconcileNext(trustedEndMs, nowMs);
    } else {
      // No trustworthy active plan for this clock instance — establish
      // ground truth from a fresh resolve. hydrateFromDb() only trusts
      // persisted state (and gives up on a mismatch); this is the actual
      // fix for restart-correctness.
      this.currentSegmentId = resolved.segment.id;
      this.currentSegmentEndMs = resolved.segmentEndMs;
      this.currentClockInstanceMs = resolved.clockInstanceStartedAt;

      const currentTargetDuration = Math.max(0, Math.floor((resolved.segmentEndMs - nowMs) / 1000));
      await this.reconcileOccurrence(resolved, nowMs, {
        allowActivate: true,
        targetDurationSeconds: currentTargetDuration,
      });
      await this.reconcileNext(resolved.segmentEndMs, nowMs);
    }

    await this.db.update(supervisorStateTable)
      .set({ current_segment_id: this.currentSegmentId })
      .where(eq(supervisorStateTable.id, 1));
  }

  // Runway model: decide whether the segment after `afterMs` is worth
  // proactively planning-only, or worth cutting over to early (see
  // supervisor-runway-threshold-proposal). Ensuring a draft/finalize exists
  // happens regardless of runway — that's just the normal proactive-
  // drafting cadence, which a restart can otherwise miss entirely (tick()'s
  // isNewSegment won't re-fire for an already-current segment). Only early
  // ACTIVATION is gated by runway.
  private async reconcileNext(afterMs: number, nowMs: number): Promise<void> {
    const next = await resolveCurrentSegment(afterMs + 1, this.db);
    if (!next) {
      this.logger?.info({
        process: 'supervisor', event: 'RECONCILE_NO_NEXT_SEGMENT',
      }, 'reconcile: no segment follows current');
      return;
    }

    const remainingSeconds = (afterMs - nowMs) / 1000;
    const nextIsHard = readStartPolicy(next.segment.start_policy).type === 'hard';
    // Hard boundaries can't be pulled earlier — defer entirely to the
    // existing fill/trim gate (maybeHandleHardStartGate), which already
    // runs every tick. The <3s floor still applies regardless: at that
    // point there's nothing meaningful left to distinguish "early" from
    // "at," and it's well within the gate's own 30s tolerance.
    const cutoverAllowed =
      remainingSeconds < RUNWAY_FLOOR_S ||
      (remainingSeconds < RUNWAY_WORTH_IT_THRESHOLD_S && !nextIsHard);

    await this.reconcileOccurrence(next, nowMs, {
      allowActivate: cutoverAllowed,
      targetDurationSeconds: this.computeFirstPassTarget(next.segment),
    });
  }

  // Returns the active plan's own segmentEndMs if it's a genuinely trusted
  // plan for `resolved` — i.e. it doesn't need reconciling against wall-clock
  // resolution — or null if it should be treated as untrustworthy (Decision
  // 57). Reconstructs the segment's end time from the clock's own segment
  // list (same cursor walk resolveSegmentWithinClock uses) rather than
  // re-running the full calendar/template resolution chain — we already know
  // which clock instance and which structural segment.
  //
  // Trusted only if ALL of:
  //   1. status='active' and same clock_instance_started_at as a fresh
  //      resolve (original check).
  //   2. The schedule slot that produced it still resolves to the same
  //      resolution_identity (Decision 58) — a schedule edit since drafting
  //      can point the same clock instance at a structurally different
  //      segment even though the clock_instance timestamp still matches.
  //   3. It has at least one 'pending'/'playing' item left — an
  //      exhausted-but-still-'active' plan (the brief window before
  //      handleExhaustedPlan catches up) must not be silently trusted.
  //   4. Remaining runway is worth preserving (RUNWAY_WORTH_IT_THRESHOLD_S),
  //      symmetric with the gate reconcileNext already applies to the *next*
  //      segment's early cutover.
  // Deliberately NOT disqualifying: being behind or ahead of wall clock —
  // soft reconcile must never skip content to catch up (that's the drift
  // -recovery machinery's job) or undo a legitimate early handoff.
  private async activePlanSegmentEndMs(resolved: ResolvedSegment, nowMs: number): Promise<number | null> {
    if (this.activePlanId == null) return null;
    const [plan] = await this.db
      .select({
        status: plansTable.status,
        clock_instance_started_at: plansTable.clock_instance_started_at,
        resolution_identity: plansTable.resolution_identity,
        segment_id: clockSegmentsTable.id,
        clock_id: clockSegmentsTable.clock_id,
      })
      .from(plansTable)
      .innerJoin(clockSegmentsTable, eq(clockSegmentsTable.id, plansTable.segment_id))
      .where(eq(plansTable.id, this.activePlanId));
    if (!plan || plan.status !== 'active' || plan.clock_instance_started_at !== resolved.clockInstanceStartedAt) {
      return null;
    }
    if (plan.resolution_identity !== computeResolutionIdentity(resolved)) {
      return null;
    }
    if (!(await this.hasPendingOrPlayingItems(this.activePlanId))) {
      return null;
    }
    if ((await this.computeEstimatedRemaining(nowMs)) < RUNWAY_WORTH_IT_THRESHOLD_S) {
      return null;
    }
    const bounds = await segmentBoundsWithinClock(this.db, plan.clock_id, plan.segment_id, resolved.clockInstanceStartedAt);
    return bounds?.endMs ?? null;
  }

  // Same reconstruction as activePlanSegmentEndMs, but for the plan that just
  // exhausted (handleExhaustedPlan) rather than a plan being validated against
  // an externally-known clock instance — there's nothing else to compare
  // against here, this plan already IS this.activePlanId by construction.
  private async exhaustedActivePlanSegmentEndMs(): Promise<number | null> {
    if (this.activePlanId == null) return null;
    const [plan] = await this.db
      .select({
        clock_instance_started_at: plansTable.clock_instance_started_at,
        segment_id: clockSegmentsTable.id,
        clock_id: clockSegmentsTable.clock_id,
      })
      .from(plansTable)
      .innerJoin(clockSegmentsTable, eq(clockSegmentsTable.id, plansTable.segment_id))
      .where(eq(plansTable.id, this.activePlanId));
    if (!plan) return null;
    const bounds = await segmentBoundsWithinClock(this.db, plan.clock_id, plan.segment_id, plan.clock_instance_started_at);
    return bounds?.endMs ?? null;
  }

  // Ensures a valid plan is active (or on its way to being active) for one
  // resolved occurrence. Shared shape for both the current segment (always
  // allowed to activate/self-correct) and the next segment (activation
  // gated by the runway model — see reconcile() above).
  private async reconcileOccurrence(
    resolved: ResolvedSegment,
    nowMs: number,
    opts: { allowActivate: boolean; targetDurationSeconds: number },
  ): Promise<void> {
    const identity = computeResolutionIdentity(resolved);
    const candidates = await this.db
      .select({ id: plansTable.id, status: plansTable.status, resolution_identity: plansTable.resolution_identity })
      .from(plansTable)
      .where(and(
        eq(plansTable.segment_id, resolved.segment.id),
        eq(plansTable.clock_instance_started_at, resolved.clockInstanceStartedAt),
        inArray(plansTable.status, ['draft', 'finalized', 'active']),
      ))
      .orderBy(desc(plansTable.id));
    // A badly-timed restart can leave two draft rows for the same occurrence
    // (a request in flight when the process died, then requested again on
    // reconcile). Deliberately not prevented — the most-recent-wins ordering
    // below absorbs it; the older duplicate just sits unused.
    //
    // But the plan we're already running for this occurrence must never be
    // outranked by a newer duplicate just because it has a higher id — that
    // would swap a live, already-playing plan out for a fresh, unplayed one
    // for no reason. Confirmed live 2026-07-03: a redundant draft created by
    // one reconcile() call got a higher id than the still-correct active
    // plan, and would have been wrongly activated on the next call.
    const activeHere = candidates.find((c) => c.id === this.activePlanId);
    if (activeHere && activeHere.resolution_identity === identity) return;

    const best = candidates[0] ?? null;
    const valid = best != null && best.resolution_identity === identity;

    if (valid && (best.status === 'finalized' || best.status === 'active')) {
      if (opts.allowActivate) {
        if (best.id !== this.activePlanId) {
          this.logger?.info({
            process: 'supervisor', event: 'RECONCILE_ACTIVATE',
            plan_id: best.id, segment_id: resolved.segment.id,
          }, 'reconcile: activating plan');
          await this.activatePlanById(best.id, nowMs, { clearNextPlan: this.nextPlanId === best.id });
        }
      } else if (this.nextPlanId == null) {
        // Not ready to cut over yet, but track it as next so the existing
        // D44 trigger / handleExhaustedPlan can find it when the time comes.
        this.nextPlanId = best.id;
        this.nextPlanSegmentId = resolved.segment.id;
        await this.db.update(supervisorStateTable)
          .set({ next_plan_id: best.id })
          .where(eq(supervisorStateTable.id, 1));
      }
      return;
    }

    if (valid && best.status === 'draft') {
      if (this.finalizationRequestedForPlanId !== best.id) {
        this.finalizationRequestedForPlanId = best.id;
        const requestId = randomUUID();
        // adjusted_target_seconds must reflect what's actually planned, not a
        // placeholder — finalizePlan's reassembly trigger now also fires on
        // |pendingContent - adjustedTarget|, so a literal 0 here reads as "no
        // content wanted at all" and wipes the plan. Confirmed live
        // 2026-07-04: a real 757s draft got reassembled down to 0 items this
        // way. Passing the plan's own current content as the target tells
        // both trigger conditions "no gap, just finalize as-is."
        const currentContentSeconds = await this.sumPendingSeconds(best.id);
        this.logger?.info({
          process: 'supervisor', event: 'PLAN_FINALIZE_REQUESTED',
          plan_id: best.id, request_id: requestId, reconcile: true,
        }, 'reconcile: finalizing existing draft');
        this._bus.emit({
          type: 'PLAN_FINALIZE_REQUESTED',
          request_id: requestId,
          plan_id: best.id,
          now_ms: nowMs,
          adjusted_target_seconds: currentContentSeconds,
          drift_delta_seconds: 0,
          current_drift_seconds: 0,
        });
      }
      return;
    }

    // No valid plan for this occurrence — either none exists, or the one
    // that does was drafted against a schedule that has since changed.
    const requestId = randomUUID();
    this.logger?.info({
      process: 'supervisor', event: 'PLAN_DRAFT_REQUESTED',
      segment_id: resolved.segment.id, target_duration_seconds: opts.targetDurationSeconds,
      request_id: requestId, reconcile: true,
    }, 'reconcile: requesting draft');
    this._bus.emit({
      type: 'PLAN_DRAFT_REQUESTED',
      request_id: requestId,
      segment_id: resolved.segment.id,
      clock_instance_started_at: resolved.clockInstanceStartedAt,
      target_duration_seconds: opts.targetDurationSeconds,
      now_ms: nowMs,
      show_id: resolved.show_id,
      show_name: resolved.show_name,
      resolution_identity: identity,
    });
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

    // Don't let a new draft silently replace a next_plan that's already
    // mid-flight (pushed, partially aired) with content still waiting to be
    // queued — that content would otherwise be silently skipped once the
    // active plan runs dry and the queue feeder's fallback jumps straight to
    // whatever next_plan_id now points at. Leave it in 'draft' status;
    // maybeRequestNextDraft's existing adoption lookup (matches on segment_id
    // + clock_instance_started_at) picks it up once next_plan_id frees up.
    if (this.nextPlanId != null && this.nextPlanId !== msg.plan_id && await this.hasPendingItems(this.nextPlanId)) {
      this.logger?.info({
        process: 'supervisor', event: 'NEXT_PLAN_DRAFT_DEFERRED',
        held_plan_id: this.nextPlanId, deferred_plan_id: msg.plan_id, segment_id: msg.segment_id,
      }, 'supervisor: keeping current next_plan — still has pending content; new draft deferred');
      return;
    }

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
      // See the matching comment in reconcileOccurrence: adjusted_target_seconds
      // must reflect the plan's actual content, not a 0 placeholder, now that
      // finalizePlan's reassembly trigger also fires on the content-vs-target
      // gap — a literal 0 would wipe a real cold-start draft's content.
      const currentContentSeconds = await this.sumPendingSeconds(msg.plan_id);
      this.logger?.info({
        process: 'supervisor', event: 'PLAN_FINALIZE_REQUESTED',
        plan_id: msg.plan_id, request_id: requestId, cold_start: true,
      }, 'supervisor: cold start — immediately finalizing draft');
      this._bus.emit({
        type: 'PLAN_FINALIZE_REQUESTED',
        request_id: requestId,
        plan_id: msg.plan_id,
        now_ms: Date.now(),
        adjusted_target_seconds: currentContentSeconds,
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
      // activateNextPlan -> activatePlanById already requests the next
      // draft itself now, anchored to the plan that just activated rather
      // than this.cachedSegment (wall-clock-based, can diverge under drift).
      await this.activateNextPlan(Date.now());
    }
  }

  // ─── Draft request helpers ───────────────────────────────────────────────────

  // Both boundaryDrift and plannedOvershoot represent accumulated lateness at
  // the upcoming segment boundary. Subtracting both from nominal pre-corrects
  // the draft so boundary drift self-corrects in one plan cycle.
  //
  // Recovery cap: allow up to 1.5× nominal when the station is running early
  // (negative boundary drift). Without this, the min(nominal, …) ceiling
  // means negative drift can never self-correct — every plan targets exactly
  // nominal and the early-running condition persists indefinitely. The 1.5×
  // cap limits per-segment catch-up so the planner doesn't try to fill 5×
  // nominal with branding when music pools are short.
  //
  // Stop-sets get a higher floor (their own nominal, not the generic 30s):
  // an ad break shouldn't be shrunk to absorb an unrelated segment's
  // overshoot. Confirmed live 2026-07-04: a +209s overshoot elsewhere pushed
  // a 120s stop-set's target to the 30s floor, leaving it with one 16-second
  // spot. Protecting the floor doesn't lose the correction — it just carries
  // forward as accumulated drift for whatever flexible segment comes next.
  private computeFirstPassTarget(segment: { type: string; duration_seconds: number }): number {
    const nominal = segment.duration_seconds;
    const floor = segment.type === 'stop_set' ? nominal : 30;
    return Math.max(
      floor,
      Math.min(
        nominal * 1.5,
        nominal - (this.boundaryDriftSeconds + this.plannedOvershootSeconds),
      ),
    );
  }

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
      resolution_identity: computeResolutionIdentity(resolved),
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

    // Only look for draft/finalized — an 'active' plan is already in use and
    // should not prevent creating a new plan for the next segment.
    const [existing] = await this.db
      .select({ id: plansTable.id, status: plansTable.status })
      .from(plansTable)
      .where(and(
        eq(plansTable.segment_id, next.segment.id),
        eq(plansTable.clock_instance_started_at, next.clockInstanceStartedAt),
        inArray(plansTable.status, ['draft', 'finalized']),
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

    const firstPassTarget = this.computeFirstPassTarget(next.segment);

    // Store segment end time so activateNextPlan can compute boundary drift.
    this.nextPlanScheduledEndMs = next.segmentEndMs;
    this.draftedForNextSegment = { segmentId: next.segment.id, instanceMs: next.clockInstanceStartedAt };
    const requestId = randomUUID();
    this.logger?.info({
      process: 'supervisor', event: 'PLAN_DRAFT_REQUESTED',
      segment_id: next.segment.id,
      target_duration_seconds: firstPassTarget,
      nominal_duration_seconds: next.segment.duration_seconds,
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
      resolution_identity: computeResolutionIdentity(next),
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

  // Mirrors the in-memory "what's playing right now" pointer to supervisor_state
  // so a restart can reconstruct it (Decision 59) instead of blind-resetting
  // every 'playing' plan_item to 'pending' in hydrateFromDb.
  private async setCurrentPlayHistoryId(id: number | null): Promise<void> {
    this.currentPlayHistoryId = id;
    await this.db.update(supervisorStateTable)
      .set({ current_play_history_id: id })
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
