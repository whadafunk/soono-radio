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
//
// All async errors inside event handlers are caught and logged. The Planner
// works offline — it never calls HarborClient.

import { randomUUID } from 'crypto';
import { and, eq, gte } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { db as defaultDb } from '../../../db/index.js';
import {
  clockSegments,
  plans as plansTable,
  planItems as planItemsTable,
  stopSetEstimates as stopSetEstimatesTable,
  type ClockSegment,
  type PlanItemContentType,
  type PlanItemInsert,
} from '../../../db/schema.js';
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

export class PlannerProcess {
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly _bus: typeof bus,
    private readonly db: typeof defaultDb = defaultDb,
    private readonly logger: FastifyBaseLogger | null = null,
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
    await this.finalizePlan(msg.plan_id, msg.now_ms);
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

    const planId = await this.insertPlanRow(segment, clockInstanceStartedAt, nowMs);

    const result = await this.assembleForSegment(
      segment,
      clockInstanceStartedAt,
      targetDurationSeconds,
      nowMs,
    );

    await this.persistPlanItems(planId, result.items);
    await this.notifyContentProcesses(result, planId, nowMs);
    await this.persistStopSetEstimateIfAny(planId, segment.id, result.space_estimate, nowMs);

    this.logger?.info(
      {
        event: 'PLAN_DRAFT_COMPLETE',
        plan_id: planId,
        segment_id: segment.id,
        segment_type: segment.type,
        item_count: result.items.length,
      },
      'planner: draft complete',
    );

