// Campaign content process — Phase 2.
//
// Responds to REQUEST_CANDIDATES for stop-set segments with a
// StopSetCandidatePool containing:
//   - eligible spot campaigns (with their per-campaign spot pool)
//   - eligible promos (embedded — Decision 16: no separate promo process)
//   - a BreakSpaceEstimate over the break duration
//
// D96 eligibility gates, in order, per campaign: date range → allowed
// airing windows (the only fence) → hard wall (delivered ≥ total_plays) →
// daily cap + min gap → weighted spot pool non-empty → guarantee urgency
// (interval/show scopes are minimums, never filters) → derived daily quota
// with in-day spread. Placement constraints (advertiser_separation,
// competing_exclusions, first-in-slot competition) are NOT applied here —
// the Planner enforces those per Decision 22.
//
// State changes happen only on CONFIRM_USED. The request handler is a pure
// read against play_history, campaigns, promos, and their media tables.

import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { db as defaultDb } from '../../../db/index.js';
import type { SLogger } from '../supervisorLogger.js';
import {
  broadcastIntervals as broadcastIntervalsTable,
  broadcastIntervalSlots as broadcastIntervalSlotsTable,
  calendarEntries as calendarEntriesTable,
  campaignMedia as campaignMediaTable,
  campaigns as campaignsTable,
  clockSegments,
  media as mediaTable,
  playHistory as playHistoryTable,
  promoMedia as promoMediaTable,
  promos as promosTable,
  stationSettings as stationSettingsTable,
} from '../../../db/schema.js';
import { bus, type BusMessage, type ContentProcessName } from '../bus.js';
import { campaignCompletedPlayFilter } from '../playHistoryViews.js';
import { computeDailyQuota } from '@soono/shared';
import type {
  BreakSpaceEstimate,
  CampaignCandidate,
  PromoCandidate,
  SpotCandidate,
  StopSetCandidatePool,
  PositionConstraint,
} from '../types.js';

const PROCESS_NAME: ContentProcessName = 'campaign';
// occupation_ratio above this is flagged oversubscribed (Decision 14).
const OVERSUBSCRIBED_THRESHOLD = 0.9;
// Promos only (campaign eligibility uses D96 quota pacing instead): a promo
// this far ahead of its min_plays_per_day target stops being offered.
const AHEAD_OF_PACE_THRESHOLD = 0.05;

