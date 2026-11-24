process.env.TZ = 'Europe/Bucharest';

import { describe, expect, it } from 'vitest';
import { buildCampaignForecast } from './campaignForecast.js';

const base = {
  totalPlays: 40,
  delivered: 0,
  totalDays: 4,
  catchUpFactor: 2,
  maxPlaysPerDay: null,
  pacingMode: 'even' as const,
};

describe('buildCampaignForecast', () => {
  it('lists consecutive calendar days across the October clock change (25-hour day)', () => {
    const { forecast } = buildCampaignForecast({ ...base, fromYmd: '2027-10-30', remainingDays: 4 });
    expect(forecast.map((f) => f.date)).toEqual(['2027-10-30', '2027-10-31', '2027-11-01', '2027-11-02']);
  });
  it('lists consecutive calendar days across the March clock change (23-hour day)', () => {
    const { forecast } = buildCampaignForecast({ ...base, fromYmd: '2027-03-27', remainingDays: 4 });
    expect(forecast.map((f) => f.date)).toEqual(['2027-03-27', '2027-03-28', '2027-03-29', '2027-03-30']);
  });
  it('plans every remaining play and reports the first day as today\'s quota', () => {
    const { forecast, quotaToday } = buildCampaignForecast({ ...base, fromYmd: '2026-11-25', remainingDays: 4 });
    expect(forecast.reduce((s, f) => s + f.planned, 0)).toBe(40);
    expect(quotaToday).toBe(forecast[0].planned);
  });
  it('caps the list at 120 days but still simulates the rest', () => {
    const { forecast } = buildCampaignForecast({ ...base, totalPlays: 400, totalDays: 200, fromYmd: '2026-11-25', remainingDays: 200 });
    expect(forecast).toHaveLength(120);
  });
  it('returns an empty forecast and the whole remainder as shortfall when no days remain', () => {
    expect(buildCampaignForecast({ ...base, fromYmd: '2026-11-25', remainingDays: 0 }))
      .toEqual({ forecast: [], quotaToday: 0, shortfall: 40 });
  });
  it('reports no shortfall when every play fits', () => {
    expect(buildCampaignForecast({ ...base, fromYmd: '2026-11-25', remainingDays: 4 }).shortfall).toBe(0);
  });
  it('reports the plays a daily cap leaves undelivered as shortfall', () => {
    const r = buildCampaignForecast({ ...base, maxPlaysPerDay: 5, fromYmd: '2026-11-25', remainingDays: 4 });
    expect(r.forecast.map((f) => f.planned)).toEqual([5, 5, 5, 5]);
    expect(r.shortfall).toBe(20);
  });
});
