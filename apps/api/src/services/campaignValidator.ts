// D96 Phase C — sale-time campaign validation.
//
// One function answers "can the schedule keep this promise?" against the
// D95 break projection (real break times) intersected with the campaign's
// allowed airing windows. Consumed live by the campaign form, per-campaign
// on demand, and in bulk for the problem badges. Never accept a promise the
// schedule cannot keep (the replacement for the retired `priority` field).
//
// Capacity models are deliberately conservative (documented per check):
//   - volume counts 1 play per campaign per break (the adjacency rule bounds
//     a single campaign there in practice);
//   - seconds are sold against EFFECTIVE capacity (after the promo margin) —
//     the margin is the station's catch-up shock absorber and is never sold;
//   - competing exclusions are group-summed (two rivals can never share a
//     break, so their demands add);
//   - a mutual-exclusion partner's overlap is measured on the partner's own
//     eligible break set, so a daytime partner doesn't eat a night
//     campaign's capacity.

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  broadcastIntervals as broadcastIntervalsTable,
  broadcastIntervalSlots as broadcastIntervalSlotsTable,
  campaigns as campaignsTable,
  playHistory as playHistoryTable,
  stationSettings as stationSettingsTable,
} from '../db/schema.js';
import { campaignCompletedPlayFilter } from './supervisor2/playHistoryViews.js';
import { getOccurrences, type StopSetOccurrence } from './spotBudget.js';
import type {
  CampaignValidationCheck,
  CampaignValidationDraft,
  CampaignValidationResult,
  CampaignValidationSummaryRow,
} from '@soono/shared';
import { computeDailyQuota } from '@soono/shared';

interface IntervalWindow { startMin: number; endMin: number }
// dow (1-7) → interval id → window
type WindowsByDow = Map<number, Map<number, IntervalWindow>>;

function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

async function loadWindowsByDow(): Promise<WindowsByDow> {
  const [intervals, slots] = await Promise.all([
    db.select({
      id: broadcastIntervalsTable.id,
      default_start_time: broadcastIntervalsTable.default_start_time,
      default_end_time: broadcastIntervalsTable.default_end_time,
    }).from(broadcastIntervalsTable),
    db.select({
      interval_id: broadcastIntervalSlotsTable.interval_id,
      day_of_week: broadcastIntervalSlotsTable.day_of_week,
      start_time: broadcastIntervalSlotsTable.start_time,
      end_time: broadcastIntervalSlotsTable.end_time,
    }).from(broadcastIntervalSlotsTable),
  ]);
  const out: WindowsByDow = new Map();
  for (let dow = 1; dow <= 7; dow++) {
    const m = new Map<number, IntervalWindow>();
    for (const iv of intervals) {
      const slot = slots.find((s) => s.interval_id === iv.id && s.day_of_week === dow);
      m.set(iv.id, {
        startMin: hhmmToMin(slot ? slot.start_time : iv.default_start_time),
        endMin: hhmmToMin(slot ? slot.end_time : iv.default_end_time),
      });
    }
    out.set(dow, m);
  }
  return out;
}

function occInAllowed(
  occ: StopSetOccurrence,
  allowedIds: number[] | null,
  windows: WindowsByDow,
): boolean {
  if (allowedIds == null || allowedIds.length === 0) return true;
  const dayWindows = windows.get(occ.dow);
  if (!dayWindows) return false;
  const t = hhmmToMin(occ.timeStart);
  return allowedIds.some((id) => {
    const w = dayWindows.get(id);
    return w != null && t >= w.startMin && t < w.endMin;
  });
}

function occKey(o: StopSetOccurrence): string {
  return `${o.date}:${o.timeStart}:${o.clockSegmentId}`;
}

