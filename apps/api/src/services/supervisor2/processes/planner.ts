// Planner — Phase 3.
//
// Driven by the Supervisor via three bus messages:
//   - PLAN_DRAFT_REQUESTED    → buildPlan() → writes plans + plan_items
//                               (status='draft') → emit PLAN_DRAFT_READY
//   - PLAN_FINALIZE_REQUESTED → finalizePlan() → re-validate pending items
//                               against fresh pacing → emit PLAN_FINALIZED
//   - PLAN_REPLAN_REQUESTED   → replanRemaining() → drop pending items from
//                               from_position onwards and re-assemble the
//                               remainder → emit PLAN_REPLANNED
//
// The Planner is the only place that decides what goes into a plan. It pulls
// candidate pools from the four content processes via the bus
// (REQUEST_CANDIDATES / CANDIDATES) and assembles them per segment type. It
// then sends CONFIRM_USED + RETURN_UNUSED so content processes can advance
// their state. On replan it sends DROP_COMMITTED to reverse previously-
// confirmed items.
//
// Decision-relevant references:
//   Decision 7  — two-pass (draft + finalize) model
//   Decision 8  — gap filling owned by planner via coasting_order
//   Decision 11 — REQUEST_CANDIDATES → CANDIDATES → CONFIRM_USED → RETURN_UNUSED
//   Decision 14 — stop-set space estimate written to stop_set_estimates
//   Decision 20 — drift framework drives replans (Supervisor's job)
//   Decision 22 — Planner enforces placement constraints (advertiser
//                 separation, competing exclusions, first-in-slot)
//   Decision 27 — coasting_order vocabulary: songs/jingles/station_ids/spots/promos
//   Decision 28 — stop_set_estimates: separate table
//   Decision 31 — full re-assembly at second pass when |drift_delta| >= threshold
//   Decision 34 — cut_allowed + skip_allowed per plan_item from supervisor_config
//   Decision 35 — rundown segments exempt from drift target adjustment
//   Decision 40 — show envelope detection and placement
//
// All async errors inside event handlers are caught and logged. The Planner
// works offline — it never calls HarborClient.

import { randomUUID } from 'crypto';
import { and, asc, eq, gt, gte, inArray } from 'drizzle-orm';
import type { SLogger } from '../supervisorLogger.js';

import { db as defaultDb } from '../../../db/index.js';
import {
  clockSegments,
  plans as plansTable,
  planItems as planItemsTable,
  stopSetEstimates as stopSetEstimatesTable,
  supervisorConfig as supervisorConfigTable,
  type ClockSegment,
  type PlanItemContentType,
  type PlanItemInsert,
  type SupervisorConfig,
} from '../../../db/schema.js';
import { resolveCurrentSegment } from '../clockResolver.js';
import { bus, type BusMessage, type ContentProcessName } from '../bus.js';
import type {
  BrandingCandidate,
  BrandingCandidatePool,
  CampaignCandidate,
  MusicCandidate,
  MusicCandidatePool,
  PromoCandidate,
  RundownCandidatePool,
  SpotCandidate,
  StopSetCandidatePool,
} from '../types.js';

// Minimum gap (seconds) below which we accept silence rather than try to fill.
const MIN_FILL_GAP_SECONDS = 5;
// Default request/response timeout for content process calls. Generous —
// content processes do real DB work but should complete well inside this.
const CANDIDATE_REQUEST_TIMEOUT_MS = 10_000;
// Hard-end segments may not overshoot. Flexible-end segments may overshoot
// by at most this much before we stop walking music candidates.
const FLEXIBLE_OVERSHOOT_TOLERANCE_SECONDS = 30;
// Minimum spot duration the planner will attempt to place in a stop-set
// break — below this the spot pool is treated as exhausted.
const MIN_VIABLE_SPOT_DURATION_SECONDS = 15;

interface PendingAssemblyItem {
  media_id: number;
  content_type: PlanItemContentType;
  campaign_id: number | null;
  music_campaign_id: number | null;
  planned_duration_seconds: number;
  mandatory: boolean;
  reason: string;
  // D34: cut/skip permissions — derived from supervisor_config defaults;
  // show envelopes always carry false/false.
  cut_allowed: boolean;
  skip_allowed: boolean;
  // ids returned by the content process — used to send CONFIRM_USED /
  // RETURN_UNUSED back to the same process.
  music_candidate_id?: number;
  branding_candidate_id?: number;
  campaign_candidate_id?: number;
  promo_candidate_id?: number;
  rundown_candidate_id?: number;
}

interface AssemblyResult {
  items: PendingAssemblyItem[];
  // ids the planner did not place — content processes use these for
  // rotation-fairness signalling, no state change required.
  unused_music_ids: number[];
  unused_branding_ids: number[];
  unused_campaign_ids: number[];
  unused_promo_ids: number[];
  unused_rundown_ids: number[];
  // Optional space estimate persisted to stop_set_estimates for stop-set plans.
  space_estimate?: StopSetCandidatePool['space_estimate'];
}

// Show context carried into the assembly methods (D40).
interface ShowContext {
  showId: number | null;
  showName: string | null;
  // True when this segment is the first segment of the first clock instance
  // of the show block — a show_start envelope should be placed here (D40).
  isShowStart: boolean;
  // True when this segment is the last segment of the last clock instance
  // of the show block — a show_end envelope should be placed here (D40).
  isShowEnd: boolean;
  // supervisor_config row — carried in ShowContext so every assembly helper
  // can compute cut_allowed/skip_allowed without a separate DB call.
  config: SupervisorConfig;
}

