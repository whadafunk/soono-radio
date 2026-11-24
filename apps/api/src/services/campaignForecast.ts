// Day-by-day delivery forecast for one campaign: simulates the daily quota
// forward from a starting date — each day delivers its quota, the remainder
// shrinks, the quota recomputes (identical to the engine's own pacing).
//
// Dependency-free so it can be tested under a fixed timezone. Dates are
// stepped as calendar dates (addDaysYmd), never as "start + N × 24 hours":
// that drifts by an hour across a clock change and repeated 31 October while
// skipping a day further on.
import { addDaysYmd, computeDailyQuota, type PacingMode } from '@soono/shared';

const FORECAST_MAX_DAYS = 120;

export interface CampaignForecastInput {
  totalPlays: number;
  delivered: number;
  totalDays: number;
  // First forecast day (today, or the campaign's start if that is later).
  fromYmd: string;
  // Inclusive, fromYmd..campaign end.
  remainingDays: number;
  catchUpFactor: number;
  maxPlaysPerDay: number | null;
  pacingMode: PacingMode;
}

export function buildCampaignForecast(input: CampaignForecastInput): {
  forecast: Array<{ date: string; planned: number }>;
  quotaToday: number;
  // Plays still undelivered after the last forecast day.
  shortfall: number;
} {
  const forecast: Array<{ date: string; planned: number }> = [];
  let remaining = Math.max(0, input.totalPlays - input.delivered);
  let quotaToday = 0;
  for (let d = 0; d < input.remainingDays; d++) {
    const quota = computeDailyQuota({
      totalPlays: input.totalPlays,
      delivered: input.totalPlays - remaining,
      totalDays: input.totalDays,
      remainingDays: input.remainingDays - d,
      catchUpFactor: input.catchUpFactor,
      maxPlaysPerDay: input.maxPlaysPerDay,
      pacingMode: input.pacingMode,
    });
    const planned = Math.min(quota, remaining);
    if (d === 0) quotaToday = quota;
    if (forecast.length < FORECAST_MAX_DAYS) forecast.push({ date: addDaysYmd(input.fromYmd, d), planned });
    remaining -= planned;
  }
  return { forecast, quotaToday, shortfall: remaining };
}