function normalizeIds(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const list = raw.filter((n): n is number => typeof n === 'number');
  return list.length > 0 ? list : null;
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function validateCampaignDraft(
  draft: CampaignValidationDraft,
): Promise<CampaignValidationResult> {
  const checks: CampaignValidationCheck[] = [];
  const push = (key: string, level: CampaignValidationCheck['level'], message: string) =>
    checks.push({ key, level, message });

  const today = todayYmd();
  if (draft.ends_on < today) {
    push('period', 'warn', 'The campaign period is entirely in the past — nothing left to validate.');
    return { verdict: 'warnings', checks };
  }
  const periodStart = new Date(`${draft.starts_on > today ? draft.starts_on : today}T00:00:00`);
  const periodEnd = new Date(`${draft.ends_on}T00:00:00`);

  const [windows, stationRow, occurrences, activeCampaigns] = await Promise.all([
    loadWindowsByDow(),
    db.select({
      default_allowed_interval_ids: stationSettingsTable.default_allowed_interval_ids,
      promo_margin: stationSettingsTable.promo_margin,
    }).from(stationSettingsTable).where(eq(stationSettingsTable.id, 1)),
    getOccurrences({ start: periodStart, end: periodEnd }, 'remaining'),
    db.select().from(campaignsTable).where(
      and(
        eq(campaignsTable.active, true),
        sql`${campaignsTable.ends_on} >= ${today}`,
      ),
    ),
  ]);
  const stationDefaults = normalizeIds(stationRow[0]?.default_allowed_interval_ids);
  const promoMargin = stationRow[0]?.promo_margin ?? 0.1;
  const others = activeCampaigns.filter((c) => c.id !== (draft.id ?? -1));

  // Delivered counts for remaining-plays math (draft + all others in one query).
  const deliveredByCampaign = new Map<number, number>();
  const idsToCount = others.map((c) => c.id).concat(draft.id != null ? [draft.id] : []);
  if (idsToCount.length > 0) {
    const rows = await db
      .select({ campaign_id: playHistoryTable.campaign_id, n: sql<number>`COUNT(*)`.as('n') })
      .from(playHistoryTable)
      .where(and(
        isNotNull(playHistoryTable.campaign_id),
        inArray(playHistoryTable.campaign_id, idsToCount),
        campaignCompletedPlayFilter,
      ))
      .groupBy(playHistoryTable.campaign_id);
    for (const r of rows) if (r.campaign_id != null) deliveredByCampaign.set(r.campaign_id, Number(r.n));
  }
  const draftRemaining = Math.max(
    0, draft.total_plays - (draft.id != null ? (deliveredByCampaign.get(draft.id) ?? 0) : 0),
  );

  const allowedIds = normalizeIds(draft.allowed_interval_ids) ?? stationDefaults;
  const eligible = occurrences.filter((o) => occInAllowed(o, allowedIds, windows));
  const eligibleKeys = new Set(eligible.map(occKey));

  if (eligible.length === 0) {
    push('supply', 'fail', 'No commercial breaks exist in the allowed airing windows for this period — the campaign could never air.');
    return { verdict: 'refuse', checks };
  }

  // ── Bracket vs break sizes ────────────────────────────────────────────────
  const minBreak = Math.min(...eligible.map((o) => o.durationSeconds));
  if (draft.duration_bracket == null) {
    // Warn, never fail: a missing bracket is a normal pre-media state, not a
    // sale blocker — it gets derived from the first attached spot clip.
    push('bracket', 'warn', 'Duration bracket not set — it will be derived from the first attached clip.');
  } else if (draft.duration_bracket > minBreak) {
    push('bracket', 'fail',
      `The ${draft.duration_bracket}s bracket does not fit the smallest break in the allowed windows (${Math.round(minBreak)}s) — those breaks could never carry this spot.`);
  } else {
    push('bracket', 'ok', `Bracket ${draft.duration_bracket}s fits every break in the allowed windows (smallest: ${Math.round(minBreak)}s).`);
  }

  // ── Volume: 1 play per campaign per break, exclusion partners subtract ────
  const exclusionSet = new Set(draft.competing_exclusions ?? []);
  let partnerRemaining = 0;
  for (const c of others) {
    if (!exclusionSet.has(c.id)) continue;
    const rem = Math.max(0, c.total_plays - (deliveredByCampaign.get(c.id) ?? 0));
    partnerRemaining += rem;
  }
  const volumeCapacity = eligible.length - partnerRemaining;
  if (draftRemaining > volumeCapacity) {
    push('volume', 'fail',
      `${draftRemaining} plays still to deliver, but only ${eligible.length} breaks exist in the allowed windows` +
      (partnerRemaining > 0 ? ` and ${partnerRemaining} are spoken for by excluded competitors` : '') +
      ` — at one play per break, up to ${Math.max(0, volumeCapacity)} plays fit.`);
  } else if (draftRemaining > volumeCapacity * 0.9) {
    push('volume', 'warn',
      `${draftRemaining} plays against ${volumeCapacity} usable breaks — over 90% of the break count. Deliverable, but leaves almost no slack for outages.`);
  } else {
    push('volume', 'ok', `${draftRemaining} plays fit comfortably in ${volumeCapacity} usable breaks.`);
  }

  // ── Seconds: sold against effective capacity (promo margin reserved) ──────
  if (draft.duration_bracket == null) {
    push('seconds', 'warn', 'Seconds-capacity check skipped — bracket not set yet (derived from the first attached clip).');
  } else {
    const effectiveSeconds = eligible.reduce((s, o) => s + o.durationSeconds, 0) * (1 - promoMargin);
    const draftDemand = draftRemaining * draft.duration_bracket;
    let overlapDemand = 0;
    for (const c of others) {
      // Bracket-less campaigns have no clips, can't air, and claim no time.
      if (c.duration_bracket == null) continue;
      const rem = Math.max(0, c.total_plays - (deliveredByCampaign.get(c.id) ?? 0));
      if (rem === 0) continue;
      const cAllowed = normalizeIds(c.allowed_interval_ids) ?? stationDefaults;
      const cEligible = occurrences.filter((o) => occInAllowed(o, cAllowed, windows));
      if (cEligible.length === 0) continue;
      const shared = cEligible.filter((o) => eligibleKeys.has(occKey(o))).length;
      overlapDemand += rem * c.duration_bracket * (shared / cEligible.length);
    }
    const totalDemand = draftDemand + overlapDemand;
    if (totalDemand > effectiveSeconds) {
      push('seconds', 'fail',
        `This campaign needs ${Math.round(draftDemand / 60)} min of sellable time; together with the ${Math.round(overlapDemand / 60)} min other campaigns already claim in the same windows, that exceeds the ${Math.round(effectiveSeconds / 60)} min available (after the ${Math.round(promoMargin * 100)}% station reserve).`);
    } else if (totalDemand > effectiveSeconds * 0.9) {
      push('seconds', 'warn',
        `Sellable time in the allowed windows would be ${Math.round((totalDemand / effectiveSeconds) * 100)}% committed — deliverable, but the station reserve becomes the only slack.`);
    } else {
      push('seconds', 'ok',
        `${Math.round(draftDemand / 60)} min needed, ${Math.round((effectiveSeconds - overlapDemand) / 60)} min free in the allowed windows.`);
    }
  }

  // ── Interval guarantee: worst daily occurrence binds ──────────────────────
  if (draft.interval_id != null && draft.interval_plays_per_day != null) {
    const inAllowed = allowedIds == null || allowedIds.includes(draft.interval_id);
    if (!inAllowed) {
      push('guarantee_interval', 'fail',
        'The guaranteed interval is outside the allowed airing windows — the promise could never be kept. Add it to the allowed windows or pick another interval.');
    } else {
      const perDate = new Map<string, number>();
      for (const o of occurrences) {
        const w = windows.get(o.dow)?.get(draft.interval_id);
        if (!w) continue;
        const t = hhmmToMin(o.timeStart);
        if (t >= w.startMin && t < w.endMin) perDate.set(o.date, (perDate.get(o.date) ?? 0) + 1);
      }
      if (perDate.size === 0) {
        push('guarantee_interval', 'fail', 'No breaks fall inside the guaranteed interval during this period — the daily guarantee could never be met.');
      } else {
        const worstDay = Math.min(...perDate.values());
        // Same-interval guarantees from other campaigns reserve capacity;
        // mutual exclusions are implicitly covered (they also hold breaks).
        let reserved = 0;
        for (const c of others) {
          if (c.interval_id === draft.interval_id && c.interval_plays_per_day != null) {
            reserved += c.interval_plays_per_day;
          }
        }
        if (draft.interval_plays_per_day + reserved > worstDay) {
          push('guarantee_interval', 'fail',
            `The guarantee asks for ${draft.interval_plays_per_day} plays per day in this interval, but its weakest day has only ${worstDay} break${worstDay === 1 ? '' : 's'}` +
            (reserved > 0 ? ` and other campaigns already hold ${reserved} of them as guarantees` : '') +
            ` — at most ${Math.max(0, worstDay - reserved)} per day can be promised.`);
        } else {
          push('guarantee_interval', 'ok',
            `${draft.interval_plays_per_day}/day guaranteed; the interval's weakest day has ${worstDay} breaks${reserved > 0 ? ` (${reserved} already promised to others)` : ''}.`);
        }
      }
    }
  }

  // ── Show guarantee: worst airing binds (approximated per date) ────────────
  if (draft.show_id != null && draft.plays_per_show != null) {
    const perDate = new Map<string, number>();
    for (const o of occurrences) {
      if (o.showId === draft.show_id) perDate.set(o.date, (perDate.get(o.date) ?? 0) + 1);
    }
    if (perDate.size === 0) {
      push('guarantee_show', 'fail', 'The associated show has no scheduled airings with breaks in this period — the per-airing guarantee could never be met.');
    } else {
      const worstAiring = Math.min(...perDate.values());
      let reserved = 0;
      for (const c of others) {
        if (c.show_id === draft.show_id && c.plays_per_show != null) reserved += c.plays_per_show;
      }
      if (draft.plays_per_show + reserved > worstAiring) {
        push('guarantee_show', 'fail',
          `The guarantee asks for ${draft.plays_per_show} plays per airing, but the show's smallest airing has only ${worstAiring} break${worstAiring === 1 ? '' : 's'}` +
          (reserved > 0 ? ` and other campaigns already hold ${reserved}` : '') + '.');
      } else {
        push('guarantee_show', 'ok',
          `${draft.plays_per_show} plays per airing guaranteed; the smallest airing has ${worstAiring} breaks${reserved > 0 ? ` (${reserved} promised to others)` : ''}.`);
      }
    }
  }

  // ── First-in-slot: exactly one opener per break ───────────────────────────
  if (draft.first_in_slot) {
    let alwaysDemand = 0;
    for (const c of others) {
      if (!c.first_in_slot || c.first_in_slot_mode !== 'always') continue;
      const rem = Math.max(0, c.total_plays - (deliveredByCampaign.get(c.id) ?? 0));
      const cAllowed = normalizeIds(c.allowed_interval_ids) ?? stationDefaults;
      const cEligible = occurrences.filter((o) => occInAllowed(o, cAllowed, windows));
      if (cEligible.length === 0) continue;
      const shared = cEligible.filter((o) => eligibleKeys.has(occKey(o))).length;
      alwaysDemand += rem * (shared / cEligible.length);
    }
    if (draft.first_in_slot_mode === 'always') {
      const slotSupply = eligible.length - alwaysDemand;
      if (draftRemaining > slotSupply) {
        push('first_in_slot', 'fail',
          `"Every play opens the break" needs ${draftRemaining} opening positions, but only ${Math.max(0, Math.floor(slotSupply))} of the ${eligible.length} breaks are free of other every-play campaigns.`);
      } else {
        push('first_in_slot', 'ok',
          `${draftRemaining} opening positions needed, ${Math.floor(slotSupply)} available.`);
      }
    } else {
      // at_least_one: each day needs one free opener after the always crowd.
      const dates = new Set(eligible.map((o) => o.date));
      const perDay = eligible.length / Math.max(1, dates.size);
      const alwaysPerDay = alwaysDemand / Math.max(1, dates.size);
      if (alwaysPerDay >= perDay) {
        push('first_in_slot', 'warn',
          'Every-play campaigns are dense enough that a daily opening position is not always guaranteed to be free — the daily opener may occasionally be missed.');
      } else {
        push('first_in_slot', 'ok', 'A daily opening position is available alongside existing every-play campaigns.');
      }
    }
  }

  // ── Delivery pace: can the caps still deliver the remaining plays? ────────
  {
    const catchUp = draft.catch_up_factor
      ?? (await db.select({ f: stationSettingsTable.default_catch_up_factor })
            .from(stationSettingsTable).where(eq(stationSettingsTable.id, 1)))[0]?.f
      ?? 2;
    const totalDays = Math.max(1, Math.round(
      (new Date(`${draft.ends_on}T00:00:00`).getTime() - new Date(`${draft.starts_on}T00:00:00`).getTime()) / 86400000,
    ) + 1);
    const remainingDays = Math.max(1, Math.round(
      (periodEnd.getTime() - periodStart.getTime()) / 86400000,
    ) + 1);
    // Simulate the daily quota forward — each day delivers its quota, the
    // remainder shrinks, the quota recomputes (identical to the engine).
    let rem = draftRemaining;
    for (let d = 0; d < remainingDays && rem > 0; d++) {
      rem -= computeDailyQuota({
        totalPlays: draft.total_plays,
        delivered: draft.total_plays - rem,
        totalDays,
        remainingDays: remainingDays - d,
        catchUpFactor: catchUp,
        maxPlaysPerDay: draft.max_plays_per_day ?? null,
        pacingMode: draft.pacing_mode ?? 'even',
      });
    }
    const shortfall = Math.max(0, rem);
    if (shortfall > 0) {
      push('delivery_pace', 'fail',
        `Even at the catch-up limit, ${shortfall} of the remaining plays cannot be delivered by the end date — extend the campaign or settle the difference.`);
    } else {
      push('delivery_pace', 'ok', 'The remaining plays fit under the daily pacing caps by the end date.');
    }
  }

  const verdict = checks.some((c) => c.level === 'fail')
    ? 'refuse'
    : checks.some((c) => c.level === 'warn')
      ? 'warnings'
      : 'fit';
  return { verdict, checks };
}

// Bulk validation for the problem badges: every active, not-yet-ended
// campaign, revalidated against current supply (schedule edits invalidate
// the occurrence cache, so results are always current on read).
export async function validationSummary(): Promise<CampaignValidationSummaryRow[]> {
  const today = todayYmd();
  const rows = await db.select().from(campaignsTable).where(
    and(eq(campaignsTable.active, true), sql`${campaignsTable.ends_on} >= ${today}`),
  );
  const out: CampaignValidationSummaryRow[] = [];
  for (const c of rows) {
    const result = await validateCampaignDraft({
      id: c.id,
      starts_on: c.starts_on,
      ends_on: c.ends_on,
      total_plays: c.total_plays,
      duration_bracket: c.duration_bracket,
      allowed_interval_ids: normalizeIds(c.allowed_interval_ids),
      interval_id: c.interval_id,
      interval_plays_per_day: c.interval_plays_per_day,
      show_id: c.show_id,
      plays_per_show: c.plays_per_show,
      first_in_slot: c.first_in_slot,
      first_in_slot_mode: c.first_in_slot_mode,
      competing_exclusions: (c.competing_exclusions as number[]) ?? [],
    });
    const headline = result.checks.find((ch) => ch.level === 'fail')?.message
      ?? result.checks.find((ch) => ch.level === 'warn')?.message
      ?? null;
    out.push({ campaign_id: c.id, verdict: result.verdict, headline });
  }
  return out;
}