export class PlannerProcess {
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly _bus: typeof bus,
    private readonly db: typeof defaultDb = defaultDb,
    private readonly logger: SLogger | null = null,
  ) {}

  start(): void {
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'PLAN_DRAFT_REQUESTED' }>(
        'PLAN_DRAFT_REQUESTED',
        (msg) => {
          void this.handleDraftRequested(msg).catch((err) => {
            this.logger?.error(
              { err, event: 'PLAN_DRAFT_FAILED', request_id: msg.request_id },
              'planner: draft request failed',
            );
          });
        },
      ),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'PLAN_FINALIZE_REQUESTED' }>(
        'PLAN_FINALIZE_REQUESTED',
        (msg) => {
          void this.handleFinalizeRequested(msg).catch((err) => {
            this.logger?.error(
              { err, event: 'PLAN_FINALIZE_FAILED', request_id: msg.request_id },
              'planner: finalize request failed',
            );
          });
        },
      ),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'PLAN_REPLAN_REQUESTED' }>(
        'PLAN_REPLAN_REQUESTED',
        (msg) => {
          void this.handleReplanRequested(msg).catch((err) => {
            this.logger?.error(
              { err, event: 'PLAN_REPLAN_FAILED', request_id: msg.request_id },
              'planner: replan request failed',
            );
          });
        },
      ),
    );
  }

  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }

  // ─── Bus handlers ───────────────────────────────────────────────────────────

  private async handleDraftRequested(
    msg: BusMessage & { type: 'PLAN_DRAFT_REQUESTED' },
  ): Promise<void> {
    const planId = await this.buildPlan(
      msg.segment_id,
      msg.clock_instance_started_at,
      msg.target_duration_seconds,
      msg.now_ms,
      msg.show_id,
      msg.show_name,
    );
    this._bus.emit({
      type: 'PLAN_DRAFT_READY',
      request_id: msg.request_id,
      plan_id: planId,
      segment_id: msg.segment_id,
    });
  }

  private async handleFinalizeRequested(
    msg: BusMessage & { type: 'PLAN_FINALIZE_REQUESTED' },
  ): Promise<void> {
    await this.finalizePlan(
      msg.plan_id,
      msg.now_ms,
      msg.adjusted_target_seconds,
      msg.drift_delta_seconds,
      msg.current_drift_seconds,
    );
    this._bus.emit({
      type: 'PLAN_FINALIZED',
      request_id: msg.request_id,
      plan_id: msg.plan_id,
    });
  }

  private async handleReplanRequested(
    msg: BusMessage & { type: 'PLAN_REPLAN_REQUESTED' },
  ): Promise<void> {
    await this.replanRemaining(
      msg.plan_id,
      msg.from_position,
      msg.remaining_seconds,
      msg.now_ms,
    );
    this._bus.emit({
      type: 'PLAN_REPLANNED',
      request_id: msg.request_id,
      plan_id: msg.plan_id,
    });
  }

  // ─── Public entry points ────────────────────────────────────────────────────

  // Builds a draft plan and writes plan + plan_items to SQLite. Returns plan_id.
  async buildPlan(
    segmentId: number,
    clockInstanceStartedAt: number,
    targetDurationSeconds: number,
    nowMs: number,
    showId: number | null,
    showName: string | null,
  ): Promise<number> {
    const [segment] = await this.db
      .select()
      .from(clockSegments)
      .where(eq(clockSegments.id, segmentId));
    if (!segment) {
      throw new Error(`planner.buildPlan: segment ${segmentId} not found`);
    }

    // Live segments have no automated content — write only the plans row so
    // the Supervisor can track the segment lifecycle. plan_items.media_id has
    // a NOT NULL FK; we cannot store a sentinel-less placeholder, so we
    // intentionally skip plan_items for live segments. The Supervisor / Queue
    // Feeder treat an empty plan as a live-suspension marker.
    if (segment.type === 'live') {
      return this.insertPlanRow(segment, clockInstanceStartedAt, nowMs);
    }

    const config = await this.loadSupervisorConfig();

    let isShowStart = false;
    let isShowEnd = false;
    if (showId != null) {
      const flags = await this.getShowBoundaryFlags(
        segment.id,
        segment.clock_id,
        clockInstanceStartedAt,
        showId,
      );
      isShowStart = flags.isShowStart;
      isShowEnd = flags.isShowEnd;
    }

    const showCtx: ShowContext = { showId, showName, isShowStart, isShowEnd, config };

    const planId = await this.insertPlanRow(segment, clockInstanceStartedAt, nowMs);

    const result = await this.assembleForSegment(
      segment,
      clockInstanceStartedAt,
      targetDurationSeconds,
      nowMs,
      showCtx,
    );

    await this.persistPlanItems(planId, result.items);
    await this.notifyContentProcesses(result, planId, nowMs);
    await this.persistStopSetEstimateIfAny(planId, segment.id, result.space_estimate, nowMs);

    // B2: count items by content_type for post-mortem analysis.
    let music_count = 0, campaign_count = 0, branding_count = 0, rundown_count = 0;
    let total_planned_seconds = 0;
    for (const item of result.items) {
      total_planned_seconds += item.planned_duration_seconds;
      if (item.content_type === 'music') music_count++;
      else if (item.content_type === 'campaign' || item.content_type === 'promo') campaign_count++;
      else if (item.content_type === 'jingle' || item.content_type === 'station_id' || item.content_type === 'branding') branding_count++;
      else if (item.content_type === 'rundown') rundown_count++;
    }
    this.logger?.info(
      {
        event: 'PLAN_DRAFT_COMPLETE',
        plan_id: planId,
        segment_id: segment.id,
        segment_type: segment.type,
        item_count: result.items.length,
        music_count,
        campaign_count,
        branding_count,
        rundown_count,
        total_planned_seconds: Math.round(total_planned_seconds),
        is_show_start: isShowStart,
        is_show_end: isShowEnd,
      },
      'planner: draft complete',
    );

    return planId;
  }

  // Finalization pass (D31). When |drift_delta_seconds| >= threshold, drops
  // all pending items and runs a full re-assembly with adjusted_target_seconds.
  // Otherwise runs the lightweight substitution pass (re-validates pacing only).
  // Rundown segments (news/bulletin) are always lightweight — they are exempt
  // from drift target adjustment (D35). Updates plan status to 'finalized'.
  async finalizePlan(
    planId: number,
    nowMs: number,
    adjustedTargetSeconds: number,
    driftDeltaSeconds: number,
    currentDriftSeconds: number,
  ): Promise<void> {
    void currentDriftSeconds; // logged by supervisor; planner just records finalize event
    const [plan] = await this.db
      .select()
      .from(plansTable)
      .where(eq(plansTable.id, planId));
    if (!plan) {
      throw new Error(`planner.finalizePlan: plan ${planId} not found`);
    }
    const [segment] = await this.db
      .select()
      .from(clockSegments)
      .where(eq(clockSegments.id, plan.segment_id));
    if (!segment) {
      throw new Error(
        `planner.finalizePlan: segment ${plan.segment_id} not found for plan ${planId}`,
      );
    }

    // Live segments carry no plan_items — just stamp finalization.
    if (segment.type === 'live') {
      await this.db
        .update(plansTable)
        .set({ status: 'finalized', finalized_at: nowMs })
        .where(eq(plansTable.id, planId));
      return;
    }

    const config = await this.loadSupervisorConfig();
    const threshold = config.second_pass_drift_delta_threshold_s;

    // Rundown segments are exempt from drift target adjustment (D35).
    const isRundown = segment.type === 'news' || segment.type === 'bulletin';
    const needsFullReassembly = !isRundown && Math.abs(driftDeltaSeconds) >= threshold;

    let substitutions = 0;

    if (needsFullReassembly) {
      // Full re-assembly: drop all pending items, rebuild from scratch with
      // the drift-adjusted target (D31).
      const pendingItems = await this.db
        .select()
        .from(planItemsTable)
        .where(and(eq(planItemsTable.plan_id, planId), eq(planItemsTable.status, 'pending')));

      const dropMusic: number[] = [];
      const dropBranding: number[] = [];
      const dropCampaign: number[] = [];
      const dropRundown: number[] = [];
      for (const it of pendingItems) {
        switch (it.content_type) {
          case 'music': dropMusic.push(it.media_id); break;
          case 'jingle':
          case 'station_id':
          case 'branding':
          case 'filler': dropBranding.push(it.media_id); break;
          case 'campaign':
          case 'promo': dropCampaign.push(it.media_id); break;
          case 'rundown':
          case 'voice_track': dropRundown.push(it.media_id); break;
        }
      }
      if (dropMusic.length > 0) this.emitDrop('music', dropMusic);
      if (dropBranding.length > 0) this.emitDrop('branding', dropBranding);
      if (dropCampaign.length > 0) this.emitDrop('campaign', dropCampaign);
      if (dropRundown.length > 0) this.emitDrop('rundown', dropRundown);

      if (pendingItems.length > 0) {
        await this.db
          .delete(planItemsTable)
          .where(inArray(planItemsTable.id, pendingItems.map((it) => it.id)));
      }

      // Re-derive show context from the calendar at the plan's clock instance.
      const showResolved = await resolveCurrentSegment(plan.clock_instance_started_at + 1, this.db);
      const showId = showResolved?.show_id ?? null;
      const showName = showResolved?.show_name ?? null;
      let isShowStart = false;
      let isShowEnd = false;
      if (showId != null) {
        const flags = await this.getShowBoundaryFlags(
          segment.id,
          segment.clock_id,
          plan.clock_instance_started_at,
          showId,
        );
        isShowStart = flags.isShowStart;
        isShowEnd = flags.isShowEnd;
      }

      const showCtx: ShowContext = { showId, showName, isShowStart, isShowEnd, config };
      const result = await this.assembleForSegment(
        segment,
        plan.clock_instance_started_at,
        adjustedTargetSeconds,
        nowMs,
        showCtx,
      );

      await this.persistPlanItems(planId, result.items);
      await this.notifyContentProcesses(result, planId, nowMs);
      await this.persistStopSetEstimateIfAny(planId, segment.id, result.space_estimate, nowMs);

      this.logger?.info(
        {
          event: 'PLAN_FINALIZE_FULL_REASSEMBLY',
          plan_id: planId,
          segment_id: segment.id,
          drift_delta_seconds: driftDeltaSeconds,
          adjusted_target_seconds: adjustedTargetSeconds,
          dropped_count: pendingItems.length,
          added_count: result.items.length,
        },
        'planner: finalize full re-assembly',
      );
    } else {
      // Lightweight substitution: re-request candidate pools and replace any
      // pending item whose backing candidate has disappeared (campaign hit
      // daily cap, etc.). Does not restructure the plan.
      const pendingItems = await this.db
        .select()
        .from(planItemsTable)
        .where(and(eq(planItemsTable.plan_id, planId), eq(planItemsTable.status, 'pending')));

      if (pendingItems.length > 0) {
        const sumPending = pendingItems.reduce(
          (acc, it) => acc + it.planned_duration_seconds,
          0,
        );
        const freshMusic =
          segment.type === 'music' || hasMusicGapNeeds(segment)
            ? await this.requestPool<MusicCandidatePool>('music', segment, plan, sumPending, nowMs)
            : null;
        const freshCampaign =
          segment.type === 'stop_set'
            ? await this.requestPool<StopSetCandidatePool>(
                'campaign',
                segment,
                plan,
                sumPending,
                nowMs,
              )
            : null;

        for (const item of pendingItems) {
          const stillValid = isItemStillValid(item, freshMusic, freshCampaign);
          if (stillValid) continue;
          const replacement = pickReplacement(item, freshMusic, freshCampaign, config);
          if (!replacement) continue;
          await this.db
            .delete(planItemsTable)
            .where(eq(planItemsTable.id, item.id));
          await this.db.insert(planItemsTable).values({
            plan_id: planId,
            position: item.position,
            media_id: replacement.media_id,
            content_type: replacement.content_type,
            campaign_id: replacement.campaign_id,
            music_campaign_id: replacement.music_campaign_id,
            planned_duration_seconds: replacement.planned_duration_seconds,
            mandatory: replacement.mandatory,
            reason: `${replacement.reason} (finalize substitution)`,
            status: 'pending',
            cut_allowed: replacement.cut_allowed ? 1 : 0,
            skip_allowed: replacement.skip_allowed ? 1 : 0,
          });
          substitutions += 1;
        }

        // Upsert the stop-set estimate with fresh numbers if available (D28).
        if (freshCampaign) {
          await this.persistStopSetEstimateIfAny(
            planId,
            segment.id,
            freshCampaign.space_estimate,
            nowMs,
          );
        }
      }
    }

    await this.db
      .update(plansTable)
      .set({ status: 'finalized', finalized_at: nowMs })
      .where(eq(plansTable.id, planId));

    this.logger?.info(
      {
        event: 'PLAN_FINALIZE_COMPLETE',
        plan_id: planId,
        segment_id: segment.id,
        drift_delta_seconds: driftDeltaSeconds,
        full_reassembly: needsFullReassembly,
        substitutions: needsFullReassembly ? 0 : substitutions,
      },
      'planner: finalize complete',
    );
  }

  // Drops every pending plan_item at position >= fromPosition, signals
  // content processes that those items are no longer committed, then runs the
  // segment-type assembler against `remainingSeconds` and re-inserts new
  // pending items starting from `fromPosition`.
  async replanRemaining(
    planId: number,
    fromPosition: number,
    remainingSeconds: number,
    nowMs: number,
  ): Promise<void> {
    const [plan] = await this.db
      .select()
      .from(plansTable)
      .where(eq(plansTable.id, planId));
    if (!plan) {
      throw new Error(`planner.replanRemaining: plan ${planId} not found`);
    }
    const [segment] = await this.db
      .select()
      .from(clockSegments)
      .where(eq(clockSegments.id, plan.segment_id));
    if (!segment) {
      throw new Error(
        `planner.replanRemaining: segment ${plan.segment_id} not found for plan ${planId}`,
      );
    }
    if (segment.type === 'live') {
      // Nothing to replan for live segments.
      return;
    }

    const dropping = await this.db
      .select()
      .from(planItemsTable)
      .where(
        and(
          eq(planItemsTable.plan_id, planId),
          eq(planItemsTable.status, 'pending'),
          gte(planItemsTable.position, fromPosition),
        ),
      );

    // Bucket dropped items by content process so we can send a single
    // DROP_COMMITTED per process with all the affected ids.
    const dropMusic: number[] = [];
    const dropBranding: number[] = [];
    const dropCampaign: number[] = [];
    const dropRundown: number[] = [];
    for (const it of dropping) {
      switch (it.content_type) {
        case 'music':
          dropMusic.push(it.media_id);
          break;
        case 'jingle':
        case 'station_id':
        case 'branding':
        case 'filler':
          dropBranding.push(it.media_id);
          break;
        case 'campaign':
        case 'promo':
          dropCampaign.push(it.media_id);
          break;
        case 'rundown':
        case 'voice_track':
          dropRundown.push(it.media_id);
          break;
      }
    }
    if (dropMusic.length > 0) this.emitDrop('music', dropMusic);
    if (dropBranding.length > 0) this.emitDrop('branding', dropBranding);
    if (dropCampaign.length > 0) this.emitDrop('campaign', dropCampaign);
    if (dropRundown.length > 0) this.emitDrop('rundown', dropRundown);

    // Delete superseded items before re-assembling so the replacement
    // positions are reserved cleanly and rows don't accumulate in the DB.
    if (dropping.length > 0) {
      await this.db
        .delete(planItemsTable)
        .where(inArray(planItemsTable.id, dropping.map((it) => it.id)));
    }

    const config = await this.loadSupervisorConfig();

    // For mid-segment replanning, the show context is unchanged (show
    // envelopes played at the start/end are not re-inserted). Pass show_id
    // for branding pool selection but disable envelope insertion.
    const showResolved = await resolveCurrentSegment(plan.clock_instance_started_at + 1, this.db);
    const showCtx: ShowContext = {
      showId: showResolved?.show_id ?? null,
      showName: showResolved?.show_name ?? null,
      isShowStart: false,
      isShowEnd: false,
      config,
    };

    const result = await this.assembleForSegment(
      segment,
      plan.clock_instance_started_at,
      remainingSeconds,
      nowMs,
      showCtx,
    );

    // Re-insert from fromPosition.
    let pos = fromPosition;
    for (const item of result.items) {
      await this.db.insert(planItemsTable).values(toInsertRow(planId, pos, item));
      pos += 1;
    }

    await this.notifyContentProcesses(result, planId, nowMs);
    await this.persistStopSetEstimateIfAny(planId, segment.id, result.space_estimate, nowMs);

    this.logger?.info(
      {
        event: 'PLAN_REPLAN',
        plan_id: planId,
        segment_id: segment.id,
        dropped_count: dropping.length,
        added_count: result.items.length,
        from_position: fromPosition,
      },
      'planner: replan complete',
    );
  }

  // ─── Segment-type dispatch ──────────────────────────────────────────────────

  private async assembleForSegment(
    segment: ClockSegment,
    clockInstanceStartedAt: number,
    targetDurationSeconds: number,
    nowMs: number,
    showCtx: ShowContext,
  ): Promise<AssemblyResult> {
    switch (segment.type) {
      case 'music':
        return this.assembleMusicPlan(
          segment,
          clockInstanceStartedAt,
          targetDurationSeconds,
          nowMs,
          showCtx,
        );
      case 'stop_set':
        return this.assembleStopSetPlan(
          segment,
          clockInstanceStartedAt,
          targetDurationSeconds,
          nowMs,
          showCtx,
        );
      case 'news':
      case 'bulletin':
      case 'voice_track':
        return this.assembleRundownPlan(
          segment,
          clockInstanceStartedAt,
          targetDurationSeconds,
          nowMs,
          showCtx,
        );
      case 'live':
        return emptyResult();
      default:
        return emptyResult();
    }
  }

  // ─── Music segment assembly ─────────────────────────────────────────────────
  //
  // Assembly order and rules for a music segment:
  //
  //  (0) Show-start envelope (if first segment of show block).
  //  (a) Segment-start envelope.
  //  (b/c) Music + interstitial cadence loop:
  //    - Iterates music candidates in LRP rotation order.
  //    - For each candidate: check tryFitItem FIRST (track must fit within
  //      remaining + 30s overshoot tolerance) before injecting any interstitials.
  //      This is critical — if the check came after, a station ID or jingle would
  //      fire for every skipped candidate while musicCount stays constant,
  //      exhausting the branding pool in a burst.
  //    - When the track fits and musicCount % N == 0, inject the configured
  //      interstitial (jingle and/or station ID) before placing the track.
  //    - Loop exits when remaining ≤ −30s (overshoot limit) or all candidates
  //      have been visited.
  //  (d) End-of-segment gap handling — bidirectional ±30s tolerance:
  //    - Runs only if remaining > 30s after the music loop (gap too large to accept).
  //    - d1: try one branding item (station ID or jingle, longest first) that
  //      lands remaining inside [−30, +30]. At most one item is placed.
  //    - d2: if still > 30s, find the unplaced music candidate with the smallest
  //      overshoot (duration − remaining). Apply the bidirectional rule:
  //        · overshoot ≤ 30s            → place normally (overshoot < undershoot)
  //        · overshoot > 30s, overshoot < remaining, next segment is hard
  //                                     → place with cut_allowed=true; the audio
  //                                       engine hard-stops at the boundary
  //        · otherwise                  → leave the gap; for flexible next segments
  //                                       drift self-corrects in the next plan; for
  //                                       hard next segments the hard-start gate
  //                                       handles ≤30s residuals at T−30s
  //  (e) Segment-end envelope.
  //  (f) Show-end envelope (if last segment of show block).
  //
  // The pool is overserved by POOL_MULTIPLIER (2.5×) so d2 has candidates
  // available for the end-of-segment fit even after the main loop places its fill.
  // No arrangement-trying occurs — the pass is a single greedy sweep.

  private async assembleMusicPlan(
    segment: ClockSegment,
    clockInstanceStartedAt: number,
    targetDurationSeconds: number,
    nowMs: number,
    showCtx: ShowContext,
  ): Promise<AssemblyResult> {
    const { config } = showCtx;
    const instance = { segment_id: segment.id, clock_instance_started_at: clockInstanceStartedAt };
    const music = await this.requestPool<MusicCandidatePool>(
      'music',
      segment,
      instance,
      targetDurationSeconds,
      nowMs,
    );
    const branding = await this.requestPool<BrandingCandidatePool>(
      'branding',
      segment,
      instance,
      targetDurationSeconds,
      nowMs,
      showCtx.showId,
    );

    const items: PendingAssemblyItem[] = [];
    const usedMusicIds = new Set<number>();
    const usedBrandingIds = new Set<number>();

    const isHardEnd = readStartPolicy(segment.start_policy).type === 'hard';
    const segmentStart = branding.segment_start;
    const segmentEnd = branding.segment_end;

    // Reserve durations up-front so music fill stays within budget.
    const showStartDur = (showCtx.isShowStart && branding.show_start)
      ? branding.show_start.duration_seconds : 0;
    const showEndReserve = (showCtx.isShowEnd && branding.show_end)
      ? branding.show_end.duration_seconds : 0;
    const segStartDur = segmentStart?.duration_seconds ?? 0;
    const segEndReserve = segmentEnd?.duration_seconds ?? 0;

    let remaining = targetDurationSeconds - showStartDur - segStartDur - segEndReserve - showEndReserve;

    // (0) Show-start envelope — placed before segment-start envelope (D40).
    if (showCtx.isShowStart && branding.show_start) {
      items.push(showEnvelopeItem(branding.show_start, 'show_start envelope'));
      usedBrandingIds.add(branding.show_start.id);
    }

    // (a) Segment-start envelope.
    if (segmentStart) {
      items.push(withCutSkip(
        brandingToItem(segmentStart, 'segment_start envelope'),
        config,
      ));
      usedBrandingIds.add(segmentStart.id);
    }

    // (b/c) Music + interstitial cadence.
    const jinglesEnabled = segment.interstitial_jingles_enabled;
    const jingleEveryN = segment.jingle_every_n_tracks ?? 0;
    const stationIdsEnabled = segment.interstitial_station_id_enabled;
    const stationIdEveryN = segment.station_id_every_n_tracks ?? 0;

    let jingleCursor = 0;
    let stationIdCursor = 0;
    let musicCount = 0;

    const tryFitItem = (durationSeconds: number): boolean => {
      if (isHardEnd) {
        return durationSeconds <= remaining;
      }
      return durationSeconds <= remaining + FLEXIBLE_OVERSHOOT_TOLERANCE_SECONDS;
    };

    for (const candidate of music.candidates) {
      if (usedMusicIds.has(candidate.id)) continue;
      if (remaining <= 0 && isHardEnd) break;
      if (remaining <= -FLEXIBLE_OVERSHOOT_TOLERANCE_SECONDS) break;

      // Check if the music track fits before injecting any interstitials.
      // Interstitials must not fire for skipped candidates — otherwise musicCount
      // stays constant and the "every N tracks" condition fires for every rejected
      // candidate, exhausting the branding pool in a burst.
      if (!tryFitItem(candidate.duration_seconds)) {
        continue;
      }

      // Interstitial injection before each music track (except the very first).
      if (musicCount > 0) {
        if (
          jinglesEnabled &&
          jingleEveryN > 0 &&
          musicCount % jingleEveryN === 0 &&
          branding.jingles.length > 0
        ) {
          const j = nextBrandingPick(branding.jingles, jingleCursor, usedBrandingIds);
          if (j && tryFitItem(j.duration_seconds)) {
            items.push(withCutSkip(
              brandingToItem(j, `interstitial jingle every ${jingleEveryN} tracks`),
              config,
            ));
            usedBrandingIds.add(j.id);
            remaining -= j.duration_seconds;
            jingleCursor = j.cursor + 1;
          }
        }
        if (
          stationIdsEnabled &&
          stationIdEveryN > 0 &&
          musicCount % stationIdEveryN === 0 &&
          branding.station_ids.length > 0
        ) {
          const s = nextBrandingPick(branding.station_ids, stationIdCursor, usedBrandingIds);
          if (s && tryFitItem(s.duration_seconds)) {
            items.push(withCutSkip(
              brandingToItem(s, `interstitial station_id every ${stationIdEveryN} tracks`),
              config,
            ));
            usedBrandingIds.add(s.id);
            remaining -= s.duration_seconds;
            stationIdCursor = s.cursor + 1;
          }
        }
      }

      items.push(withCutSkip(musicCandidateToItem(candidate), config));
      usedMusicIds.add(candidate.id);
      remaining -= candidate.duration_seconds;
      musicCount += 1;
    }

    // (d) End-of-segment gap handling.
    // When remaining > 30s (outside the undershoot tolerance window), the loop
    // ended without filling the target. Apply a two-step approach:
    //   d1. Try a single branding item (station ID or jingle, longest first) that
    //       lands remaining inside [−30, +30] — i.e., closer to the target than
    //       leaving the gap as-is.
    //   d2. Find the unplaced music candidate with the smallest overshoot and
    //       apply the bidirectional 30s tolerance rule:
    //         - overshoot ≤ 30s  →  place normally (overshoot < undershoot by definition)
    //         - overshoot > 30s, overshoot < remaining, next is hard  →  place with
    //           cut_allowed=true so the audio engine hard-stops at the boundary
    //         - otherwise  →  leave the gap (next is flexible; drift self-corrects)
    if (remaining > FLEXIBLE_OVERSHOOT_TOLERANCE_SECONDS) {
      // d1: one branding item to close the gap into tolerance.
      const availableBranding = [
        ...branding.station_ids.filter(c => !usedBrandingIds.has(c.id)),
        ...branding.jingles.filter(c => !usedBrandingIds.has(c.id)),
      ].sort((a, b) => b.duration_seconds - a.duration_seconds); // longest first

      for (const bc of availableBranding) {
        const afterPlace = remaining - bc.duration_seconds;
        const deviationIfPlaced = Math.abs(afterPlace);
        if (deviationIfPlaced <= FLEXIBLE_OVERSHOOT_TOLERANCE_SECONDS && deviationIfPlaced < remaining) {
          items.push(withCutSkip(
            brandingToItem(bc, `end-of-segment branding fill: gap≈${Math.round(remaining)}s`),
            config,
          ));
          usedBrandingIds.add(bc.id);
          remaining = afterPlace;
          break;
        }
      }

      // d2: best-fit unplaced music candidate with bidirectional tolerance.
      if (remaining > FLEXIBLE_OVERSHOOT_TOLERANCE_SECONDS) {
        const nextPolicy = await this.lookupNextSegmentPolicy(segment);
        const isNextHard = nextPolicy.type === 'hard';

        const bestFit = music.candidates
          .filter(c => !usedMusicIds.has(c.id) && c.duration_seconds > remaining)
          .sort((a, b) => (a.duration_seconds - remaining) - (b.duration_seconds - remaining))[0]
          ?? null;

        if (bestFit) {
          const overshoot = bestFit.duration_seconds - remaining;
          if (overshoot <= FLEXIBLE_OVERSHOOT_TOLERANCE_SECONDS) {
            // Overshoot within tolerance and smaller than the undershoot — place normally.
            items.push(withCutSkip(musicCandidateToItem(bestFit), config));
            usedMusicIds.add(bestFit.id);
            remaining -= bestFit.duration_seconds;
          } else if (isNextHard && overshoot < remaining) {
            // Neither tolerance qualifies, but overshoot is the smaller of the two
            // deviations and the next boundary is hard: silence is unacceptable.
            // Place with cut_allowed=true — the audio engine hard-stops at the boundary.
            items.push({ ...withCutSkip(musicCandidateToItem(bestFit), config), cut_allowed: true });
            usedMusicIds.add(bestFit.id);
            remaining -= bestFit.duration_seconds;
          }
          // else: undershoot ≤ overshoot, or next segment is flexible.
          // Leave the gap — drift self-corrects in the next plan for flexible
          // segments; the hard-start gate covers ≤30s gaps for hard ones.
        }
      }
    }

    // (e) Segment-end envelope.
    if (segmentEnd) {
      if (segmentEnd.duration_seconds <= remaining + segEndReserve + MIN_FILL_GAP_SECONDS) {
        items.push(withCutSkip(brandingToItem(segmentEnd, 'segment_end envelope'), config));
        usedBrandingIds.add(segmentEnd.id);
      }
    }

    // (f) Show-end envelope — placed after segment-end envelope (D40).
    if (showCtx.isShowEnd && branding.show_end) {
      items.push(showEnvelopeItem(branding.show_end, 'show_end envelope'));
      usedBrandingIds.add(branding.show_end.id);
    }

    return {
      items,
      unused_music_ids: music.candidates
        .filter((c) => !usedMusicIds.has(c.id))
        .map((c) => c.id),
      unused_branding_ids: collectUnusedBrandingIds(branding, usedBrandingIds),
      unused_campaign_ids: [],
      unused_promo_ids: [],
      unused_rundown_ids: [],
    };
  }

  // ─── Stop-set assembly ──────────────────────────────────────────────────────

  private async assembleStopSetPlan(
    segment: ClockSegment,
    clockInstanceStartedAt: number,
    targetDurationSeconds: number,
    nowMs: number,
    showCtx: ShowContext,
  ): Promise<AssemblyResult> {
    const { config } = showCtx;
    const instance = { segment_id: segment.id, clock_instance_started_at: clockInstanceStartedAt };
    const pool = await this.requestPool<StopSetCandidatePool>(
      'campaign',
      segment,
      instance,
      targetDurationSeconds,
      nowMs,
    );

    const items: PendingAssemblyItem[] = [];
    const placed: PendingAssemblyItem[] = [];
    const usedCampaignIds = new Set<number>();
    const usedPromoIds = new Set<number>();
    const excluded = new Set<number>();
    let remainingSeconds = targetDurationSeconds;

    // (a) First-in-slot resolution: among candidates with slot_1_required AND
    // !slot_1_satisfied_today, pick the one with the highest pacing_score.
    // Tie-break: hard priority over best_effort, then lowest campaign_id.
    const slot1Pool = pool.candidates.filter(
      (c) => c.position_constraint === 'slot_1_required' && !c.slot_1_satisfied_today,
    );
    if (slot1Pool.length > 0) {
      const winner = pickFirstInSlot(slot1Pool);
      if (winner) {
        const spot = pickLongestSpotThatFits(winner.spot_pool, remainingSeconds);
        if (spot) {
          const item = withCutSkip(
            campaignToItem(winner, spot, 0, 'slot_1 winner (first-in-slot)'),
            config,
          );
          items.push(item);
          placed.push(item);
          remainingSeconds -= spot.duration_seconds;
          usedCampaignIds.add(winner.id);
          // (b) Apply exclusions after placing.
          for (const id of winner.competing_exclusions) excluded.add(id);
          // All other slot_1_required candidates drop out of the break.
          for (const other of slot1Pool) {
            if (other.id !== winner.id) excluded.add(other.id);
          }
        }
      }
    }

    // (c) Fill remaining break.
    while (remainingSeconds > MIN_VIABLE_SPOT_DURATION_SECONDS) {
      let eligible = pool.candidates.filter((c) => {
        if (excluded.has(c.id)) return false;
        if (usedCampaignIds.has(c.id)) return false;
        return c.spot_pool.some((s) => s.duration_seconds <= remainingSeconds);
      });

      if (eligible.length === 0) break;

      // Advertiser separation.
      eligible = eligible.filter((c) => {
        if (c.advertiser_separation_spots <= 0) return true;
        const tail = placed
          .slice(-c.advertiser_separation_spots)
          .filter((it) => it.content_type === 'campaign');
        if (tail.length === 0) return true;
        const tailCustomerIds = tail
          .map((it) => {
            const orig = pool.candidates.find((p) => p.id === it.campaign_candidate_id);
            return orig?.customer_id;
          })
          .filter((id): id is number => id != null);
        return !tailCustomerIds.every((cid) => cid === c.customer_id);
      });

      if (eligible.length === 0) break;

      // Campaign separation: exclude the immediately-preceding campaign.
      const last = placed[placed.length - 1];
      if (last && last.content_type === 'campaign' && last.campaign_candidate_id != null) {
        const lastCandidateId = last.campaign_candidate_id;
        eligible = eligible.filter((c) => c.id !== lastCandidateId);
      }

      if (eligible.length === 0) break;

      eligible.sort((a, b) => {
        if (a.mandatory !== b.mandatory) return a.mandatory ? -1 : 1;
        if (a.pacing_score !== b.pacing_score) return b.pacing_score - a.pacing_score;
        const ap = a.priority === 'hard' ? 0 : 1;
        const bp = b.priority === 'hard' ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return a.campaign_id - b.campaign_id;
      });

      const chosen = eligible[0];
      const spot = pickLongestSpotThatFits(chosen.spot_pool, remainingSeconds);
      if (!spot) break;

      const reason =
        `campaign='${chosen.name}' pacing_score=${chosen.pacing_score.toFixed(2)} ` +
        `priority=${chosen.priority}`;
      const item = withCutSkip(campaignToItem(chosen, spot, placed.length, reason), config);
      items.push(item);
      placed.push(item);
      remainingSeconds -= spot.duration_seconds;
      usedCampaignIds.add(chosen.id);
      for (const id of chosen.competing_exclusions) excluded.add(id);
    }

    // (d) Promo fill: walk pacing_score-desc until no promo fits.
    const sortedPromos = pool.promos
      .slice()
      .sort((a, b) => b.pacing_score - a.pacing_score);
    for (const promo of sortedPromos) {
      if (remainingSeconds <= MIN_VIABLE_SPOT_DURATION_SECONDS) break;
      if (usedPromoIds.has(promo.id)) continue;
      if (promo.duration_seconds > remainingSeconds) continue;
      const reason = `promo pacing_score=${promo.pacing_score.toFixed(2)}`;
      items.push(withCutSkip(promoToItem(promo, reason), config));
      usedPromoIds.add(promo.id);
      remainingSeconds -= promo.duration_seconds;
    }

    return {
      items,
      unused_music_ids: [],
      unused_branding_ids: [],
      unused_campaign_ids: pool.candidates
        .filter((c) => !usedCampaignIds.has(c.id))
        .map((c) => c.id),
      unused_promo_ids: pool.promos
        .filter((p) => !usedPromoIds.has(p.id))
        .map((p) => p.id),
      unused_rundown_ids: [],
      space_estimate: pool.space_estimate,
    };
  }

  // ─── Rundown assembly (news / bulletin / voice_track) ───────────────────────

  private async assembleRundownPlan(
    segment: ClockSegment,
    clockInstanceStartedAt: number,
    targetDurationSeconds: number,
    nowMs: number,
    showCtx: ShowContext,
  ): Promise<AssemblyResult> {
    const { config } = showCtx;
    const instance = { segment_id: segment.id, clock_instance_started_at: clockInstanceStartedAt };
    const rundown = await this.requestPool<RundownCandidatePool>(
      'rundown',
      segment,
      instance,
      targetDurationSeconds,
      nowMs,
    );
    const branding = await this.requestPool<BrandingCandidatePool>(
      'branding',
      segment,
      instance,
      targetDurationSeconds,
      nowMs,
      showCtx.showId,
    );
    // Music is only requested if 'songs' appears in coasting_order.
    const coastingOrder = parseDriftEventTypes(segment.coasting_order);
    const needsMusic = coastingOrder.includes('songs') && segment.can_fill;
    const music = needsMusic
      ? await this.requestPool<MusicCandidatePool>('music', segment, instance, targetDurationSeconds, nowMs)
      : null;

    const items: PendingAssemblyItem[] = [];
    const usedMusicIds = new Set<number>();
    const usedBrandingIds = new Set<number>();
    const usedRundownIds = new Set<number>();

    // Reserve durations up-front.
    const showStartDur = (showCtx.isShowStart && branding.show_start)
      ? branding.show_start.duration_seconds : 0;
    const showEndReserve = (showCtx.isShowEnd && branding.show_end)
      ? branding.show_end.duration_seconds : 0;
    const segEndReserve = branding.segment_end?.duration_seconds ?? 0;

    // (0) Show-start envelope.
    if (showCtx.isShowStart && branding.show_start) {
      items.push(showEnvelopeItem(branding.show_start, 'show_start envelope'));
      usedBrandingIds.add(branding.show_start.id);
    }

    // (a) Segment-start envelope.
    if (branding.segment_start) {
      items.push(withCutSkip(
        brandingToItem(branding.segment_start, 'segment_start envelope'),
        config,
      ));
      usedBrandingIds.add(branding.segment_start.id);
    }

    // (b) Rundown items in position order (mandatory).
    let totalRundownDuration = 0;
    const orderedRundown = rundown.items.slice().sort((a, b) => a.position - b.position);
    for (const item of orderedRundown) {
      const ct: PlanItemContentType =
        segment.type === 'voice_track' ? 'voice_track' : 'rundown';
      items.push({
        media_id: item.media_id,
        content_type: ct,
        campaign_id: null,
        music_campaign_id: null,
        planned_duration_seconds: item.duration_seconds,
        mandatory: true,
        reason: `rundown position=${item.position}`,
        cut_allowed: cutAllowedForType(ct, config),
        skip_allowed: false, // mandatory=true implies skip_allowed=false (D34)
        rundown_candidate_id: item.id,
      });
      usedRundownIds.add(item.id);
      totalRundownDuration += item.duration_seconds;
    }

    const startEnvDur = (branding.segment_start?.duration_seconds ?? 0) + showStartDur;
    let remaining =
      targetDurationSeconds - startEnvDur - totalRundownDuration - segEndReserve - showEndReserve;

    // (c) Gap fill via coasting_order.
    if (segment.can_fill && remaining > MIN_FILL_GAP_SECONDS) {
      let madeProgress = true;
      while (remaining > MIN_FILL_GAP_SECONDS && madeProgress) {
        madeProgress = false;
        for (const type of coastingOrder) {
          if (remaining <= MIN_FILL_GAP_SECONDS) break;
          const placed = this.tryGapFill(
            type,
            remaining,
            { music, branding, campaign: null },
            usedMusicIds,
            usedBrandingIds,
            new Set(),
            new Set(),
            config,
          );
          if (placed) {
            items.push(placed.item);
            remaining -= placed.item.planned_duration_seconds;
            madeProgress = true;
          }
        }
      }
    }

    // (d) Segment-end envelope.
    if (
      branding.segment_end &&
      branding.segment_end.duration_seconds <= remaining + segEndReserve + MIN_FILL_GAP_SECONDS
    ) {
      items.push(withCutSkip(
        brandingToItem(branding.segment_end, 'segment_end envelope'),
        config,
      ));
      usedBrandingIds.add(branding.segment_end.id);
    }

    // (e) Show-end envelope.
    if (showCtx.isShowEnd && branding.show_end) {
      items.push(showEnvelopeItem(branding.show_end, 'show_end envelope'));
      usedBrandingIds.add(branding.show_end.id);
    }

    return {
      items,
      unused_music_ids: music
        ? music.candidates.filter((c) => !usedMusicIds.has(c.id)).map((c) => c.id)
        : [],
      unused_branding_ids: collectUnusedBrandingIds(branding, usedBrandingIds),
      unused_campaign_ids: [],
      unused_promo_ids: [],
      unused_rundown_ids: rundown.items
        .filter((it) => !usedRundownIds.has(it.id))
        .map((it) => it.id),
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async insertPlanRow(
    segment: ClockSegment,
    clockInstanceStartedAt: number,
    nowMs: number,
  ): Promise<number> {
    const inserted = await this.db
      .insert(plansTable)
      .values({
        segment_id: segment.id,
        clock_instance_started_at: clockInstanceStartedAt,
        status: 'draft',
        created_at: nowMs,
        finalized_at: null,
      })
      .returning({ id: plansTable.id });
    const id = inserted[0]?.id;
    if (id == null) {
      throw new Error('planner.insertPlanRow: insert returned no id');
    }
    return id;
  }

  private async persistPlanItems(
    planId: number,
    items: PendingAssemblyItem[],
  ): Promise<void> {
    let position = 0;
    for (const item of items) {
      await this.db.insert(planItemsTable).values(toInsertRow(planId, position, item));
      position += 1;
    }
  }

  private async persistStopSetEstimateIfAny(
    planId: number,
    segmentId: number,
    estimate: StopSetCandidatePool['space_estimate'] | undefined,
    nowMs: number,
  ): Promise<void> {
    if (!estimate) return;
    const existing = await this.db
      .select({ id: stopSetEstimatesTable.id })
      .from(stopSetEstimatesTable)
      .where(eq(stopSetEstimatesTable.plan_id, planId));
    if (existing.length === 0) {
      await this.db.insert(stopSetEstimatesTable).values({
        plan_id: planId,
        segment_id: segmentId,
        computed_at: nowMs,
        break_duration_seconds: estimate.break_duration_seconds,
        hard_claimed_seconds: estimate.hard_claimed_seconds,
        contested_seconds: estimate.contested_seconds,
        free_seconds: estimate.free_seconds,
        occupation_ratio: estimate.occupation_ratio,
        oversubscribed: estimate.oversubscribed,
        candidate_count: estimate.candidate_count,
      });
    } else {
      await this.db
        .update(stopSetEstimatesTable)
        .set({
          segment_id: segmentId,
          computed_at: nowMs,
          break_duration_seconds: estimate.break_duration_seconds,
          hard_claimed_seconds: estimate.hard_claimed_seconds,
          contested_seconds: estimate.contested_seconds,
          free_seconds: estimate.free_seconds,
          occupation_ratio: estimate.occupation_ratio,
          oversubscribed: estimate.oversubscribed,
          candidate_count: estimate.candidate_count,
        })
        .where(eq(stopSetEstimatesTable.plan_id, planId));
    }
  }

  private async notifyContentProcesses(
    result: AssemblyResult,
    planId: number,
    _nowMs: number,
  ): Promise<void> {
    const requestId = `confirm-${planId}-${randomUUID()}`;
    const usedByProcess = new Map<ContentProcessName, number[]>();
    for (const item of result.items) {
      const proc = processForItem(item);
      if (!proc) continue;
      const candidateId =
        item.music_candidate_id ??
        item.branding_candidate_id ??
        item.campaign_candidate_id ??
        item.promo_candidate_id ??
        item.rundown_candidate_id;
      if (candidateId == null) continue;
      const arr = usedByProcess.get(proc) ?? [];
      arr.push(candidateId);
      usedByProcess.set(proc, arr);
    }

    for (const [proc, ids] of usedByProcess) {
      if (ids.length === 0) continue;
      this._bus.emit({
        type: 'CONFIRM_USED',
        request_id: requestId,
        process: proc,
        used_ids: ids,
      });
    }

    const unusedByProcess: Record<ContentProcessName, number[]> = {
      music: result.unused_music_ids,
      branding: result.unused_branding_ids,
      campaign: [...result.unused_campaign_ids, ...result.unused_promo_ids],
      rundown: result.unused_rundown_ids,
    };
    for (const proc of ['music', 'branding', 'campaign', 'rundown'] as const) {
      if (unusedByProcess[proc].length === 0) continue;
      this._bus.emit({
        type: 'RETURN_UNUSED',
        request_id: requestId,
        process: proc,
        unused_ids: unusedByProcess[proc],
      });
    }
  }

  private emitDrop(process: ContentProcessName, ids: number[]): void {
    this._bus.emit({
      type: 'DROP_COMMITTED',
      request_id: `drop-${process}-${randomUUID()}`,
      process,
      dropped_ids: ids,
    });
  }

  // Reads the supervisor_config row (always id=1 per D36). Falls back to
  // an empty-ish config if the table is unexpectedly missing.
  private async loadSupervisorConfig(): Promise<SupervisorConfig> {
    const [row] = await this.db
      .select()
      .from(supervisorConfigTable)
      .where(eq(supervisorConfigTable.id, 1));
    if (!row) {
      throw new Error('planner.loadSupervisorConfig: supervisor_config row missing');
    }
    return row;
  }

  // Determines whether the given segment is the first/last segment of its
  // show's calendar block (D40). Returns both flags. Called only when
  // showId is not null.
  private async getShowBoundaryFlags(
    segmentId: number,
    clockId: number,
    clockInstanceStartedAt: number,
    showId: number,
  ): Promise<{ isShowStart: boolean; isShowEnd: boolean }> {
    const orderedSegs = await this.db
      .select({ id: clockSegments.id, sort_order: clockSegments.sort_order })
      .from(clockSegments)
      .where(eq(clockSegments.clock_id, clockId));
    orderedSegs.sort((a, b) => a.sort_order - b.sort_order);

    if (orderedSegs.length === 0) return { isShowStart: false, isShowEnd: false };

    const firstId = orderedSegs[0]!.id;
    const lastId = orderedSegs[orderedSegs.length - 1]!.id;

    // is_show_start: first segment of clock AND the previous moment belongs
    // to a different show (or silence), i.e. this is the first clock instance
    // of the show block.
    let isShowStart = false;
    if (segmentId === firstId) {
      const prevSeg = await resolveCurrentSegment(clockInstanceStartedAt - 1, this.db);
      isShowStart = !prevSeg || prevSeg.show_id !== showId;
    }

    // is_show_end: last segment of clock AND the next clock instance belongs
    // to a different show (or silence).
    let isShowEnd = false;
    if (segmentId === lastId) {
      const nextSeg = await resolveCurrentSegment(clockInstanceStartedAt + 3_600_000 + 1, this.db);
      isShowEnd = !nextSeg || nextSeg.show_id !== showId;
    }

    return { isShowStart, isShowEnd };
  }

  // Returns the start_policy of the segment immediately following `segment`
  // within the same clock (by sort_order). Used by the end-of-segment gap
  // handler to decide whether a cut_allowed fill is necessary.
  private async lookupNextSegmentPolicy(
    segment: ClockSegment,
  ): Promise<{ type: 'hard' | 'flexible' }> {
    const [next] = await this.db
      .select({ start_policy: clockSegments.start_policy })
      .from(clockSegments)
      .where(
        and(
          eq(clockSegments.clock_id, segment.clock_id),
          gt(clockSegments.sort_order, segment.sort_order),
        ),
      )
      .orderBy(asc(clockSegments.sort_order))
      .limit(1);
    if (!next) return { type: 'flexible' };
    return readStartPolicy(next.start_policy);
  }

  // Try a single gap-fill placement for `type`. Returns the item placed, or
  // null if no candidate fits.
  private tryGapFill(
    type: string,
    remainingSeconds: number,
    pools: {
      music: MusicCandidatePool | null;
      branding: BrandingCandidatePool;
      campaign: StopSetCandidatePool | null;
    },
    usedMusicIds: Set<number>,
    usedBrandingIds: Set<number>,
    usedCampaignIds: Set<number>,
    usedPromoIds: Set<number>,
    config: SupervisorConfig,
  ): { item: PendingAssemblyItem } | null {
    const max = Math.max(0, remainingSeconds - 2);
    if (max < MIN_FILL_GAP_SECONDS) return null;

    switch (type) {
      case 'station_ids': {
        const sorted = pools.branding.station_ids
          .filter((c) => !usedBrandingIds.has(c.id) && c.duration_seconds <= max)
          .sort((a, b) => b.duration_seconds - a.duration_seconds);
        const pick = sorted[0];
        if (!pick) return null;
        usedBrandingIds.add(pick.id);
        return { item: withCutSkip(
          brandingToItem(pick, `coasting fill: gap≈${remainingSeconds.toFixed(0)}s, station_id`),
          config,
        )};
      }
      case 'jingles': {
        const sorted = pools.branding.jingles
          .filter((c) => !usedBrandingIds.has(c.id) && c.duration_seconds <= max)
          .sort((a, b) => b.duration_seconds - a.duration_seconds);
        const pick = sorted[0];
        if (!pick) return null;
        usedBrandingIds.add(pick.id);
        return { item: withCutSkip(
          brandingToItem(pick, `coasting fill: gap≈${remainingSeconds.toFixed(0)}s, jingle`),
          config,
        )};
      }
      case 'songs': {
        if (!pools.music) return null;
        const sorted = pools.music.candidates
          .filter((c) => !usedMusicIds.has(c.id) && c.duration_seconds <= max)
          .sort((a, b) => b.duration_seconds - a.duration_seconds);
        const pick = sorted[0];
        if (!pick) return null;
        usedMusicIds.add(pick.id);
        return { item: withCutSkip(musicCandidateToItem(pick), config) };
      }
      case 'promos': {
        if (!pools.campaign) return null;
        const sorted = pools.campaign.promos
          .filter((c) => !usedPromoIds.has(c.id) && c.duration_seconds <= max)
          .sort((a, b) => b.duration_seconds - a.duration_seconds);
        const pick = sorted[0];
        if (!pick) return null;
        usedPromoIds.add(pick.id);
        return { item: withCutSkip(
          promoToItem(pick, `coasting fill: gap≈${remainingSeconds.toFixed(0)}s, promo`),
          config,
        )};
      }
      case 'spots': {
        // Not applicable for non-stop-set segments.
        void usedCampaignIds;
        return null;
      }
      default:
        return null;
    }
  }

  // Issues a REQUEST_CANDIDATES to a content process and waits for the
  // matching CANDIDATES response. Used by the assembly methods to load each
  // pool exactly once per plan.
  private async requestPool<T>(
    process: ContentProcessName,
    segment: ClockSegment,
    instance: { segment_id: number; clock_instance_started_at: number },
    durationNeededSeconds: number,
    nowMs: number,
    showId?: number | null,
  ): Promise<T> {
    void segment;
    return requestCandidates<T>(
      this._bus,
      {
        request_id: randomUUID(),
        process,
        segment_id: instance.segment_id,
        duration_needed_seconds: durationNeededSeconds,
        clock_instance_started_at: instance.clock_instance_started_at,
        now_ms: nowMs,
        show_id: showId ?? null,
      },
      CANDIDATE_REQUEST_TIMEOUT_MS,
    );
  }
}

// ─── Request/response helper ──────────────────────────────────────────────────

async function requestCandidates<T>(
  _bus: typeof bus,
  req: Omit<Extract<BusMessage, { type: 'REQUEST_CANDIDATES' }>, 'type'>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(
        new Error(
          `requestCandidates: ${req.process} did not respond within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    const unsub = _bus.on<BusMessage & { type: 'CANDIDATES' }>('CANDIDATES', (msg) => {
      if (msg.request_id !== req.request_id) return;
      if (msg.process !== req.process) return;
      clearTimeout(timer);
      unsub();
      resolve(msg.payload as T);
    });
    _bus.emit({ type: 'REQUEST_CANDIDATES', ...req });
  });
}

// ─── cut_allowed / skip_allowed helpers (D34, D36) ───────────────────────────

function cutAllowedForType(
  contentType: PlanItemContentType,
  config: SupervisorConfig,
): boolean {
  switch (contentType) {
    case 'music': return config.cut_allowed_music;
    case 'campaign': return config.cut_allowed_campaign;
    case 'promo': return config.cut_allowed_promo;
    case 'jingle': return config.cut_allowed_jingle;
    case 'station_id': return config.cut_allowed_station_id;
    case 'branding': return config.cut_allowed_branding;
    case 'rundown': return config.cut_allowed_rundown;
    case 'voice_track': return config.cut_allowed_voice_track;
    case 'filler': return config.cut_allowed_jingle; // treat as jingle
    default: return false;
  }
}

function skipAllowedForType(
  contentType: PlanItemContentType,
  mandatory: boolean,
  config: SupervisorConfig,
): boolean {
  if (mandatory) return false; // mandatory=true implies skip_allowed=false (D34)
  switch (contentType) {
    case 'music': return config.skip_allowed_music;
    case 'campaign': return config.skip_allowed_campaign;
    case 'promo': return config.skip_allowed_promo;
    case 'jingle': return config.skip_allowed_jingle;
    case 'station_id': return config.skip_allowed_station_id;
    case 'branding': return config.skip_allowed_branding;
    case 'rundown': return config.skip_allowed_rundown;
    case 'voice_track': return config.skip_allowed_voice_track;
    case 'filler': return config.skip_allowed_jingle; // treat as jingle
    default: return true;
  }
}

// Applies config-derived cut/skip defaults to a PendingAssemblyItem.
function withCutSkip(item: Omit<PendingAssemblyItem, 'cut_allowed' | 'skip_allowed'>, config: SupervisorConfig): PendingAssemblyItem {
  return {
    ...item,
    cut_allowed: cutAllowedForType(item.content_type, config),
    skip_allowed: skipAllowedForType(item.content_type, item.mandatory, config),
  };
}

// Show envelope items always carry cut_allowed=false, skip_allowed=false (D40).
function showEnvelopeItem(c: BrandingCandidate, reasonPrefix: string): PendingAssemblyItem {
  const contentType: PlanItemContentType =
    c.content_subtype === 'jingle'
      ? 'jingle'
      : c.content_subtype === 'station_id'
        ? 'station_id'
        : 'branding';
  return {
    media_id: c.media_id,
    content_type: contentType,
    campaign_id: null,
    music_campaign_id: null,
    planned_duration_seconds: c.duration_seconds,
    mandatory: false,
    reason: `${reasonPrefix} (${c.content_subtype})`,
    cut_allowed: false,
    skip_allowed: false,
    branding_candidate_id: c.id,
  };
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

function musicCandidateToItem(c: MusicCandidate): Omit<PendingAssemblyItem, 'cut_allowed' | 'skip_allowed'> {
  return {
    media_id: c.media_id,
    content_type: 'music',
    campaign_id: null,
    music_campaign_id: c.music_campaign_id ?? null,
    planned_duration_seconds: c.duration_seconds,
    mandatory: false,
    reason: c.reason_hint,
    music_candidate_id: c.id,
  };
}

function brandingToItem(c: BrandingCandidate, reasonPrefix: string): Omit<PendingAssemblyItem, 'cut_allowed' | 'skip_allowed'> {
  const contentType: PlanItemContentType =
    c.content_subtype === 'jingle'
      ? 'jingle'
      : c.content_subtype === 'station_id'
        ? 'station_id'
        : 'branding';
  return {
    media_id: c.media_id,
    content_type: contentType,
    campaign_id: null,
    music_campaign_id: null,
    planned_duration_seconds: c.duration_seconds,
    mandatory: false,
    reason: `${reasonPrefix} (${c.content_subtype})`,
    branding_candidate_id: c.id,
  };
}

function campaignToItem(
  c: CampaignCandidate,
  spot: SpotCandidate,
  positionInBreak: number,
  reason: string,
): Omit<PendingAssemblyItem, 'cut_allowed' | 'skip_allowed'> {
  void positionInBreak;
  return {
    media_id: spot.media_id,
    content_type: 'campaign',
    campaign_id: c.campaign_id,
    music_campaign_id: null,
    planned_duration_seconds: spot.duration_seconds,
    mandatory: c.mandatory,
    reason,
    campaign_candidate_id: c.id,
  };
}

function promoToItem(p: PromoCandidate, reason: string): Omit<PendingAssemblyItem, 'cut_allowed' | 'skip_allowed'> {
  return {
    media_id: p.media_id,
    content_type: 'promo',
    campaign_id: null,
    music_campaign_id: null,
    planned_duration_seconds: p.duration_seconds,
    mandatory: false,
    reason,
    promo_candidate_id: p.id,
  };
}

function toInsertRow(
  planId: number,
  position: number,
  item: PendingAssemblyItem,
): PlanItemInsert {
  return {
    plan_id: planId,
    position,
    media_id: item.media_id,
    content_type: item.content_type,
    campaign_id: item.campaign_id,
    music_campaign_id: item.music_campaign_id,
    planned_duration_seconds: item.planned_duration_seconds,
    mandatory: item.mandatory,
    reason: item.reason,
    status: 'pending',
    cut_allowed: item.cut_allowed ? 1 : 0,
    skip_allowed: item.skip_allowed ? 1 : 0,
  };
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────

function emptyResult(): AssemblyResult {
  return {
    items: [],
    unused_music_ids: [],
    unused_branding_ids: [],
    unused_campaign_ids: [],
    unused_promo_ids: [],
    unused_rundown_ids: [],
  };
}

function collectUnusedBrandingIds(
  pool: BrandingCandidatePool,
  used: Set<number>,
): number[] {
  const out: number[] = [];
  for (const c of pool.jingles) if (!used.has(c.id)) out.push(c.id);
  for (const c of pool.station_ids) if (!used.has(c.id)) out.push(c.id);
  if (pool.segment_start && !used.has(pool.segment_start.id)) out.push(pool.segment_start.id);
  if (pool.segment_end && !used.has(pool.segment_end.id)) out.push(pool.segment_end.id);
  if (pool.show_start && !used.has(pool.show_start.id)) out.push(pool.show_start.id);
  if (pool.show_end && !used.has(pool.show_end.id)) out.push(pool.show_end.id);
  return out;
}

function processForItem(item: PendingAssemblyItem): ContentProcessName | null {
  if (item.music_candidate_id != null) return 'music';
  if (item.branding_candidate_id != null) return 'branding';
  if (item.campaign_candidate_id != null || item.promo_candidate_id != null) {
    return 'campaign';
  }
  if (item.rundown_candidate_id != null) return 'rundown';
  return null;
}

function pickFirstInSlot(pool: CampaignCandidate[]): CampaignCandidate | null {
  if (pool.length === 0) return null;
  const sorted = pool.slice().sort((a, b) => {
    if (a.pacing_score !== b.pacing_score) return b.pacing_score - a.pacing_score;
    const ap = a.priority === 'hard' ? 0 : 1;
    const bp = b.priority === 'hard' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.campaign_id - b.campaign_id;
  });
  return sorted[0] ?? null;
}

function pickLongestSpotThatFits(
  pool: SpotCandidate[],
  remainingSeconds: number,
): SpotCandidate | null {
  const fits = pool.filter((s) => s.duration_seconds <= remainingSeconds);
  if (fits.length === 0) return null;
  fits.sort((a, b) => b.duration_seconds - a.duration_seconds);
  return fits[0] ?? null;
}

// Walks a branding pool from `cursor` and returns the first candidate not in
// `used`. The cursor is advanced by the caller using the returned cursor index.
function nextBrandingPick(
  pool: BrandingCandidate[],
  cursor: number,
  used: Set<number>,
): { id: number; media_id: number; duration_seconds: number; content_subtype: BrandingCandidate['content_subtype']; playlist_id: number; cursor: number } | null {
  if (pool.length === 0) return null;
  for (let i = 0; i < pool.length; i++) {
    const idx = (cursor + i) % pool.length;
    const c = pool[idx];
    if (used.has(c.id)) continue;
    return { ...c, cursor: idx };
  }
  return null;
}

function readStartPolicy(raw: unknown): { type: 'hard' | 'flexible' } {
  if (raw && typeof raw === 'object' && 'type' in raw) {
    const t = (raw as { type: unknown }).type;
    if (t === 'hard') return { type: 'hard' };
  }
  if (typeof raw === 'string') {
    try {
      return readStartPolicy(JSON.parse(raw));
    } catch {
      // fall through
    }
  }
  return { type: 'flexible' };
}

function parseDriftEventTypes(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string');
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === 'string')
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function hasMusicGapNeeds(segment: ClockSegment): boolean {
  if (!segment.can_fill) return false;
  const types = parseDriftEventTypes(segment.coasting_order);
  return types.includes('songs');
}

// Finalization-only helpers — kept simple. A pending item is "still valid" if
// its backing candidate is present in the fresh pool keyed by media_id.
function isItemStillValid(
  item: { content_type: PlanItemContentType; media_id: number; campaign_id: number | null },
  freshMusic: MusicCandidatePool | null,
  freshCampaign: StopSetCandidatePool | null,
): boolean {
  switch (item.content_type) {
    case 'music':
      return !!freshMusic?.candidates.some((c) => c.media_id === item.media_id);
    case 'campaign':
      if (!freshCampaign) return true;
      if (item.campaign_id == null) return true;
      return freshCampaign.candidates.some(
        (c) =>
          c.campaign_id === item.campaign_id &&
          c.spot_pool.some((s) => s.media_id === item.media_id),
      );
    case 'promo':
      if (!freshCampaign) return true;
      return freshCampaign.promos.some((p) => p.media_id === item.media_id);
    default:
      return true;
  }
}

function pickReplacement(
  item: { content_type: PlanItemContentType; planned_duration_seconds: number },
  freshMusic: MusicCandidatePool | null,
  freshCampaign: StopSetCandidatePool | null,
  config: SupervisorConfig,
): PendingAssemblyItem | null {
  if (item.content_type === 'music' && freshMusic) {
    const fits = freshMusic.candidates
      .filter((c) => c.duration_seconds <= item.planned_duration_seconds + 30)
      .sort(
        (a, b) =>
          Math.abs(a.duration_seconds - item.planned_duration_seconds) -
          Math.abs(b.duration_seconds - item.planned_duration_seconds),
      );
    const pick = fits[0];
    if (pick) return withCutSkip(musicCandidateToItem(pick), config);
  }
  if (item.content_type === 'campaign' && freshCampaign) {
    const sorted = freshCampaign.candidates
      .filter((c) => c.spot_pool.some((s) => s.duration_seconds <= item.planned_duration_seconds))
      .sort((a, b) => b.pacing_score - a.pacing_score);
    const pick = sorted[0];
    if (pick) {
      const spot = pickLongestSpotThatFits(pick.spot_pool, item.planned_duration_seconds);
      if (spot) {
        return withCutSkip(
          campaignToItem(pick, spot, 0, `replacement: ${pick.name} pacing_score=${pick.pacing_score.toFixed(2)}`),
          config,
        );
      }
    }
  }
  if (item.content_type === 'promo' && freshCampaign) {
    const sorted = freshCampaign.promos
      .filter((p) => p.duration_seconds <= item.planned_duration_seconds)
      .sort((a, b) => b.pacing_score - a.pacing_score);
    const pick = sorted[0];
    if (pick) return withCutSkip(promoToItem(pick, `replacement promo pacing_score=${pick.pacing_score.toFixed(2)}`), config);
  }
  return null;
}
