// Campaign content process — Phase 2.
//
// Responds to REQUEST_CANDIDATES for stop-set segments with a
// StopSetCandidatePool containing:
//   - eligible spot campaigns (with their per-campaign spot pool)
//   - eligible promos (embedded — Decision 16: no separate promo process)
//   - a BreakSpaceEstimate over the break duration
//
// Eligibility filters are binary per-campaign (date range, days of week,
// time window, daily cap, show targeting, interval targeting, spot pool
// non-empty after duration filtering). Placement constraints
// (advertiser_separation, competing_exclusions, first-in-slot competition)
// are NOT applied here — the Planner enforces those per Decision 22.
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
} from '../../../db/schema.js';
import { bus, type BusMessage, type ContentProcessName } from '../bus.js';
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
// Pacing score above this AND priority=hard => mandatory.
const MANDATORY_PACING_THRESHOLD = 0.2;

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
          void this.handleRequest(msg);
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
    const todayHHMM = hhmmFromMs(nowMs);
    const dow = isoDayOfWeek(nowMs);
    const midnightMsToday = midnightMs(nowMs);

    // Resolve the show and broadcast interval that scope this stop-set, if any.
    const showId = await this.resolveShowId(clockInstanceStartedAt);
    const intervalId = await this.resolveIntervalId(nowMs);

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

    // Per-campaign play counts today (for daily cap + per-show pacing).
    const todayPlaysByCampaign = await this.countPlaysByCampaign(
      rawCampaigns.map((c) => c.id),
      midnightMsToday,
      nowMs,
    );

    const candidates: CampaignCandidate[] = [];
    let hardClaimedSeconds = 0;
    let contestedSeconds = 0;

    for (const campaign of rawCampaigns) {
      // ── Binary eligibility filters ────────────────────────────────────────
      if (!isWithinTimeWindow(campaign.time_window_start, campaign.time_window_end, todayHHMM)) {
        continue;
      }
      if (!isDayOfWeekAllowed(campaign.days_of_week, dow)) {
        continue;
      }
      if (campaign.show_id != null && campaign.show_id !== showId) {
        continue;
      }
      if (campaign.interval_id != null && campaign.interval_id !== intervalId) {
        continue;
      }
      const playsToday = todayPlaysByCampaign.get(campaign.id) ?? 0;
      if (campaign.max_plays_per_day != null && playsToday >= campaign.max_plays_per_day) {
        continue;
      }

      // ── Spot pool (filtered to fit the break) ─────────────────────────────
      const spotPool = await this.loadSpotPool(campaign.id, durationNeededSeconds);
      if (spotPool.length === 0) continue;

      // ── Pacing (global, per-show, per-interval) ──────────────────────────
      const pacingScore = await this.computePacingScore(
        campaign,
        showId,
        intervalId,
        clockInstanceStartedAt,
        nowMs,
      );

      // ── slot_1_satisfied_today: did this campaign already air in slot 1
      // today? Until plan_items is the source of truth at runtime, derive
      // from play_history via stop_set_position = 1. Plays that predate the
      // V2 stop_set_position column lack this signal; conservatively treat
      // them as not satisfying slot 1.
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

      const mandatory =
        campaign.priority === 'hard' && pacingScore >= MANDATORY_PACING_THRESHOLD;

      const minSpotDuration = Math.min(...spotPool.map((s) => s.duration_seconds));
      const avgSpotDuration =
        spotPool.reduce((sum, s) => sum + s.duration_seconds, 0) / spotPool.length;

      if (mandatory) hardClaimedSeconds += minSpotDuration;
      else if (campaign.priority === 'best_effort') contestedSeconds += avgSpotDuration;

      candidates.push({
        id: campaign.id,
        campaign_id: campaign.id,
        customer_id: campaign.customer_id,
        name: campaign.name,
        priority: campaign.priority,
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

    return { candidates, promos: promosPool, space_estimate: spaceEstimate };
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
      })
      .from(campaignMediaTable)
      .innerJoin(mediaTable, eq(campaignMediaTable.media_id, mediaTable.id))
      .where(
        and(
          eq(campaignMediaTable.campaign_id, campaignId),
          eq(campaignMediaTable.play_as_spot, true),
        ),
      );
    return rows
      .map((r) => ({
        media_id: r.media_id,
        duration_seconds: effectiveDuration(r),
        campaign_id: campaignId,
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

  // Pacing score = max(global_behind, per_show_behind, per_interval_behind).
  // Each level is a [0, 1+] value where 0 = on/ahead of target and 1 = none
  // delivered of the expected amount by now.
  private async computePacingScore(
    campaign: typeof campaignsTable.$inferSelect,
    showId: number | null,
    intervalId: number | null,
    clockInstanceStartedAt: number,
    nowMs: number,
  ): Promise<number> {
    const globalBehind = await this.globalPacingBehind(campaign, nowMs);

    let perShowBehind = 0;
    if (
      campaign.show_id != null &&
      showId != null &&
      campaign.show_id === showId &&
      campaign.plays_per_show != null
    ) {
      const playsThisShowInstance = await this.countPlaysInRange(
        campaign.id,
        clockInstanceStartedAt,
        nowMs,
      );
      perShowBehind = Math.max(
        0,
        1 - playsThisShowInstance / campaign.plays_per_show,
      );
    }

    let perIntervalBehind = 0;
    if (
      campaign.interval_id != null &&
      intervalId != null &&
      campaign.interval_id === intervalId &&
      campaign.interval_plays_per_week != null
    ) {
      const weekStartMs = startOfIsoWeekMs(nowMs);
      const playsThisWeek = await this.countPlaysInRange(
        campaign.id,
        weekStartMs,
        nowMs,
      );
      perIntervalBehind = Math.max(
        0,
        1 - playsThisWeek / campaign.interval_plays_per_week,
      );
    }

    return Math.max(globalBehind, perShowBehind, perIntervalBehind);
  }

  // Linear-interpolated global pacing: expected plays by now vs. actual plays.
  private async globalPacingBehind(
    campaign: typeof campaignsTable.$inferSelect,
    nowMs: number,
  ): Promise<number> {
    const startMs = dateStringToMs(campaign.starts_on);
    const endMs = dateStringToMs(campaign.ends_on) + 24 * 3600 * 1000;
    if (!(nowMs > startMs)) return 0;
    const totalMs = endMs - startMs;
    const elapsedMs = Math.max(0, Math.min(totalMs, nowMs - startMs));
    if (totalMs <= 0) return 0;

    // plays_per_month is a per-month target; the campaign date range can
    // exceed (or fall short of) a month. Project to total expected plays
    // across the campaign window using calendar months.
    const months = totalMs / (30 * 24 * 3600 * 1000);
    const totalPlanned = campaign.plays_per_month * months;
    const expectedByNow = totalPlanned * (elapsedMs / totalMs);
    if (expectedByNow <= 0) return 0;

    const actual = await this.countPlaysInRange(campaign.id, startMs, nowMs);
    return Math.max(0, 1 - actual / expectedByNow);
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

  // Resolve the broadcast interval that contains now_ms by matching its
  // per-day slot for today.
  private async resolveIntervalId(nowMs: number): Promise<number | null> {
    const dow = isoDayOfWeek(nowMs);
    const hhmm = hhmmFromMs(nowMs);
    const rows = await this.db
      .select({
        interval_id: broadcastIntervalSlotsTable.interval_id,
        start_time: broadcastIntervalSlotsTable.start_time,
        end_time: broadcastIntervalSlotsTable.end_time,
      })
      .from(broadcastIntervalSlotsTable)
      .innerJoin(
        broadcastIntervalsTable,
        eq(broadcastIntervalsTable.id, broadcastIntervalSlotsTable.interval_id),
      )
      .where(eq(broadcastIntervalSlotsTable.day_of_week, dow));
    for (const r of rows) {
      if (r.start_time <= hhmm && hhmm < r.end_time) {
        return r.interval_id;
      }
    }
    return null;
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

function isWithinTimeWindow(
  start: string | null,
  end: string | null,
  hhmm: string,
): boolean {
  if (!start && !end) return true;
  if (start && hhmm < start) return false;
  if (end && hhmm >= end) return false;
  return true;
}

function isDayOfWeekAllowed(daysCsv: string | null, dow: number): boolean {
  if (!daysCsv) return true;
  const allowed = daysCsv
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  if (allowed.length === 0) return true;
  return allowed.includes(dow);
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