    return planId;
  }

  // Finalization pass. Re-requests candidates and substitutes any pending
  // item whose backing candidate is no longer present in the fresh pool
  // (campaign hit daily cap, etc.). Upserts stop_set_estimates with fresh
  // numbers when the segment is a stop-set. Updates plan status to 'finalized'.
  async finalizePlan(planId: number, nowMs: number): Promise<void> {
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

    const pendingItems = await this.db
      .select()
      .from(planItemsTable)
      .where(and(eq(planItemsTable.plan_id, planId), eq(planItemsTable.status, 'pending')));

    // Lightweight check: re-request candidate pools and verify each pending
    // item still has a backing candidate. Items whose backing candidate has
    // disappeared (campaign hit daily cap, promo over min target) are
    // substituted with the first eligible replacement from the fresh pool.
    // Full re-assembly is intentionally deferred — substitution is enough to
    // pick up the most common drift cases (cap hits, slot-1 resolution).
    let substitutions = 0;
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
        const replacement = pickReplacement(item, freshMusic, freshCampaign);
        if (!replacement) continue;
        await this.db
          .update(planItemsTable)
          .set({ status: 'dropped' })
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
        });
        substitutions += 1;
      }

      // Upsert the stop-set estimate with fresh numbers if the campaign pool
      // is available. Decision 28: one row per plan, updated in place.
      if (freshCampaign) {
        await this.persistStopSetEstimateIfAny(
          planId,
          segment.id,
          freshCampaign.space_estimate,
          nowMs,
        );
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
        substitutions,
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

    // Mark them dropped before re-assembling so the replacement positions
    // are reserved cleanly.
    for (const it of dropping) {
      await this.db
        .update(planItemsTable)
        .set({ status: 'dropped' })
        .where(eq(planItemsTable.id, it.id));
    }

    const result = await this.assembleForSegment(
      segment,
      plan.clock_instance_started_at,
      remainingSeconds,
      nowMs,
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
  ): Promise<AssemblyResult> {
    switch (segment.type) {
      case 'music':
        return this.assembleMusicPlan(
          segment,
          clockInstanceStartedAt,
          targetDurationSeconds,
          nowMs,
        );
      case 'stop_set':
        return this.assembleStopSetPlan(
          segment,
          clockInstanceStartedAt,
          targetDurationSeconds,
          nowMs,
        );
      case 'news':
      case 'bulletin':
      case 'voice_track':
        return this.assembleRundownPlan(
          segment,
          clockInstanceStartedAt,
          targetDurationSeconds,
          nowMs,
        );
      case 'live':
        return emptyResult();
      default:
        return emptyResult();
    }
  }

  // ─── Music segment assembly ─────────────────────────────────────────────────

  private async assembleMusicPlan(
    segment: ClockSegment,
    clockInstanceStartedAt: number,
    targetDurationSeconds: number,
    nowMs: number,
  ): Promise<AssemblyResult> {
    const music = await this.requestPool<MusicCandidatePool>(
      'music',
      segment,
      { segment_id: segment.id, clock_instance_started_at: clockInstanceStartedAt },
      targetDurationSeconds,
      nowMs,
    );
    const branding = await this.requestPool<BrandingCandidatePool>(
      'branding',
      segment,
      { segment_id: segment.id, clock_instance_started_at: clockInstanceStartedAt },
      targetDurationSeconds,
      nowMs,
    );

    const items: PendingAssemblyItem[] = [];
    const usedMusicIds = new Set<number>();
    const usedBrandingIds = new Set<number>();

    const isHardEnd = readStartPolicy(segment.start_policy).type === 'hard';
    const segmentStart = branding.segment_start;
    const segmentEnd = branding.segment_end;
    const endReserveSeconds = segmentEnd?.duration_seconds ?? 0;

    // (a) Segment-start envelope
    if (segmentStart) {
      items.push(brandingToItem(segmentStart, 'segment_start envelope'));
      usedBrandingIds.add(segmentStart.id);
    }

    // (b/c) Compute fillable budget = target - start envelope - reserve for end envelope.
    const startDur = segmentStart?.duration_seconds ?? 0;
    let remaining = targetDurationSeconds - startDur - endReserveSeconds;

    // (d) Music + interstitial cadence.
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
            items.push(brandingToItem(j, `interstitial jingle every ${jingleEveryN} tracks`));
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
            items.push(
              brandingToItem(s, `interstitial station_id every ${stationIdEveryN} tracks`),
            );
            usedBrandingIds.add(s.id);
            remaining -= s.duration_seconds;
            stationIdCursor = s.cursor + 1;
          }
        }
      }

      if (!tryFitItem(candidate.duration_seconds)) {
        // For hard-end, walk to the next (shorter) candidate; for flexible we
        // would have already broken out via the loop guards.
        continue;
      }
      items.push(musicCandidateToItem(candidate));
      usedMusicIds.add(candidate.id);
      remaining -= candidate.duration_seconds;
      musicCount += 1;
    }

    // (e) Gap fill via coasting_order when allowed and gap is large enough.
    if (segment.can_fill && remaining > MIN_FILL_GAP_SECONDS) {
      const coastingOrder = parseDriftEventTypes(segment.coasting_order);
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
        );
        if (placed) {
          items.push(placed.item);
          remaining -= placed.item.planned_duration_seconds;
        }
      }
    }

    // (f) Segment-end envelope.
    if (segmentEnd) {
      // Only add if it still fits (it was reserved up-front, so it should).
      if (segmentEnd.duration_seconds <= remaining + endReserveSeconds + MIN_FILL_GAP_SECONDS) {
        items.push(brandingToItem(segmentEnd, 'segment_end envelope'));
        usedBrandingIds.add(segmentEnd.id);
      }
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
  ): Promise<AssemblyResult> {
    const pool = await this.requestPool<StopSetCandidatePool>(
      'campaign',
      segment,
      { segment_id: segment.id, clock_instance_started_at: clockInstanceStartedAt },
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
          const item = campaignToItem(winner, spot, 0, 'slot_1 winner (first-in-slot)');
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
      // 1. Filter candidates: remove excluded, remove campaigns with no spot
      //    fitting remaining time.
      let eligible = pool.candidates.filter((c) => {
        if (excluded.has(c.id)) return false;
        if (usedCampaignIds.has(c.id)) return false;
        return c.spot_pool.some((s) => s.duration_seconds <= remainingSeconds);
      });

      if (eligible.length === 0) break;

      // 2. Advertiser separation: if the last N placed items are from the same
      //    customer_id (N = candidate.advertiser_separation_spots), exclude
      //    that customer for this slot.
      eligible = eligible.filter((c) => {
        if (c.advertiser_separation_spots <= 0) return true;
        const tail = placed
          .slice(-c.advertiser_separation_spots)
          .filter((it) => it.content_type === 'campaign');
        if (tail.length === 0) return true;
        // Look up customer_ids of tail items by joining back to their candidate.
        const tailCustomerIds = tail
          .map((it) => {
            const orig = pool.candidates.find((p) => p.id === it.campaign_candidate_id);
            return orig?.customer_id;
          })
          .filter((id): id is number => id != null);
        return !tailCustomerIds.every((cid) => cid === c.customer_id);
      });

      if (eligible.length === 0) break;

      // 3. Campaign separation: exclude the immediately-preceding campaign.
      const last = placed[placed.length - 1];
      if (last && last.content_type === 'campaign' && last.campaign_candidate_id != null) {
        const lastCandidateId = last.campaign_candidate_id;
        eligible = eligible.filter((c) => c.id !== lastCandidateId);
      }

      if (eligible.length === 0) break;

      // 4. Sort: mandatory desc, pacing_score desc, priority(hard>best_effort),
      //    campaign_id asc.
      eligible.sort((a, b) => {
        if (a.mandatory !== b.mandatory) return a.mandatory ? -1 : 1;
        if (a.pacing_score !== b.pacing_score) return b.pacing_score - a.pacing_score;
        const ap = a.priority === 'hard' ? 0 : 1;
        const bp = b.priority === 'hard' ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return a.campaign_id - b.campaign_id;
      });

      // 5. Pick first; from its spot_pool, pick the longest spot fitting.
      const chosen = eligible[0];
      const spot = pickLongestSpotThatFits(chosen.spot_pool, remainingSeconds);
      if (!spot) break;

      const reason =
        `campaign='${chosen.name}' pacing_score=${chosen.pacing_score.toFixed(2)} ` +
        `priority=${chosen.priority}`;
      const item = campaignToItem(chosen, spot, placed.length, reason);
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
      items.push(promoToItem(promo, reason));
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
  ): Promise<AssemblyResult> {
    const rundown = await this.requestPool<RundownCandidatePool>(
      'rundown',
      segment,
      { segment_id: segment.id, clock_instance_started_at: clockInstanceStartedAt },
      targetDurationSeconds,
      nowMs,
    );
    const branding = await this.requestPool<BrandingCandidatePool>(
      'branding',
      segment,
      { segment_id: segment.id, clock_instance_started_at: clockInstanceStartedAt },
      targetDurationSeconds,
      nowMs,
    );
    // Music is only requested if 'songs' appears in coasting_order — small
    // optimisation, also gives content processes the chance to skip work.
    const coastingOrder = parseDriftEventTypes(segment.coasting_order);
    const needsMusic = coastingOrder.includes('songs') && segment.can_fill;
    const music = needsMusic
      ? await this.requestPool<MusicCandidatePool>(
          'music',
          segment,
          { segment_id: segment.id, clock_instance_started_at: clockInstanceStartedAt },
          targetDurationSeconds,
          nowMs,
        )
      : null;

    const items: PendingAssemblyItem[] = [];
    const usedMusicIds = new Set<number>();
    const usedBrandingIds = new Set<number>();
    const usedRundownIds = new Set<number>();

    // (a) Optional segment_start envelope
    if (branding.segment_start) {
      items.push(brandingToItem(branding.segment_start, 'segment_start envelope'));
      usedBrandingIds.add(branding.segment_start.id);
    }

    // Place rundown items in position order (mandatory).
    let totalRundownDuration = 0;
    const orderedRundown = rundown.items.slice().sort((a, b) => a.position - b.position);
    for (const item of orderedRundown) {
      items.push({
        media_id: item.media_id,
        content_type:
          segment.type === 'voice_track' ? 'voice_track' : 'rundown',
        campaign_id: null,
        music_campaign_id: null,
        planned_duration_seconds: item.duration_seconds,
        mandatory: true,
        reason: `rundown position=${item.position}`,
        rundown_candidate_id: item.id,
      });
      usedRundownIds.add(item.id);
      totalRundownDuration += item.duration_seconds;
    }

    // Recompute gap from actual rundown items (more accurate than the pool's
    // gap_estimate_seconds, which was based on segment.duration_seconds).
    const startEnvDur = branding.segment_start?.duration_seconds ?? 0;
    const endReserve = branding.segment_end?.duration_seconds ?? 0;
    let remaining =
      targetDurationSeconds - startEnvDur - totalRundownDuration - endReserve;

    // (e) Gap fill via coasting_order.
    if (segment.can_fill && remaining > MIN_FILL_GAP_SECONDS) {
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
        );
        if (placed) {
          items.push(placed.item);
          remaining -= placed.item.planned_duration_seconds;
        }
      }
    }

    // (f) Optional segment_end envelope
    if (
      branding.segment_end &&
      branding.segment_end.duration_seconds <= remaining + endReserve + MIN_FILL_GAP_SECONDS
    ) {
      items.push(brandingToItem(branding.segment_end, 'segment_end envelope'));
      usedBrandingIds.add(branding.segment_end.id);
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
  ): { item: PendingAssemblyItem } | null {
    const max = Math.max(0, remainingSeconds - 2);
    if (max < MIN_FILL_GAP_SECONDS) return null;

    switch (type) {
      case 'station_ids': {
        const sorted = pools.branding.station_ids
          .filter((c) => !usedBrandingIds.has(c.id) && c.duration_seconds <= max)
          .sort((a, b) => a.duration_seconds - b.duration_seconds);
        const pick = sorted[0];
        if (!pick) return null;
        usedBrandingIds.add(pick.id);
        return { item: brandingToItem(pick, `coasting fill: gap≈${remainingSeconds.toFixed(0)}s, station_id`) };
      }
      case 'jingles': {
        const sorted = pools.branding.jingles
          .filter((c) => !usedBrandingIds.has(c.id) && c.duration_seconds <= max)
          .sort((a, b) => a.duration_seconds - b.duration_seconds);
        const pick = sorted[0];
        if (!pick) return null;
        usedBrandingIds.add(pick.id);
        return { item: brandingToItem(pick, `coasting fill: gap≈${remainingSeconds.toFixed(0)}s, jingle`) };
      }
      case 'songs': {
        if (!pools.music) return null;
        const sorted = pools.music.candidates
          .filter((c) => !usedMusicIds.has(c.id) && c.duration_seconds <= max)
          .sort((a, b) => a.duration_seconds - b.duration_seconds);
        const pick = sorted[0];
        if (!pick) return null;
        usedMusicIds.add(pick.id);
        return { item: musicCandidateToItem(pick) };
      }
      case 'promos': {
        if (!pools.campaign) return null;
        const sorted = pools.campaign.promos
          .filter((c) => !usedPromoIds.has(c.id) && c.duration_seconds <= max)
          .sort((a, b) => a.duration_seconds - b.duration_seconds);
        const pick = sorted[0];
        if (!pick) return null;
        usedPromoIds.add(pick.id);
        return { item: promoToItem(pick, `coasting fill: gap≈${remainingSeconds.toFixed(0)}s, promo`) };
      }
      case 'spots': {
        // Not applicable for non-stop-set segments — coasting must never use
        // contract-bound spots as filler outside a planned break.
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

// ─── Conversion helpers ───────────────────────────────────────────────────────

function musicCandidateToItem(c: MusicCandidate): PendingAssemblyItem {
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

function brandingToItem(c: BrandingCandidate, reasonPrefix: string): PendingAssemblyItem {
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
): PendingAssemblyItem {
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

function promoToItem(p: PromoCandidate, reason: string): PendingAssemblyItem {
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
      if (!freshCampaign) return true; // no fresh data → keep
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
      // Branding / rundown / voice_track / filler / station_id / jingle —
      // not re-validated in the lightweight finalize pass.
      return true;
  }
}

function pickReplacement(
  item: { content_type: PlanItemContentType; planned_duration_seconds: number },
  freshMusic: MusicCandidatePool | null,
  freshCampaign: StopSetCandidatePool | null,
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
    if (pick) return musicCandidateToItem(pick);
  }
  if (item.content_type === 'campaign' && freshCampaign) {
    const sorted = freshCampaign.candidates
      .filter((c) => c.spot_pool.some((s) => s.duration_seconds <= item.planned_duration_seconds))
      .sort((a, b) => b.pacing_score - a.pacing_score);
    const pick = sorted[0];
    if (pick) {
      const spot = pickLongestSpotThatFits(pick.spot_pool, item.planned_duration_seconds);
      if (spot) {
        return campaignToItem(pick, spot, 0, `replacement: ${pick.name} pacing_score=${pick.pacing_score.toFixed(2)}`);
      }
    }
  }
  if (item.content_type === 'promo' && freshCampaign) {
    const sorted = freshCampaign.promos
      .filter((p) => p.duration_seconds <= item.planned_duration_seconds)
      .sort((a, b) => b.pacing_score - a.pacing_score);
    const pick = sorted[0];
    if (pick) return promoToItem(pick, `replacement promo pacing_score=${pick.pacing_score.toFixed(2)}`);
  }
  return null;
}
