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
// Reason strings for segment envelopes — an internal contract: the replan
// path recognizes a plan's trailing pending closer BY THIS STRING (D104), so
// the write sites and the detection must never drift apart. All write sites
// go through brandingToItem, which appends " (<subtype>)" — so detection is
// PREFIX-based (startsWith), never exact equality. Found live 2026-07-19
// during D107: the original === comparison could never match the stored
// reason, so every replan since D104 silently dropped the pending closer
// (closer_restored was always false).
const SEGMENT_START_ENVELOPE_REASON = 'segment_start envelope';
const SEGMENT_END_ENVELOPE_REASON = 'segment_end envelope';

// ── Decision 92: fill texture rule ────────────────────────────────────────────
// Music is the fabric; promo/station-ID/jingle are single stitches. In fill
// paths: never two items of the same non-music type adjacent (no promo →
// promo), never three non-music items in a row (promo → station-ID is the
// ceiling; then music must intervene). Stop-set internal assembly is exempt —
// consecutive spots/promos are the normal sound of an ad break. Extends
// Decision 70 (jingle/station-ID never back-to-back) to the general principle.
const NON_MUSIC_TEXTURE_TYPES = new Set<PlanItemContentType>([
  'promo', 'jingle', 'station_id', 'branding', 'filler',
]);