export class CampaignProcess {
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly _bus: typeof bus,
    private readonly db: typeof defaultDb = defaultDb,
    private readonly logger: SLogger | null = null,
  ) {}

  start(): void {
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'REQUEST_CANDIDATES' }>(
        'REQUEST_CANDIDATES',
        (msg) => {
          if (msg.process !== PROCESS_NAME) return;
          // Decision 98/99: without this catch, a transient throw inside the
          // pool build (DB hiccup) became an unhandled promise rejection and
          // crashed the whole API process (Node default). The planner's own
          // request timeout + failure signalling handle the missing
          // CANDIDATES response; this guard's only job is keeping the
          // process alive.
          void this.handleRequest(msg).catch((err) => {
            this.logger?.error(
              { err, process: 'campaign', event: 'CANDIDATES_REQUEST_FAILED', request_id: msg.request_id, segment_id: msg.segment_id },
              'campaign: REQUEST_CANDIDATES handler failed',
            );
          });
        },
      ),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'CONFIRM_USED' }>('CONFIRM_USED', (msg) => {
        if (msg.process !== PROCESS_NAME) return;
        // Pacing, promo plays, and slot-1 satisfaction are all derived from
        // play_history, which the queue feeder writes when audio airs. No
        // in-memory state to advance here.
      }),
    );
    this.unsubscribers.push(
      this._bus.on<BusMessage & { type: 'DROP_COMMITTED' }>('DROP_COMMITTED', (msg) => {
        if (msg.process !== PROCESS_NAME) return;
        // No DB rollback needed — CONFIRM_USED did not write anything.
      }),
    );
  }

  stop(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }

  private async handleRequest(
    msg: BusMessage & { type: 'REQUEST_CANDIDATES' },
  ): Promise<void> {
    const pool = await this.buildPool(
      msg.segment_id,
      msg.duration_needed_seconds,
      msg.clock_instance_started_at,
      msg.now_ms,
    );
    this._bus.emit({
      type: 'CANDIDATES',
      request_id: msg.request_id,
      process: PROCESS_NAME,
      payload: pool,
    });
  }

  async buildPool(
    segmentId: number,
    durationNeededSeconds: number,
    clockInstanceStartedAt: number,
    nowMs: number,
  ): Promise<StopSetCandidatePool> {
    const [segment] = await this.db
      .select()
      .from(clockSegments)
      .where(eq(clockSegments.id, segmentId));

    const today = ymdFromMs(nowMs);
    const midnightMsToday = midnightMs(nowMs);

    // The break's SCHEDULED start (clock instance start + the segment's
    // offset within its clock), not the request time — plans are drafted
    // minutes ahead, and a break at 14:02 must be judged against a window
    // opening at 14:00 even when the draft happens at 13:58.
    const breakStartMs = await this.scheduledBreakStartMs(segment, clockInstanceStartedAt);
    const breakDow = isoDayOfWeek(breakStartMs);
    const breakMinOfDay = minutesOfDay(breakStartMs);

    // Interval windows for the break's day-of-week (per-day slot overrides
    // the interval's default times) + station-level advertising defaults.
    const windowsByIntervalId = await this.loadIntervalWindows(breakDow);
    const stationDefaults = await this.loadStationAdDefaults();

    // Resolve the show airing over this instance, if any (guarantee scope).
    const showId = await this.resolveShowId(clockInstanceStartedAt);

    // Pull every active spot campaign whose date range covers today.
    const rawCampaigns = await this.db
      .select()
      .from(campaignsTable)
      .where(
        and(
          eq(campaignsTable.active, true),
          sql`${campaignsTable.starts_on} <= ${today}`,
          sql`${campaignsTable.ends_on} >= ${today}`,
        ),
      );

    // Per-campaign play counts + last-play timestamps today's gates need.
    const campaignIds = rawCampaigns.map((c) => c.id);
    const todayPlaysByCampaign = await this.countPlaysByCampaign(
      campaignIds,
      midnightMsToday,
      nowMs,
    );
    const lastPlayMsByCampaign = await this.lastPlayMsByCampaign(campaignIds);

    const candidates: CampaignCandidate[] = [];
    let hardClaimedSeconds = 0;
    let contestedSeconds = 0;

    for (const campaign of rawCampaigns) {
      // ── Gate 2: allowed-airtime restriction (D96) ─────────────────────────
      // Campaign's own windows, else the station's standard commercial day,
      // else unrestricted. Empty array = inherit (no meaningful "nothing
      // allowed" state). This is the ONLY fence — show/interval associations
      // below are guarantee scopes (minimums), never eligibility filters.
      const allowedIds = normalizeIdList(campaign.allowed_interval_ids)
        ?? stationDefaults.allowedIntervalIds;
      if (allowedIds != null && allowedIds.length > 0) {
        const inWindow = allowedIds.some((id) => {
          const w = windowsByIntervalId.get(id);
          return w != null && breakMinOfDay >= w.startMin && breakMinOfDay < w.endMin;
        });
        if (!inWindow) continue;
      }

      // ── Gate 3: hard wall — contract volume is a ceiling, never advisory.
      // The check whose absence let 2,563 plays air against a 90/month
      // quota. Also retires legacy rows migrated with total_plays=0.
      const deliveredTotal = await this.countPlaysInRange(
        campaign.id,
        dateStringToMs(campaign.starts_on),
        nowMs,
      );
      if (deliveredTotal >= campaign.total_plays) continue;

      // ── Gate 4: daily cap + minimum gap between plays ─────────────────────
      const playsToday = todayPlaysByCampaign.get(campaign.id) ?? 0;
      if (campaign.max_plays_per_day != null && playsToday >= campaign.max_plays_per_day) {
        continue;
      }
      if (campaign.min_gap_minutes != null) {
        const lastMs = lastPlayMsByCampaign.get(campaign.id);
        if (lastMs != null && breakStartMs - lastMs < campaign.min_gap_minutes * 60_000) {
          continue;
        }
      }

      // ── Gate 5: spot pool (weighted, benched excluded, fits the break) ────
      const spotPool = await this.loadSpotPool(campaign.id, durationNeededSeconds);
      if (spotPool.length === 0) continue;

      // ── Gate 6: guarantee urgency (replaces `mandatory`) ──────────────────
      // Interval guarantee: this break sits inside the guaranteed interval's
      // window today and today's plays INSIDE that window are below N.
      // Show guarantee: this instance is the guaranteed show and plays this
      // airing are below N. Scopes are minimums — a campaign whose guarantee
      // scope doesn't match this break is still an ordinary candidate.
      let guaranteeBehind = 0;
      if (campaign.interval_id != null && campaign.interval_plays_per_day != null) {
        const w = windowsByIntervalId.get(campaign.interval_id);
        if (w != null && breakMinOfDay >= w.startMin && breakMinOfDay < w.endMin) {
          const winStartMs = midnightMsToday + w.startMin * 60_000;
          const winEndMs = midnightMsToday + w.endMin * 60_000;
          const inWindowPlays = await this.countPlaysInWindow(campaign.id, winStartMs, winEndMs);
          if (inWindowPlays < campaign.interval_plays_per_day) {
            guaranteeBehind = Math.max(
              guaranteeBehind,
              1 - inWindowPlays / campaign.interval_plays_per_day,
            );
          }
        }
      }
      if (campaign.show_id != null && campaign.plays_per_show != null && campaign.show_id === showId) {
        const playsThisAiring = await this.countPlaysInRange(
          campaign.id,
          clockInstanceStartedAt,
          nowMs,
        );
        if (playsThisAiring < campaign.plays_per_show) {
          guaranteeBehind = Math.max(
            guaranteeBehind,
            1 - playsThisAiring / campaign.plays_per_show,
          );
        }
      }
      const mandatory = guaranteeBehind > 0;

      // ── Gate 7: derived daily quota + in-day spread (replaces D74) ────────
      // quota = remaining ÷ remaining days, capped by the catch-up limit
      // (× original even pace) and the daily cap. Guarantee urgency bypasses
      // the quota gate — a promised play is owed regardless of pace.
      // One formula, three consumers: this gate, the delivery ledger, and
      // the day-by-day forecast (Phase D) — they can never disagree.
      const quota = computeDailyQuota({
        totalPlays: campaign.total_plays,
        delivered: deliveredTotal,
        totalDays: daysInclusive(campaign.starts_on, campaign.ends_on),
        remainingDays: daysInclusive(today, campaign.ends_on),
        catchUpFactor: campaign.catch_up_factor ?? stationDefaults.catchUpFactor,
        maxPlaysPerDay: campaign.max_plays_per_day,
        pacingMode: campaign.pacing_mode,
      });

      let pacingScore: number;
      if (campaign.pacing_mode === 'asap') {
        // Burst: no quota gate; eager but below any guarantee urgency.
        pacingScore = 1;
      } else {
        if (!mandatory && playsToday >= quota) continue;
        // Spread today's quota across the day: expected-by-now runs linearly
        // over the campaign's allowed airtime (whole day when unrestricted).
        const dayFraction = allowedWindowsElapsedFraction(
          allowedIds, windowsByIntervalId, breakMinOfDay,
        );
        const expectedByNow = quota * dayFraction;
        pacingScore = quota > 0 ? Math.max(0, expectedByNow - playsToday) / quota : 0;
      }
      if (mandatory) pacingScore = 1 + guaranteeBehind;

      // slot_1_satisfied_today: did this campaign already open a break today?
      // Consumed by the planner's at_least_one handling (slot_1_preferred).
      const slot1Satisfied = await this.checkSlot1SatisfiedToday(
        campaign.id,
        midnightMsToday,
        nowMs,
      );

      const positionConstraint: PositionConstraint = campaign.first_in_slot
        ? (campaign.first_in_slot_mode === 'always'
            ? 'slot_1_required'
            : 'slot_1_preferred')
        : 'any';

      const minSpotDuration = Math.min(...spotPool.map((s) => s.duration_seconds));
      const avgSpotDuration =
        spotPool.reduce((sum, s) => sum + s.duration_seconds, 0) / spotPool.length;

      if (mandatory) hardClaimedSeconds += minSpotDuration;
      else contestedSeconds += avgSpotDuration;

      candidates.push({
        id: campaign.id,
        campaign_id: campaign.id,
        customer_id: campaign.customer_id,
        name: campaign.name,
        pacing_score: pacingScore,
        position_constraint: positionConstraint,
        slot_1_satisfied_today: slot1Satisfied,
        competing_exclusions: parseIdList(campaign.competing_exclusions),
        advertiser_separation_spots: campaign.advertiser_separation_spots,
        spot_pool: spotPool,
        mandatory,
      });
    }

    // ── Promos ────────────────────────────────────────────────────────────
    const promosPool = await this.loadPromoCandidates(
      showId,
      durationNeededSeconds,
      midnightMsToday,
      today,
      nowMs,
    );

    // ── Space estimate ────────────────────────────────────────────────────
    const breakDuration = segment?.duration_seconds ?? durationNeededSeconds;
    const freeSeconds = Math.max(0, breakDuration - hardClaimedSeconds - contestedSeconds);
    const occupationRatio =
      breakDuration > 0
        ? (hardClaimedSeconds + contestedSeconds) / breakDuration
        : 0;

    const spaceEstimate: BreakSpaceEstimate = {
      break_duration_seconds: breakDuration,
      hard_claimed_seconds: hardClaimedSeconds,
      contested_seconds: contestedSeconds,
      free_seconds: freeSeconds,
      occupation_ratio: occupationRatio,
      oversubscribed: occupationRatio > OVERSUBSCRIBED_THRESHOLD,
      candidate_count: candidates.length,
    };

    if (candidates.length === 0 && rawCampaigns.length > 0) {
      this.logger?.warn({ process: 'campaign', event: 'EMPTY_POOL', segment_id: segmentId, raw_campaign_count: rawCampaigns.length }, 'campaign: no eligible campaigns for this stop-set segment');
    }

    return {
      candidates,
      promos: promosPool,
      space_estimate: spaceEstimate,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async loadSpotPool(
    campaignId: number,
    maxDurationSeconds: number,
  ): Promise<SpotCandidate[]> {
    const rows = await this.db
      .select({
        media_id: mediaTable.id,
        duration_seconds: mediaTable.duration_seconds,
        cue_in_seconds: mediaTable.cue_in_seconds,
        cue_out_seconds: mediaTable.cue_out_seconds,
        weight: campaignMediaTable.weight,
      })
      .from(campaignMediaTable)
      .innerJoin(mediaTable, eq(campaignMediaTable.media_id, mediaTable.id))
      .where(
        and(
          eq(campaignMediaTable.campaign_id, campaignId),
          eq(campaignMediaTable.play_as_spot, true),
        ),
      );
    // Per-spot delivered counts since campaign start — the weighted rotation
    // pick (planner) is lowest delivered ÷ weight, derived from play_history
    // like all rotation state (no cursor rows).
    const deliveredRows = await this.db
      .select({
        media_id: playHistoryTable.media_id,
        n: sql<number>`COUNT(*)`.as('n'),
      })
      .from(playHistoryTable)
      .where(
        and(
          eq(playHistoryTable.campaign_id, campaignId),
          campaignCompletedPlayFilter,
        ),
      )
      .groupBy(playHistoryTable.media_id);
    const deliveredByMedia = new Map<number, number>();
    for (const r of deliveredRows) {
      if (r.media_id != null) deliveredByMedia.set(r.media_id, Number(r.n));
    }
    return rows
      .filter((r) => r.weight > 0) // weight 0 = deliberately benched
      .map((r) => ({
        media_id: r.media_id,
        duration_seconds: effectiveDuration(r),
        campaign_id: campaignId,
        weight: r.weight,
        delivered: deliveredByMedia.get(r.media_id) ?? 0,
      }))
      .filter((s) => s.duration_seconds <= maxDurationSeconds);
  }

  private async countPlaysByCampaign(
    campaignIds: number[],
    sinceMs: number,
    nowMs: number,
  ): Promise<Map<number, number>> {
    if (campaignIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        campaign_id: playHistoryTable.campaign_id,
        n: sql<number>`COUNT(*)`.as('n'),
      })
      .from(playHistoryTable)
      .where(
        and(
          isNotNull(playHistoryTable.campaign_id),
          inArray(playHistoryTable.campaign_id, campaignIds),
          gte(playHistoryTable.started_at, new Date(sinceMs)),
          campaignCompletedPlayFilter,
        ),
      )
      .groupBy(playHistoryTable.campaign_id);
    void nowMs;
    const out = new Map<number, number>();
    for (const r of rows) {
      if (r.campaign_id == null) continue;
      out.set(r.campaign_id, Number(r.n));
    }
    return out;
  }

  private async countPlaysInRange(
    campaignId: number,
    sinceMs: number,
    nowMs: number,
  ): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)`.as('n') })
      .from(playHistoryTable)
      .where(
        and(
          eq(playHistoryTable.campaign_id, campaignId),
          gte(playHistoryTable.started_at, new Date(sinceMs)),
          campaignCompletedPlayFilter,
        ),
      );
    void nowMs;
    return Number(rows[0]?.n ?? 0);
  }

  // Until plan_items is queryable at runtime, slot-1 satisfaction is read
  // from play_history.stop_set_position = 1 over today's window. Falls back
  // to "any play today" if the column is absent — see the limitation note
  // in the file header.
  private async checkSlot1SatisfiedToday(
    campaignId: number,
    midnightMsToday: number,
    nowMs: number,
  ): Promise<boolean> {
    const rows = await this.db
      .select({ id: playHistoryTable.id })
      .from(playHistoryTable)
      .where(
        and(
          eq(playHistoryTable.campaign_id, campaignId),
          eq(playHistoryTable.stop_set_position, 1),
          gte(playHistoryTable.started_at, new Date(midnightMsToday)),
          campaignCompletedPlayFilter,
        ),
      )
      .limit(1);
    void nowMs;
    return rows.length > 0;
  }

  private async loadPromoCandidates(
    showId: number | null,
    maxDurationSeconds: number,
    midnightMsToday: number,
    today: string,
    nowMs: number,
  ): Promise<PromoCandidate[]> {
    const activePromos = await this.db
      .select()
      .from(promosTable)
      .where(
        and(
          eq(promosTable.active, true),
          sql`${promosTable.starts_on} <= ${today}`,
          sql`${promosTable.ends_on} >= ${today}`,
        ),
      );
    const out: PromoCandidate[] = [];
    for (const promo of activePromos) {
      // Targeting: respect "no air during this show".
      if (promo.no_air_during_show && promo.show_id != null && showId === promo.show_id) {
        continue;
      }
      // Daily cap.
      const playsToday = await this.countPromoPlays(promo.id, midnightMsToday, nowMs);
      if (playsToday >= promo.max_plays_per_day) continue;
      // Decision 74: promos get the same ahead-of-pace eligibility discipline
      // as campaigns — their only "target" basis is the daily minimum, so
      // ahead-of-pace means already ≥5% over that minimum today. No minimum
      // configured (0) means there's nothing to be ahead of; skip the check.
      if (
        promo.min_plays_per_day > 0 &&
        playsToday >= promo.min_plays_per_day * (1 + AHEAD_OF_PACE_THRESHOLD)
      ) {
        continue;
      }

      const mediaRows = await this.db
        .select({
          id: mediaTable.id,
          duration_seconds: mediaTable.duration_seconds,
          cue_in_seconds: mediaTable.cue_in_seconds,
          cue_out_seconds: mediaTable.cue_out_seconds,
        })
        .from(promoMediaTable)
        .innerJoin(mediaTable, eq(promoMediaTable.media_id, mediaTable.id))
        .where(eq(promoMediaTable.promo_id, promo.id));

      const minTarget = promo.min_plays_per_day;
      const pacingScore = Math.max(0, 1 - playsToday / Math.max(1, minTarget));

      for (const m of mediaRows) {
        const dur = effectiveDuration(m);
        if (dur > maxDurationSeconds) continue;
        out.push({
          id: promo.id * 1_000_000 + m.id,
          promo_id: promo.id,
          media_id: m.id,
          duration_seconds: dur,
          pacing_score: pacingScore,
        });
      }
    }
    return out;
  }

  private async countPromoPlays(
    promoId: number,
    sinceMs: number,
    nowMs: number,
  ): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)`.as('n') })
      .from(playHistoryTable)
      .where(
        and(
          eq(playHistoryTable.promo_id, promoId),
          gte(playHistoryTable.started_at, new Date(sinceMs)),
          campaignCompletedPlayFilter,
        ),
      );
    void nowMs;
    return Number(rows[0]?.n ?? 0);
  }

  // Resolve show_id from a clock_instance_started_at by matching the calendar
  // entry that contains that timestamp. The instance start is used (rather
  // than now_ms) so the show context is stable for the whole instance.
  private async resolveShowId(clockInstanceStartedAt: number): Promise<number | null> {
    const date = ymdFromMs(clockInstanceStartedAt);
    const hhmm = hhmmFromMs(clockInstanceStartedAt);
    const rows = await this.db
      .select({
        show_id: calendarEntriesTable.show_id,
        time_start: calendarEntriesTable.time_start,
        time_end: calendarEntriesTable.time_end,
      })
      .from(calendarEntriesTable)
      .where(eq(calendarEntriesTable.date, date));
    for (const r of rows) {
      if (r.time_start <= hhmm && hhmm < r.time_end) {
        return r.show_id ?? null;
      }
    }
    return null;
  }


  // ── D96 helpers ───────────────────────────────────────────────────────────

  // The break's scheduled start = clock instance start + the sum of segment
  // durations before it in its clock.
  private async scheduledBreakStartMs(
    segment: { id: number; clock_id: number; sort_order: number } | undefined,
    clockInstanceStartedAt: number,
  ): Promise<number> {
    if (!segment) return clockInstanceStartedAt;
    const rows = await this.db
      .select({
        duration_seconds: clockSegments.duration_seconds,
        sort_order: clockSegments.sort_order,
      })
      .from(clockSegments)
      .where(eq(clockSegments.clock_id, segment.clock_id));
    let offsetSec = 0;
    for (const r of rows) {
      if (r.sort_order < segment.sort_order) offsetSec += r.duration_seconds;
    }
    return clockInstanceStartedAt + offsetSec * 1000;
  }

  // Interval windows for a day-of-week: the per-day slot overrides the
  // interval's default times (same resolution rule as spotBudget.ts).
  private async loadIntervalWindows(
    dow: number,
  ): Promise<Map<number, { startMin: number; endMin: number }>> {
    const [intervalRows, slotRows] = await Promise.all([
      this.db.select({
        id: broadcastIntervalsTable.id,
        default_start_time: broadcastIntervalsTable.default_start_time,
        default_end_time: broadcastIntervalsTable.default_end_time,
      }).from(broadcastIntervalsTable),
      this.db.select({
        interval_id: broadcastIntervalSlotsTable.interval_id,
        start_time: broadcastIntervalSlotsTable.start_time,
        end_time: broadcastIntervalSlotsTable.end_time,
      }).from(broadcastIntervalSlotsTable)
        .where(eq(broadcastIntervalSlotsTable.day_of_week, dow)),
    ]);
    const slotByInterval = new Map(slotRows.map((r) => [r.interval_id, r]));
    const out = new Map<number, { startMin: number; endMin: number }>();
    for (const iv of intervalRows) {
      const slot = slotByInterval.get(iv.id);
      out.set(iv.id, {
        startMin: hhmmToMin(slot ? slot.start_time : iv.default_start_time),
        endMin: hhmmToMin(slot ? slot.end_time : iv.default_end_time),
      });
    }
    return out;
  }

  private async loadStationAdDefaults(): Promise<{
    allowedIntervalIds: number[] | null;
    catchUpFactor: number;
  }> {
    const [row] = await this.db
      .select({
        default_allowed_interval_ids: stationSettingsTable.default_allowed_interval_ids,
        default_catch_up_factor: stationSettingsTable.default_catch_up_factor,
      })
      .from(stationSettingsTable)
      .where(eq(stationSettingsTable.id, 1));
    return {
      allowedIntervalIds: normalizeIdList(row?.default_allowed_interval_ids),
      catchUpFactor: row?.default_catch_up_factor ?? 2,
    };
  }

  private async lastPlayMsByCampaign(campaignIds: number[]): Promise<Map<number, number>> {
    if (campaignIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        campaign_id: playHistoryTable.campaign_id,
        last: sql<number>`MAX(unixepoch(${playHistoryTable.started_at}))`.as('last'),
      })
      .from(playHistoryTable)
      .where(
        and(
          isNotNull(playHistoryTable.campaign_id),
          inArray(playHistoryTable.campaign_id, campaignIds),
          campaignCompletedPlayFilter,
        ),
      )
      .groupBy(playHistoryTable.campaign_id);
    const out = new Map<number, number>();
    for (const r of rows) {
      if (r.campaign_id != null && r.last != null) out.set(r.campaign_id, Number(r.last) * 1000);
    }
    return out;
  }

  // Plays whose start landed inside [winStartMs, winEndMs) — the honest
  // measure for an interval guarantee (plays outside the window don't count
  // toward it even on the same day).
  private async countPlaysInWindow(
    campaignId: number,
    winStartMs: number,
    winEndMs: number,
  ): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`COUNT(*)`.as('n') })
      .from(playHistoryTable)
      .where(
        and(
          eq(playHistoryTable.campaign_id, campaignId),
          gte(playHistoryTable.started_at, new Date(winStartMs)),
          sql`${playHistoryTable.started_at} < ${new Date(winEndMs)}`,
          campaignCompletedPlayFilter,
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface MediaDurationCols {
  duration_seconds: number;
  cue_in_seconds: number | null;
  cue_out_seconds: number | null;
}

function effectiveDuration(m: MediaDurationCols): number {
  if (m.cue_in_seconds != null && m.cue_out_seconds != null) {
    const eff = m.cue_out_seconds - m.cue_in_seconds;
    if (eff > 0) return eff;
  }
  return m.duration_seconds;
}

function parseIdList(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.filter((n): n is number => typeof n === 'number');
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((n): n is number => typeof n === 'number')
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

// JSON id-array column → number[] | null; empty/invalid = null (inherit).
function normalizeIdList(raw: unknown): number[] | null {
  const list = parseIdList(raw);
  return list.length > 0 ? list : null;
}

function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function minutesOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

// Inclusive day count between two YYYY-MM-DD dates (same day = 1).
function daysInclusive(fromYmd: string, toYmd: string): number {
  const from = new Date(fromYmd + 'T00:00:00');
  const to = new Date(toYmd + 'T00:00:00');
  return Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
}

// How far through the campaign's allowed airtime today the break sits, in
// [0, 1] — drives the in-day spread of the daily quota. Unrestricted
// campaigns spread over the whole day.
function allowedWindowsElapsedFraction(
  allowedIds: number[] | null,
  windowsByIntervalId: Map<number, { startMin: number; endMin: number }>,
  breakMinOfDay: number,
): number {
  if (allowedIds == null || allowedIds.length === 0) {
    return Math.max(0, Math.min(1, breakMinOfDay / (24 * 60)));
  }
  let total = 0;
  let elapsed = 0;
  for (const id of allowedIds) {
    const w = windowsByIntervalId.get(id);
    if (!w || w.endMin <= w.startMin) continue;
    total += w.endMin - w.startMin;
    elapsed += Math.max(0, Math.min(breakMinOfDay, w.endMin) - w.startMin);
  }
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, elapsed / total));
}

function midnightMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function ymdFromMs(nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function hhmmFromMs(nowMs: number): string {
  const d = new Date(nowMs);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// Returns 1 (Mon) … 7 (Sun) — matches the schema's day_of_week convention.
function isoDayOfWeek(nowMs: number): number {
  const d = new Date(nowMs);
  const js = d.getDay(); // 0=Sun..6=Sat
  return js === 0 ? 7 : js;
}

function dateStringToMs(yyyymmdd: string): number {
  // Treat the campaign starts_on/ends_on dates as local midnight, matching
  // how the UI sets them.
  const [y, m, d] = yyyymmdd.split('-').map((s) => parseInt(s, 10));
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
  return dt.getTime();
}

function startOfIsoWeekMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  // Move to Monday of this week.
  const dow = isoDayOfWeek(nowMs);
  d.setDate(d.getDate() - (dow - 1));
  return d.getTime();
}