function textureAllows(placed: PendingAssemblyItem[], contentType: PlanItemContentType): boolean {
  if (!NON_MUSIC_TEXTURE_TYPES.has(contentType)) return true;
  const last = placed[placed.length - 1];
  if (!last || !NON_MUSIC_TEXTURE_TYPES.has(last.content_type)) return true;
  if (last.content_type === contentType) return false;
  const prev = placed[placed.length - 2];
  if (prev && NON_MUSIC_TEXTURE_TYPES.has(prev.content_type)) return false;
  return true;
}
// Default request/response timeout for content process calls. Generous —
// content processes do real DB work but should complete well inside this.
const CANDIDATE_REQUEST_TIMEOUT_MS = 10_000;
// Minimum spot duration the planner will attempt to place in a stop-set
// break — below this the spot pool is treated as exhausted.
const MIN_VIABLE_SPOT_DURATION_SECONDS = 15;
// Decision 75: safety ceiling on the campaign-driven recovery multiplier —
// a stop-set can grow to at most this much of its own nominal duration,

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
              { err, event: 'PLAN_FINALIZE_FAILED', request_id: msg.request_id, plan_id: msg.plan_id },
              'planner: finalize request failed',
            );
            // Decision 98: a failure must be as loud on the bus as a success —
            // the Supervisor's in-flight guard latches until it hears back,
            // and a silent failure used to latch it until process restart.
            this._bus.emit({ type: 'PLAN_FINALIZE_FAILED', request_id: msg.request_id, plan_id: msg.plan_id });
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
              { err, event: 'PLAN_REPLAN_FAILED', request_id: msg.request_id, plan_id: msg.plan_id },
              'planner: replan request failed',
            );
            // Decision 98: see the finalize handler above.
            this._bus.emit({ type: 'PLAN_REPLAN_FAILED', request_id: msg.request_id, plan_id: msg.plan_id });
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
      msg.resolution_identity,
      // Decision 93: sizing story, persisted onto the plans row.
      {
        nominal_duration_seconds: msg.nominal_duration_seconds,
        predicted_drift_seconds: msg.predicted_drift_seconds,
        applied_correction_seconds: msg.applied_correction_seconds,
      },
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
      {
        predicted_drift_seconds: msg.predicted_drift_seconds,
        applied_correction_seconds: msg.applied_correction_seconds,
      },
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
    resolutionIdentity: string | null,
    // Decision 93: sizing story from the Supervisor; persisted verbatim.
    ledger?: {
      nominal_duration_seconds: number | null;
      predicted_drift_seconds: number | null;
      applied_correction_seconds: number | null;
    },
  ): Promise<number> {
    const [segment] = await this.db
      .select()
      .from(clockSegments)
      .where(eq(clockSegments.id, segmentId));
    if (!segment) {
      throw new Error(`planner.buildPlan: segment ${segmentId} not found`);
    }

    const ledgerColumns = {
      nominal_duration_seconds: ledger?.nominal_duration_seconds ?? segment.duration_seconds,
      target_duration_seconds: targetDurationSeconds,
      predicted_drift_seconds: ledger?.predicted_drift_seconds ?? null,
      applied_correction_seconds: ledger?.applied_correction_seconds ?? null,
    };

    // Live segments have no automated content — write only the plans row so
    // the Supervisor can track the segment lifecycle. plan_items.media_id has
    // a NOT NULL FK; we cannot store a sentinel-less placeholder, so we
    // intentionally skip plan_items for live segments. The Supervisor / Queue
    // Feeder treat an empty plan as a live-suspension marker.
    if (segment.type === 'live') {
      return this.insertPlanRow(segment, clockInstanceStartedAt, nowMs, resolutionIdentity, ledgerColumns);
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

    const planId = await this.insertPlanRow(segment, clockInstanceStartedAt, nowMs, resolutionIdentity, ledgerColumns);

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
    // Decision 93: finalize's sizing story overwrites draft's on the plans
    // row — the ledger records what the plan was ultimately sized to.
    ledger?: {
      predicted_drift_seconds: number | null;
      applied_correction_seconds: number | null;
    },
  ): Promise<void> {
    void currentDriftSeconds; // logged by supervisor; planner just records finalize event
    const [plan] = await this.db
      .select()
      .from(plansTable)
      .where(eq(plansTable.id, planId));
    if (!plan) {
      throw new Error(`planner.finalizePlan: plan ${planId} not found`);
    }
    // Decision 84: idempotency at the target, not a Supervisor-side guard
    // field. A finalize request for a plan that's already past 'draft' is a
    // safe no-op — it's either already finalized (a duplicate/late request)
    // or has moved further (Transitioning/active/completed/Invalid), and
    // re-running reassembly against a plan that may already have 'playing'
    // items would be actively wrong, not just redundant.
    if (plan.status !== 'draft') {
      this.logger?.info(
        { event: 'PLAN_FINALIZE_NOOP', plan_id: planId, status: plan.status },
        'planner: finalize requested for a plan no longer in draft — no-op',
      );
      return;
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
    const pendingItems = await this.db
      .select()
      .from(planItemsTable)
      .where(and(eq(planItemsTable.plan_id, planId), eq(planItemsTable.status, 'pending')));
    const pendingSumSeconds = pendingItems.reduce((acc, it) => acc + it.planned_duration_seconds, 0);
    // D44's queue-ahead nudge can already have pushed this plan's first item
    // into Harbor before this gate fires (whenever the previous segment's
    // last item started playing well ahead of T-30s) — flipping it to
    // 'playing', not 'pending'. That item is real, already-committed content
    // neither the trigger comparison nor a full reassembly can see if they
    // only look at 'pending' rows. Netting it out of the target here (D67)
    // is what prevents a reassembly from stacking a full fresh target on top
    // of it — confirmed live 2026-07-12: a 763.415s target plus an already-
    // committed track produced 998.37s of real airtime.
    const committedItems = await this.db
      .select({ planned_duration_seconds: planItemsTable.planned_duration_seconds })
      .from(planItemsTable)
      .where(and(eq(planItemsTable.plan_id, planId), eq(planItemsTable.status, 'playing')));
    const committedSeconds = committedItems.reduce((acc, it) => acc + it.planned_duration_seconds, 0);
    const effectiveTargetSeconds = Math.max(0, adjustedTargetSeconds - committedSeconds);
    // driftDeltaSeconds alone misses cases where the target changed a lot
    // without drift itself moving — first-pass and second-pass targets use
    // different formulas (first-pass folds in plannedOvershoot, second-pass
    // doesn't), so the target can jump even when drift_delta reads 0.
    // Confirmed live 2026-07-04: a plan drafted against a 30s floor-clamped
    // target sat un-reassembled after the T-30s gate recomputed 168s, because
    // drift hadn't moved — only the formula had. Comparing actual planned
    // content against the adjusted target catches that directly.
    const contentGapSeconds = Math.abs(pendingSumSeconds - effectiveTargetSeconds);
    // D73: stop-sets no longer participate in drift correction at all, so
    // driftDeltaSeconds is irrelevant to their sizing — only contentGapSeconds
    // should ever trigger their reassembly (e.g. a campaign crossing its
    // pacing threshold between draft and finalize — Decision 74).
    const isStopSet = segment.type === 'stop_set';
    const needsFullReassembly =
      !isRundown && ((!isStopSet && Math.abs(driftDeltaSeconds) >= threshold) || contentGapSeconds >= threshold);

    let substitutions = 0;

    if (needsFullReassembly) {
      // Full re-assembly with the drift-adjusted target (D31).
      //
      // Decision 98 — BUILD THEN SWAP: assembly runs FIRST, while the plan's
      // existing pending items are still untouched. Assembly is the only part
      // of this path that can realistically throw (a content-process pool
      // timeout, a DB hiccup) — the old order deleted the pending items
      // before assembling, so a throw left the plan gutted with no completion
      // event ever emitted, latching the Supervisor's in-flight guard until
      // process restart (the last remaining "dead air until restart" class).
      // Assembling first has no side effects: REQUEST_CANDIDATES/CANDIDATES
      // change no content-process state (Decision 11) — commitment only
      // happens in notifyContentProcesses below, after the swap succeeds.

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
        effectiveTargetSeconds,
        nowMs,
        showCtx,
      );

      // The feeder runs on its own triggers and can promote a snapshotted
      // item to 'playing' while assembly was in flight — swap only against a
      // world that hasn't moved.
      await this.assertSnapshotStillPending(planId, pendingItems.map((it) => it.id), 'finalize');

      // ── Swap: only now do the old pending items get released and removed ──
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
        await this.deleteSnapshotRows(planId, pendingItems.map((it) => it.id), 'finalize');
      }

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
          committed_seconds: committedSeconds,
          effective_target_seconds: effectiveTargetSeconds,
          dropped_count: pendingItems.length,
          added_count: result.items.length,
        },
        'planner: finalize full re-assembly',
      );
    } else {
      // Lightweight substitution: re-request candidate pools and replace any
      // pending item whose backing candidate has disappeared (campaign hit
      // daily cap, etc.). Does not restructure the plan.
      if (pendingItems.length > 0) {
        const sumPending = pendingSumSeconds;
        // D106: the fresh pool must resolve under the same content ownership
        // the plan was assembled with — otherwise show-owned items would
        // look absent from a segment-owned pool and get substituted away.
        const lightweightShow = await resolveCurrentSegment(plan.clock_instance_started_at + 1, this.db);
        const freshMusic =
          segment.type === 'music' || hasMusicGapNeeds(segment)
            ? await this.requestPool<MusicCandidatePool>('music', segment, plan, sumPending, nowMs, lightweightShow?.show_id ?? null)
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

        // D109: replacements must rotate clips against what the plan already
        // holds — seed the per-clip counts from the plan's pending campaign
        // items, then keep them current as substitutions land.
        const spotPlacedCounts = new Map<number, number>();
        for (const item of pendingItems) {
          if (item.content_type === 'campaign') {
            spotPlacedCounts.set(item.media_id, (spotPlacedCounts.get(item.media_id) ?? 0) + 1);
          }
        }
        for (const item of pendingItems) {
          const stillValid = isItemStillValid(item, freshMusic, freshCampaign);
          if (stillValid) continue;
          // The item being replaced won't air — remove it from the counts
          // before picking so it doesn't skew the rotation.
          if (item.content_type === 'campaign') {
            const n = (spotPlacedCounts.get(item.media_id) ?? 1) - 1;
            if (n <= 0) spotPlacedCounts.delete(item.media_id);
            else spotPlacedCounts.set(item.media_id, n);
          }
          const replacement = pickReplacement(item, freshMusic, freshCampaign, config, spotPlacedCounts);
          if (!replacement) continue;
          if (replacement.content_type === 'campaign') {
            spotPlacedCounts.set(replacement.media_id, (spotPlacedCounts.get(replacement.media_id) ?? 0) + 1);
          }
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
      .set({
        status: 'finalized',
        finalized_at: nowMs,
        // Decision 93: a drift-sized finalize (predicted non-null) overwrites
        // the draft-time sizing story. The content-preserving finalize paths
        // (cold start, reconcile-an-existing-draft) pass adjusted_target as a
        // "no gap" sentinel equal to current content — not a sizing decision —
        // so they leave the draft-time ledger untouched.
        ...(ledger?.predicted_drift_seconds != null
          ? {
              target_duration_seconds: adjustedTargetSeconds,
              predicted_drift_seconds: ledger.predicted_drift_seconds,
              applied_correction_seconds: ledger.applied_correction_seconds,
            }
          : {}),
      })
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
  // Robustness guard for both build-then-swap sites (finalize full
  // reassembly, mid-flight replan). The Queue Feeder runs on its own triggers
  // (500ms tick + LS track-ending webhook) and can promote a snapshotted
  // 'pending' item to 'playing' while assembly is in flight; the swap would
  // then delete a row whose audio is airing or queued in LS, and the fresh
  // content double-fills its slot. Assembly has no side effects (D11/D98),
  // so the cheapest correct move is to discard the build and fail the
  // request: the D98 failure event unlatches the Supervisor's guard, the
  // retry re-runs against fresh state, and the escaped item is netted out
  // as committed content like any other 'playing' row (D67).
  private async assertSnapshotStillPending(
    planId: number,
    snapshotIds: number[],
    context: 'finalize' | 'replan',
  ): Promise<void> {
    if (snapshotIds.length === 0) return;
    const stillPending = await this.db
      .select({ id: planItemsTable.id })
      .from(planItemsTable)
      .where(and(inArray(planItemsTable.id, snapshotIds), eq(planItemsTable.status, 'pending')));
    if (stillPending.length !== snapshotIds.length) {
      this.logger?.warn(
        {
          event: 'PLAN_REASSEMBLY_STALE_SNAPSHOT',
          plan_id: planId,
          context,
          snapshot_count: snapshotIds.length,
          still_pending: stillPending.length,
        },
        'planner: items changed state during reassembly — build discarded; the retry nets the committed item',
      );
      throw new Error(`planner: plan ${planId} items changed state during ${context} reassembly`);
    }
  }

  // Second layer under the guard above: even after the re-check passes, a
  // push can land in the microseconds before this DELETE executes — so the
  // DELETE itself only removes rows still 'pending'. A shortfall means an
  // item escaped in that window: its airing row is preserved (the point),
  // at the cost of the new content double-filling its slot (~one item of
  // overshoot the drift machinery absorbs).
  private async deleteSnapshotRows(
    planId: number,
    snapshotIds: number[],
    context: 'finalize' | 'replan',
  ): Promise<void> {
    const deleted = await this.db
      .delete(planItemsTable)
      .where(and(inArray(planItemsTable.id, snapshotIds), eq(planItemsTable.status, 'pending')));
    const deletedCount = deleted.rowsAffected ?? snapshotIds.length;
    if (deletedCount !== snapshotIds.length) {
      this.logger?.error(
        {
          event: 'PLAN_REASSEMBLY_SWAP_RACE',
          plan_id: planId,
          context,
          expected: snapshotIds.length,
          deleted: deletedCount,
        },
        'planner: item escaped between re-check and delete — airing row preserved; slot double-filled',
      );
    }
  }

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

    // D104: the live replan callers all APPEND (top-up/fill) — fromPosition
    // is past the plan's last item. Read the full pending list so the plan's
    // trailing closer, when still pending, can be pulled into the swap and
    // re-placed AFTER the chunk: the segment keeps ending on its closer
    // instead of the closer airing mid-plan with music glued behind it. An
    // already-aired closer is never repeated — the extended segment then
    // ends on plain content ("saying goodbye twice is worse than once").
    const pendingAll = await this.db
      .select()
      .from(planItemsTable)
      .where(and(eq(planItemsTable.plan_id, planId), eq(planItemsTable.status, 'pending')))
      .orderBy(asc(planItemsTable.position));
    const lastPending = pendingAll[pendingAll.length - 1] ?? null;
    const trailingCloser =
      lastPending != null && lastPending.reason.startsWith(SEGMENT_END_ENVELOPE_REASON) ? lastPending : null;
    const effectiveFrom = trailingCloser
      ? Math.min(fromPosition, trailingCloser.position)
      : fromPosition;
    const dropping = pendingAll.filter((it) => it.position >= effectiveFrom);

    // Decision 98 — BUILD THEN SWAP (same rationale as finalizePlan): assemble
    // the replacement tail FIRST, while the existing tail is untouched. The
    // old order deleted the tail before assembling, so an assembly throw
    // (pool timeout, DB error) gutted the plan's remainder with no completion
    // event, permanently latching the Supervisor's pending-replan guard —
    // which blocks the hard-start fill and exhausted-top-up levers exactly
    // when they're needed.
    const config = await this.loadSupervisorConfig();

    // D104: a chunk appended to an already-airing music plan is CONTINUATION
    // content — more of the same segment, not a fresh one — so it goes
    // through its own assembly routine (no envelopes, no end-reserve beyond
    // the re-placed closer below). Non-music segments keep the full
    // assembler as before.
    const chunkBudgetSeconds = Math.max(
      0,
      remainingSeconds - (trailingCloser?.planned_duration_seconds ?? 0),
    );
    // Show context resolved once for both paths — the chunk's pools must be
    // built under the same content ownership (D106) as the plan they extend.
    const showResolved = await resolveCurrentSegment(plan.clock_instance_started_at + 1, this.db);
    let result: AssemblyResult;
    if (segment.type === 'music') {
      result = await this.assembleContinuationChunk(
        segment,
        plan.clock_instance_started_at,
        chunkBudgetSeconds,
        nowMs,
        config,
        showResolved?.show_id ?? null,
      );
    } else {
      // For mid-segment replanning, the show context is unchanged (show
      // envelopes played at the start/end are not re-inserted). Pass show_id
      // for branding pool selection but disable envelope insertion — both
      // show envelopes (via the false flags) and segment envelopes (D107:
      // the opener already aired; the pending closer is re-placed below).
      // Budget excludes the re-placed closer's duration for the same reason
      // the music branch's chunk budget does.
      const showCtx: ShowContext = {
        showId: showResolved?.show_id ?? null,
        showName: showResolved?.show_name ?? null,
        isShowStart: false,
        isShowEnd: false,
        config,
      };
      result = await this.assembleForSegment(
        segment,
        plan.clock_instance_started_at,
        chunkBudgetSeconds,
        nowMs,
        showCtx,
        { skipSegmentEnvelopes: true },
      );
    }

    // Same stale-snapshot guard as finalize — the feeder can promote a
    // snapshotted tail item to 'playing' while assembly runs.
    await this.assertSnapshotStillPending(planId, dropping.map((it) => it.id), 'replan');

    // ── Swap: release and remove the superseded tail, then insert the new ──
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

    if (dropping.length > 0) {
      await this.deleteSnapshotRows(planId, dropping.map((it) => it.id), 'replan');
    }

    // Re-insert from the effective start, then re-place the plan's own
    // pending closer (same media, same values) at the true end (D104).
    let pos = effectiveFrom;
    for (const item of result.items) {
      await this.db.insert(planItemsTable).values(toInsertRow(planId, pos, item));
      pos += 1;
    }
    if (trailingCloser) {
      await this.db.insert(planItemsTable).values({
        plan_id: planId,
        position: pos,
        media_id: trailingCloser.media_id,
        content_type: trailingCloser.content_type,
        campaign_id: trailingCloser.campaign_id,
        music_campaign_id: trailingCloser.music_campaign_id,
        planned_duration_seconds: trailingCloser.planned_duration_seconds,
        mandatory: trailingCloser.mandatory,
        reason: trailingCloser.reason,
        status: 'pending',
        cut_allowed: trailingCloser.cut_allowed,
        skip_allowed: trailingCloser.skip_allowed,
      });
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
        from_position: effectiveFrom,
        continuation: segment.type === 'music',
        closer_restored: trailingCloser != null,
      },
      'planner: replan complete',
    );
  }

  // D104 — continuation chunk: content appended to an already-airing music
  // plan by the top-up/fill paths. A chunk is MORE OF THE SAME SEGMENT, not
  // a fresh one: no opening envelope (the segment already opened on air), no
  // closing envelope and no end-reserve (the replan caller re-places the
  // plan's own pending closer after the chunk when one exists). Interstitial
  // jingles/IDs still apply — mid-segment content keeps its cadence — and the
  // fill core brings D103's heavy-first and hot-play-by-cadence with it.
  private async assembleContinuationChunk(
    segment: ClockSegment,
    clockInstanceStartedAt: number,
    budgetSeconds: number,
    nowMs: number,
    config: SupervisorConfig,
    showId: number | null,
  ): Promise<AssemblyResult> {
    const instance = { segment_id: segment.id, clock_instance_started_at: clockInstanceStartedAt };
    const music = await this.requestPool<MusicCandidatePool>(
      'music',
      segment,
      instance,
      budgetSeconds,
      nowMs,
      showId,
    );
    const branding = await this.requestPool<BrandingCandidatePool>(
      'branding',
      segment,
      instance,
      budgetSeconds,
      nowMs,
      showId,
    );
    const items: PendingAssemblyItem[] = [];
    const usedMusicIds = new Set<number>();
    const usedBrandingIds = new Set<number>();
    this.fillMusicItems(music, branding, segment, config, budgetSeconds, items, usedMusicIds, usedBrandingIds);
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

  // ─── Segment-type dispatch ──────────────────────────────────────────────────

  private async assembleForSegment(
    segment: ClockSegment,
    clockInstanceStartedAt: number,
    targetDurationSeconds: number,
    nowMs: number,
    showCtx: ShowContext,
    // D107: mid-flight replan re-assembles the remainder of an already-airing
    // segment — its opening envelope already aired and its pending closer is
    // re-placed by the D104 mechanism, so the assemblers must not insert
    // fresh segment envelopes. Draft/finalize paths omit this (full plans
    // get their envelopes). Music handles the same concern via its dedicated
    // continuation-chunk routine instead.
    opts: { skipSegmentEnvelopes?: boolean } = {},
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
          opts,
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
          opts,
        );
      case 'live':
        return emptyResult();
      default:
        return emptyResult();
    }
  }

  // ─── Music segment assembly ─────────────────────────────────────────────────
  //
  // Assembly order for a music segment (assembleMusicPlan → fillMusicItems;
  // the detailed rules live as comments on the steps themselves):
  //
  //  (0) Show-start envelope (if first segment of show block).
  //  (a) Segment-start envelope. The segment-end and show-end envelope
  //      durations are reserved from the fill budget up-front, so the
  //      closers always have room.
  //  (b/c) Music fill (fillMusicItems, shared with D104 continuation
  //      chunks, which skip envelopes and the end reserve): heavy rotation
  //      first, hot-play by cadence, then rotation candidates in pool order
  //      (source-weight interleaved, D103), with interstitial jingles /
  //      station-IDs on the musicCount cadence (mutually exclusive per
  //      boundary, D70). A candidate longer than what's left is skipped,
  //      never a stop signal (D101).
  //  (d) Single boundary decision (D72/D97, retimed by D101): the
  //      minimum-overshoot unused candidate is judged exactly once, placed
  //      with cut_allowed iff its overshoot beats the gap.
  //  (e) Segment-end envelope (from the reserve).
  //  (f) Show-end envelope (if last segment of show block).
  //
  // The pool arrives overserved (count-based POOL_MULTIPLIER, music.ts) and
  // pre-filtered to tracks ≤ the requested target (D101), so skipping stays
  // free and the boundary decision always has candidates. No
  // arrangement-trying occurs — the pass is a single greedy sweep; the
  // residual lands within ~half a track and the next plan's prediction
  // sizing absorbs it (D91).

  // The music-fill core shared by full segment assembly and continuation
  // chunks (D104): heavy rotation first, hot-play by cadence, rotation walk
  // with interstitial jingles/IDs, single boundary decision (D101/D97).
  // Mutates items and the used-id sets; returns the unfilled remainder of
  // budgetSeconds.
  private fillMusicItems(
    music: MusicCandidatePool,
    branding: BrandingCandidatePool,
    segment: ClockSegment,
    config: SupervisorConfig,
    budgetSeconds: number,
    items: PendingAssemblyItem[],
    usedMusicIds: Set<number>,
    usedBrandingIds: Set<number>,
  ): number {
    let remaining = budgetSeconds;
    // (b/c) Music + interstitial cadence.
    const jinglesEnabled = segment.interstitial_jingles_enabled;
    const jingleEveryN = segment.jingle_every_n_tracks ?? 0;
    const stationIdsEnabled = segment.interstitial_station_id_enabled;
    const stationIdEveryN = segment.station_id_every_n_tracks ?? 0;

    let jingleCursor = 0;
    let stationIdCursor = 0;
    let musicCount = 0;

    // D103 — the pool is typed, and placement honors the types instead of
    // eating front-to-back (which buried everything behind the rotation
    // block): heavy rotation places first, hot-play places by cadence,
    // ordinary rotation candidates fill in pool order (already interleaved
    // by source weight on the picker side).
    const heavyCandidates = music.candidates.filter((c) => c.source === 'heavy_rotation');
    const hotPlayCandidates = music.candidates.filter((c) => c.source === 'hot_play');
    const rotationCandidates = music.candidates.filter((c) => c.source === 'rotation');
    const hotPlayEveryN = music.hot_play_every_n_tracks ?? 0;
    let hotPlayStreak = music.hot_play_current_streak ?? 0;

    // Places one hot-play candidate when the streak says one is due —
    // first-fit within the sub-pool, mirroring the interstitial jingle
    // pattern below. When none fit (boundary proximity), the cadence simply
    // defers: the streak derives from play_history, so the debt survives
    // into the next segment's pool on its own.
    const tryPlaceHotPlay = () => {
      if (hotPlayEveryN <= 0 || hotPlayStreak < hotPlayEveryN) return;
      const pick = hotPlayCandidates.find(
        (h) => !usedMusicIds.has(h.id) && h.duration_seconds <= remaining,
      );
      if (!pick) return;
      items.push(withCutSkip(musicCandidateToItem(pick), config));
      usedMusicIds.add(pick.id);
      remaining -= pick.duration_seconds;
      musicCount += 1;
      hotPlayStreak = 0;
    };

    // (b0) Heavy rotation first — pacing-gated on the picker side, so
    // whatever arrives is owed airtime; the front of the fill is the one
    // place a candidate can never fail to fit.
    for (const c of heavyCandidates) {
      if (usedMusicIds.has(c.id) || c.duration_seconds > remaining) continue;
      items.push(withCutSkip(musicCandidateToItem(c), config));
      usedMusicIds.add(c.id);
      remaining -= c.duration_seconds;
      musicCount += 1;
    }

    // A hot-play already owed from previous segments places before the
    // ordinary fill begins.
    tryPlaceHotPlay();

    // (b/c) Music fill — place fitting candidates in received order; skip any
    // candidate longer than what's left (D101). D72 treated the FIRST
    // non-fitting candidate as proof the segment was nearly full and made the
    // single boundary decision right there — but with mixed-length libraries a
    // long track can surface while the gap is still several tracks wide, and
    // the break threw away every fitting candidate behind it (plan 8617 live
    // 2026-07-17: a 46-min track as 3rd candidate → 443s plan against an 895s
    // target). Skipping costs nothing: remaining only shrinks, so a candidate
    // that doesn't fit now can never fit later; rotation order stays
    // authoritative for everything that does fit. This function still doesn't
    // know or care whether the next segment is hard — the hard-start
    // fill/trim gate (Decision 66) already polices actual encroachment on a
    // real hard boundary, continuously, in real time.
    for (const candidate of rotationCandidates) {
      if (usedMusicIds.has(candidate.id)) continue;
      if (candidate.duration_seconds > remaining) continue;

      // Interstitial injection before each music track (except the very first).
      // Jingle and station-ID are mutually exclusive per boundary (D70) — a
      // station-ID never lands immediately after a jingle. Gated on whether a
      // jingle was actually PLACED, not just due, so a jingle whose pool is
      // exhausted or whose pick doesn't fit still leaves room for station-ID.
      if (musicCount > 0) {
        let jinglePlaced = false;
        if (
          jinglesEnabled &&
          jingleEveryN > 0 &&
          musicCount % jingleEveryN === 0 &&
          branding.jingles.length > 0
        ) {
          const j = nextBrandingPick(branding.jingles, jingleCursor, usedBrandingIds);
          if (j && j.duration_seconds <= remaining) {
            items.push(withCutSkip(
              brandingToItem(j, `interstitial jingle every ${jingleEveryN} tracks`),
              config,
            ));
            usedBrandingIds.add(j.id);
            remaining -= j.duration_seconds;
            jingleCursor = j.cursor + 1;
            jinglePlaced = true;
          }
        }
        if (
          !jinglePlaced &&
          stationIdsEnabled &&
          stationIdEveryN > 0 &&
          musicCount % stationIdEveryN === 0 &&
          branding.station_ids.length > 0
        ) {
          const s = nextBrandingPick(branding.station_ids, stationIdCursor, usedBrandingIds);
          if (s && s.duration_seconds <= remaining) {
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
      // Hot-play cadence: each ordinary rotation track advances the streak
      // (hot-play and heavy tracks don't — the streak counts rotation plays
      // since the last hot-play, matching the picker's play_history math).
      hotPlayStreak += 1;
      tryPlaceHotPlay();
    }

    // (d) Single boundary decision (D72/D97, retimed by D101). After the fill
    // pass every unused candidate overshoots — remaining only ever shrank, so
    // anything skipped then still doesn't fit now. Judge the minimum-overshoot
    // candidate (D97) exactly once: place it iff its overshoot is smaller than
    // the gap left by stopping. Because the gap here is necessarily smaller
    // than the shortest unused candidate, the residual lands within ~half a
    // track either way — the one-track granularity the next plan's prediction
    // sizing absorbs (D91).
    {
      let boundaryPick: (typeof music.candidates)[number] | null = null;
      for (const alt of music.candidates) {
        if (usedMusicIds.has(alt.id)) continue;
        if (boundaryPick == null || alt.duration_seconds < boundaryPick.duration_seconds) {
          boundaryPick = alt;
        }
      }
      if (boundaryPick != null && boundaryPick.duration_seconds - remaining < remaining) {
        // Force cut_allowed:true regardless of config — this function can't
        // know if the next segment is hard, so this is the safety net that
        // lets the hard-start gate trim it short if it ever matters; costs
        // nothing when it doesn't.
        items.push({ ...withCutSkip(musicCandidateToItem(boundaryPick), config), cut_allowed: true });
        usedMusicIds.add(boundaryPick.id);
        remaining -= boundaryPick.duration_seconds;
        musicCount += 1;
      }
    }
    return remaining;
  }

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
      showCtx.showId,
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
        brandingToItem(segmentStart, SEGMENT_START_ENVELOPE_REASON),
        config,
      ));
      usedBrandingIds.add(segmentStart.id);
    }

    remaining = this.fillMusicItems(
      music, branding, segment, config, remaining, items, usedMusicIds, usedBrandingIds,
    );

    // (e) Segment-end envelope.
    if (segmentEnd) {
      if (segmentEnd.duration_seconds <= remaining + segEndReserve + MIN_FILL_GAP_SECONDS) {
        items.push(withCutSkip(brandingToItem(segmentEnd, SEGMENT_END_ENVELOPE_REASON), config));
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
    opts: { skipSegmentEnvelopes?: boolean } = {},
  ): Promise<AssemblyResult> {
    const { config } = showCtx;
    const instance = { segment_id: segment.id, clock_instance_started_at: clockInstanceStartedAt };

    // D107: stop-sets honor their configured segment envelopes (break
    // bumpers) like every other segment type. Resolve them FIRST so their
    // durations can be reserved out of the sellable budget — the campaign
    // pool request below must see the reduced target, or the space estimate
    // (and thus sale-time inventory math) would count bumper time as
    // sellable. Skipped entirely on mid-flight replan (the opener already
    // aired; the pending closer is re-placed by the D104 mechanism).
    let branding: BrandingCandidatePool | null = null;
    if (!opts.skipSegmentEnvelopes && (segment.start_clip_media_id || segment.end_clip_media_id)) {
      branding = await this.requestPool<BrandingCandidatePool>(
        'branding',
        segment,
        instance,
        targetDurationSeconds,
        nowMs,
        showCtx.showId,
      );
    }
    const segmentStart = branding?.segment_start;
    const segmentEnd = branding?.segment_end;
    const usedBrandingIds = new Set<number>();
    const segStartDur = segmentStart?.duration_seconds ?? 0;
    const segEndReserve = segmentEnd?.duration_seconds ?? 0;
    const fillBudgetSeconds = Math.max(0, targetDurationSeconds - segStartDur - segEndReserve);

    // D96: Decision 75's recovery boost is retired — breaks stay
    // nominal-sized. Catch-up happens across days (quota pacing) and by
    // displacing promos inside breaks, never by stretching the break.
    const pool = await this.requestPool<StopSetCandidatePool>(
      'campaign',
      segment,
      instance,
      fillBudgetSeconds,
      nowMs,
    );

    const items: PendingAssemblyItem[] = [];
    const placed: PendingAssemblyItem[] = [];
    // Tracks which campaigns were placed at least once, for the unused_campaign_ids
    // report only — NOT an eligibility filter. Per Decision 22, a campaign may
    // appear more than once in a break; only adjacency (below) and
    // advertiser_separation_spots constrain repeats.
    const placedCampaignIds = new Set<number>();
    // D109: per-clip placement counts for this assembly, folded into
    // pickSpotWeighted's delivered figure so in-break repeats rotate clips.
    const spotPlacedCounts = new Map<number, number>();
    const usedPromoIds = new Set<number>();
    const excluded = new Set<number>();
    let remainingSeconds = fillBudgetSeconds;

    // (0) Segment-start envelope — the break opener bumper. Sits OUTSIDE the
    // sale: slot 1 (the first-in-slot position) is the first SPOT, which the
    // feeder's ground-truth stop_set_position stamping already guarantees
    // (it counts campaign ordinals, not item indexes).
    if (segmentStart) {
      items.push(withCutSkip(
        brandingToItem(segmentStart, SEGMENT_START_ENVELOPE_REASON),
        config,
      ));
      usedBrandingIds.add(segmentStart.id);
    }

    // (a) First-in-slot resolution (D96).
    // 'always' (slot_1_required) means EVERY play opens a break — such a
    // campaign contests slot 1 in every eligible break and is placeable
    // nowhere else (the fill loop and boundary decision skip it). Contest
    // winner: highest pacing_score, lowest campaign_id tie-break. Losers sit
    // this break out entirely. Sale-time validation (Phase C) owns
    // feasibility of the combined always-demand; air time just picks.
    const slot1Required = pool.candidates.filter(
      (c) => c.position_constraint === 'slot_1_required',
    );
    let slot1Claimed = false;
    if (slot1Required.length > 0) {
      const winner = pickFirstInSlot(slot1Required);
      if (winner) {
        const spot = pickSpotWeighted(winner.spot_pool, remainingSeconds, spotPlacedCounts);
        if (spot) {
          const item = withCutSkip(
            campaignToItem(winner, spot, 0, 'slot_1 winner (first-in-slot: every play)'),
            config,
          );
          items.push(item);
          placed.push(item);
          remainingSeconds -= spot.duration_seconds;
          placedCampaignIds.add(winner.id);
          spotPlacedCounts.set(spot.media_id, (spotPlacedCounts.get(spot.media_id) ?? 0) + 1);
          slot1Claimed = true;
          for (const id of winner.competing_exclusions) excluded.add(id);
        }
      }
    }
    // Every 'always' campaign is now spoken for in this break: the winner
    // placed at slot 1, the losers excluded (they may never appear mid-break).
    for (const c of slot1Required) {
      if (!placedCampaignIds.has(c.id)) excluded.add(c.id);
    }
    // 'at_least_one' (slot_1_preferred): if no 'always' campaign claimed the
    // opener, the most-behind not-yet-satisfied preferred candidate takes it —
    // this is what makes "at least once a day" real (it was dead code before
    // D96). The campaign stays an ordinary candidate for the rest of the day.
    if (!slot1Claimed) {
      const preferred = pool.candidates
        .filter((c) => c.position_constraint === 'slot_1_preferred' && !c.slot_1_satisfied_today && !excluded.has(c.id))
        .sort((a, b) => b.pacing_score - a.pacing_score || a.campaign_id - b.campaign_id);
      const first = preferred[0];
      if (first) {
        const spot = pickSpotWeighted(first.spot_pool, remainingSeconds, spotPlacedCounts);
        if (spot) {
          const item = withCutSkip(
            campaignToItem(first, spot, 0, 'slot_1 (first-in-slot: at least once daily)'),
            config,
          );
          items.push(item);
          placed.push(item);
          remainingSeconds -= spot.duration_seconds;
          placedCampaignIds.add(first.id);
          spotPlacedCounts.set(spot.media_id, (spotPlacedCounts.get(spot.media_id) ?? 0) + 1);
          for (const id of first.competing_exclusions) excluded.add(id);
        }
      }
    }

    // (c) Fill remaining break.
    // Decision 99: iteration cap + a ≥1s duration floor on spots. Campaign
    // repeats within a break are legal (Decision 22), so this loop's only
    // termination guarantee is remainingSeconds shrinking — a zero-duration
    // spot (corrupt ingest; nothing upstream rejects it) would spin this
    // synchronous loop forever and freeze the entire API process. The cap is
    // a backstop far above any real break's item count.
    let fillIterations = 0;
    while (remainingSeconds > MIN_VIABLE_SPOT_DURATION_SECONDS) {
      if (++fillIterations > 200) {
        this.logger?.error({
          event: 'STOP_SET_FILL_RUNAWAY', segment_id: segment.id,
          remaining_seconds: remainingSeconds, placed_count: placed.length,
        }, 'planner: stop-set fill exceeded the iteration cap — aborting fill (zero-duration spot in a pool?)');
        break;
      }
      let eligible = pool.candidates.filter((c) => {
        if (excluded.has(c.id)) return false;
        // 'always' first-in-slot campaigns exist only at position 0.
        if (c.position_constraint === 'slot_1_required') return false;
        return c.spot_pool.some((s) => s.duration_seconds >= 1 && s.duration_seconds <= remainingSeconds);
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
        // D96 fix: block when the customer appears ANYWHERE in the last N
        // campaign items — the old .every() only caught an all-same-customer
        // tail, so any configured separation > 1 behaved as adjacency-only.
        return !tailCustomerIds.some((cid) => cid === c.customer_id);
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
        return a.campaign_id - b.campaign_id;
      });

      const chosen = eligible[0];
      const spot = pickSpotWeighted(chosen.spot_pool, remainingSeconds, spotPlacedCounts);
      if (!spot) break;

      const reason =
        `campaign='${chosen.name}' pacing_score=${chosen.pacing_score.toFixed(2)} `;
      const item = withCutSkip(campaignToItem(chosen, spot, placed.length, reason), config);
      items.push(item);
      placed.push(item);
      remainingSeconds -= spot.duration_seconds;
      placedCampaignIds.add(chosen.id);
      spotPlacedCounts.set(spot.media_id, (spotPlacedCounts.get(spot.media_id) ?? 0) + 1);
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

    // (e) D73: single boundary decision, mirroring the music redesign (D72).
    // Campaigns and promos above only ever place content that fits without
    // overshoot — if a meaningful gap still remains, this is not drift (D73
    // removed stop-sets from drift correction entirely), it's just that the
    // spot-pool granularity couldn't fit exactly, same as music. Find the
    // smallest-overshoot option across whatever's left (a still-eligible
    // campaign's shortest spot, honoring the same separation rules as the
    // main loop, or an unused promo) and place it only if its overshoot is
    // smaller than the gap left by not placing it.
    if (remainingSeconds > 0) {
      const last = placed[placed.length - 1];
      let stillEligible = pool.candidates.filter(
        (c) => !excluded.has(c.id) && c.position_constraint !== 'slot_1_required',
      );
      stillEligible = stillEligible.filter((c) => {
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
        // D96 fix: block when the customer appears ANYWHERE in the last N
        // campaign items — the old .every() only caught an all-same-customer
        // tail, so any configured separation > 1 behaved as adjacency-only.
        return !tailCustomerIds.some((cid) => cid === c.customer_id);
      });
      if (last && last.content_type === 'campaign' && last.campaign_candidate_id != null) {
        const lastCandidateId = last.campaign_candidate_id;
        stillEligible = stillEligible.filter((c) => c.id !== lastCandidateId);
      }

      type BoundaryOption = { overshoot: number; place: () => void };
      const options: BoundaryOption[] = [];

      for (const c of stillEligible) {
        const shortest = c.spot_pool.reduce(
          (min, s) => (s.duration_seconds < min.duration_seconds ? s : min),
          c.spot_pool[0],
        );
        if (!shortest) continue;
        const overshoot = shortest.duration_seconds - remainingSeconds;
        if (overshoot <= 0) continue; // would already have been placed above
        options.push({
          overshoot,
          place: () => {
            const reason =
              `campaign='${c.name}' pacing_score=${c.pacing_score.toFixed(2)} (boundary overshoot)`;
            const item = withCutSkip(campaignToItem(c, shortest, placed.length, reason), config);
            items.push(item);
            placed.push(item);
            remainingSeconds -= shortest.duration_seconds;
            placedCampaignIds.add(c.id);
          },
        });
      }
      for (const p of pool.promos) {
        if (usedPromoIds.has(p.id)) continue;
        const overshoot = p.duration_seconds - remainingSeconds;
        if (overshoot <= 0) continue;
        options.push({
          overshoot,
          place: () => {
            const reason = `promo pacing_score=${p.pacing_score.toFixed(2)} (boundary overshoot)`;
            items.push(withCutSkip(promoToItem(p, reason), config));
            usedPromoIds.add(p.id);
            remainingSeconds -= p.duration_seconds;
          },
        });
      }

      if (options.length > 0) {
        options.sort((a, b) => a.overshoot - b.overshoot);
        const best = options[0];
        if (best.overshoot < remainingSeconds) {
          best.place();
        }
      }
    }

    // (f) Segment-end envelope — the break closer bumper, placed from the
    // reserve taken up-front (same mechanism as the music path's step (e)).
    if (segmentEnd) {
      items.push(withCutSkip(brandingToItem(segmentEnd, SEGMENT_END_ENVELOPE_REASON), config));
      usedBrandingIds.add(segmentEnd.id);
    }

    return {
      items,
      unused_music_ids: [],
      unused_branding_ids: branding ? collectUnusedBrandingIds(branding, usedBrandingIds) : [],
      unused_campaign_ids: pool.candidates
        .filter((c) => !placedCampaignIds.has(c.id))
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
    opts: { skipSegmentEnvelopes?: boolean } = {},
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
      ? await this.requestPool<MusicCandidatePool>('music', segment, instance, targetDurationSeconds, nowMs, showCtx.showId)
      : null;

    const items: PendingAssemblyItem[] = [];
    const usedMusicIds = new Set<number>();
    const usedBrandingIds = new Set<number>();
    const usedRundownIds = new Set<number>();

    // D107: mid-flight replan must not re-insert segment envelopes (the
    // opener already aired; the pending closer is re-placed by the caller).
    const segmentStart = opts.skipSegmentEnvelopes ? undefined : branding.segment_start;
    const segmentEnd = opts.skipSegmentEnvelopes ? undefined : branding.segment_end;

    // Reserve durations up-front.
    const showStartDur = (showCtx.isShowStart && branding.show_start)
      ? branding.show_start.duration_seconds : 0;
    const showEndReserve = (showCtx.isShowEnd && branding.show_end)
      ? branding.show_end.duration_seconds : 0;
    const segEndReserve = segmentEnd?.duration_seconds ?? 0;

    // (0) Show-start envelope.
    if (showCtx.isShowStart && branding.show_start) {
      items.push(showEnvelopeItem(branding.show_start, 'show_start envelope'));
      usedBrandingIds.add(branding.show_start.id);
    }

    // (a) Segment-start envelope.
    if (segmentStart) {
      items.push(withCutSkip(
        brandingToItem(segmentStart, SEGMENT_START_ENVELOPE_REASON),
        config,
      ));
      usedBrandingIds.add(segmentStart.id);
    }

    // (b) Rundown items in position order (mandatory), within budget.
    // Decision 35/99: the planner owns compression — clips that don't fit the
    // target are dropped from the tail with a RUNDOWN_OVERFLOW log. Without
    // this check, a long fallback playlist got placed IN FULL as mandatory
    // items (a 40-minute playlist on a 5-minute news slot would blow through
    // every downstream segment with content nothing may skip or cut). The
    // first clip is always placed even if it alone overruns the budget — a
    // news segment airing its lead story long beats airing nothing; the
    // overrun is absorbed by the next plan's sizing like any other overshoot.
    const rundownBudgetSeconds = Math.max(
      0,
      targetDurationSeconds
        - showStartDur
        - (segmentStart?.duration_seconds ?? 0)
        - segEndReserve
        - showEndReserve,
    );
    let totalRundownDuration = 0;
    let droppedRundownCount = 0;
    let droppedRundownSeconds = 0;
    const orderedRundown = rundown.items.slice().sort((a, b) => a.position - b.position);
    for (let i = 0; i < orderedRundown.length; i++) {
      const item = orderedRundown[i];
      const wouldTotal = totalRundownDuration + item.duration_seconds;
      if (totalRundownDuration > 0 && wouldTotal > rundownBudgetSeconds) {
        // Strict tail drop (D35): rundown order is editorial — once a clip
        // doesn't fit, everything after it is dropped too, never reordered
        // around by omission.
        for (let j = i; j < orderedRundown.length; j++) {
          droppedRundownCount += 1;
          droppedRundownSeconds += orderedRundown[j].duration_seconds;
        }
        break;
      }
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
      totalRundownDuration = wouldTotal;
    }
    if (droppedRundownCount > 0) {
      this.logger?.warn({
        event: 'RUNDOWN_OVERFLOW', segment_id: segment.id,
        budget_seconds: Math.round(rundownBudgetSeconds),
        placed_seconds: Math.round(totalRundownDuration),
        dropped_count: droppedRundownCount,
        dropped_seconds: Math.round(droppedRundownSeconds),
      }, 'planner: rundown content exceeds the segment budget — tail clips dropped (D35)');
    }

    const startEnvDur = (segmentStart?.duration_seconds ?? 0) + showStartDur;
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
            items,
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
      segmentEnd &&
      segmentEnd.duration_seconds <= remaining + segEndReserve + MIN_FILL_GAP_SECONDS
    ) {
      items.push(withCutSkip(
        brandingToItem(segmentEnd, SEGMENT_END_ENVELOPE_REASON),
        config,
      ));
      usedBrandingIds.add(segmentEnd.id);
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
    resolutionIdentity: string | null,
    // Decision 93 drift-ledger columns, computed by buildPlan.
    ledgerColumns?: {
      nominal_duration_seconds: number;
      target_duration_seconds: number;
      predicted_drift_seconds: number | null;
      applied_correction_seconds: number | null;
    },
  ): Promise<number> {
    const inserted = await this.db
      .insert(plansTable)
      .values({
        segment_id: segment.id,
        clock_instance_started_at: clockInstanceStartedAt,
        resolution_identity: resolutionIdentity,
        status: 'draft',
        created_at: nowMs,
        finalized_at: null,
        ...(ledgerColumns ?? {}),
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

    // RETURN_UNUSED deliberately not emitted: Decision 63 Part C retired it
    // (no process ever subscribed — unused candidates leave no trace and
    // self-correct for free). The emit outlived the retirement and was the
    // first thing D102's zero-listener bus detection caught after deploy.
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
      .select({ id: clockSegments.id, sort_order: clockSegments.sort_order, duration_seconds: clockSegments.duration_seconds })
      .from(clockSegments)
      .where(eq(clockSegments.clock_id, clockId));
    orderedSegs.sort((a, b) => a.sort_order - b.sort_order);

    if (orderedSegs.length === 0) return { isShowStart: false, isShowEnd: false };

    const firstId = orderedSegs[0]!.id;
    const lastId = orderedSegs[orderedSegs.length - 1]!.id;
    // Decision 95: clock instances are tiles with the clock's OWN period —
    // "the next instance" starts one clock-duration after this one, not one
    // wall-clock hour.
    const clockDurationMs = orderedSegs.reduce((sum, s) => sum + s.duration_seconds, 0) * 1000;

    // is_show_start: first segment of clock AND the previous moment belongs
    // to a different show (or silence), i.e. this is the first tile of the
    // show block.
    let isShowStart = false;
    if (segmentId === firstId) {
      const prevSeg = await resolveCurrentSegment(clockInstanceStartedAt - 1, this.db);
      isShowStart = !prevSeg || prevSeg.show_id !== showId;
    }

    // is_show_end: last segment of clock AND the next tile belongs to a
    // different show (or silence).
    let isShowEnd = false;
    if (segmentId === lastId) {
      const nextSeg = await resolveCurrentSegment(clockInstanceStartedAt + clockDurationMs + 1, this.db);
      isShowEnd = !nextSeg || nextSeg.show_id !== showId;
    }

    return { isShowStart, isShowEnd };
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
    // Decision 92: items already placed in this plan — the texture rule
    // rejects a non-music pick that would stack same-type or make a third
    // consecutive non-music item.
    placedSoFar: PendingAssemblyItem[] = [],
  ): { item: PendingAssemblyItem } | null {
    const max = Math.max(0, remainingSeconds - 2);
    if (max < MIN_FILL_GAP_SECONDS) return null;

    const fillContentType: PlanItemContentType | null =
      type === 'station_ids' ? 'station_id'
      : type === 'jingles' ? 'jingle'
      : type === 'promos' ? 'promo'
      : type === 'songs' ? 'music'
      : null;
    if (fillContentType != null && !textureAllows(placedSoFar, fillContentType)) {
      return null;
    }

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
    return a.campaign_id - b.campaign_id;
  });
  return sorted[0] ?? null;
}

// D96 weighted rotation: among fitting spots, the one most behind its
// weighted share airs next (lowest delivered ÷ weight; ties → fewer
// delivered, then media_id). Stateless — delivered counts come from
// play_history via the pool. Decision 99's ≥1s floor stays: termination of
// the fill loop depends on every placement shrinking the remainder.
function pickSpotWeighted(
  pool: SpotCandidate[],
  remainingSeconds: number,
  // D109: `delivered` is a play_history figure snapshotted into the pool —
  // blind to picks made earlier in the same assembly, so a campaign repeated
  // within one break would re-air the identical clip forever (the tie-breaks
  // are deterministic). Callers that can place the same campaign more than
  // once per assembly pass their running per-clip counts here; folding them
  // into `delivered` makes the existing weighted rotation alternate clips
  // within a break exactly as it already does across breaks.
  placedThisAssembly?: Map<number, number>,
): SpotCandidate | null {
  const fits = pool.filter((s) => s.duration_seconds >= 1 && s.duration_seconds <= remainingSeconds);
  if (fits.length === 0) return null;
  const effectiveDelivered = (s: SpotCandidate) =>
    s.delivered + (placedThisAssembly?.get(s.media_id) ?? 0);
  fits.sort((a, b) => {
    const da = effectiveDelivered(a);
    const db = effectiveDelivered(b);
    const ra = da / Math.max(1, a.weight);
    const rb = db / Math.max(1, b.weight);
    if (ra !== rb) return ra - rb;
    if (da !== db) return da - db;
    return a.media_id - b.media_id;
  });
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
  // D109: per-clip counts of campaign spots already in the plan, so the
  // replacement pick rotates instead of re-picking a clip the plan holds.
  spotPlacedCounts?: Map<number, number>,
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
      const spot = pickSpotWeighted(pick.spot_pool, item.planned_duration_seconds, spotPlacedCounts);
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
