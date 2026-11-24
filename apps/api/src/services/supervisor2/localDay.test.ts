process.env.TZ = 'Europe/Bucharest';

import { describe, expect, it } from 'vitest';
import {
  addLocalDaysMs,
  daysInclusive,
  isoDateString,
  isoDayOfWeek,
  localMidnightMs,
  localTimeOnDayMs,
  parseLocalYmd,
  startedDaysBetween,
  startOfIsoWeekMs,
  windowOnDay,
} from './localDay.js';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

describe('ordinary day (EET, UTC+2)', () => {
  it('finds local midnight', () => {
    expect(localMidnightMs(utc(2026, 11, 25, 10))).toBe(utc(2026, 11, 24, 22));
  });
  it('reads the local date and weekday either side of midnight', () => {
    expect(isoDateString(new Date(utc(2026, 11, 24, 21, 30)))).toBe('2026-11-24');
    expect(isoDayOfWeek(new Date(utc(2026, 11, 24, 21, 30)))).toBe(2);
    expect(isoDateString(new Date(utc(2026, 11, 24, 22, 30)))).toBe('2026-11-25');
    expect(isoDayOfWeek(new Date(utc(2026, 11, 24, 22, 30)))).toBe(3);
  });
  it('places a slot at wall-clock time', () => {
    expect(windowOnDay(utc(2026, 11, 24, 22), '08:00', '09:00'))
      .toEqual({ startMs: utc(2026, 11, 25, 6), endMs: utc(2026, 11, 25, 7) });
  });
  it('treats an end at or before the start as end of day', () => {
    expect(windowOnDay(utc(2026, 11, 24, 22), '22:00', '00:00'))
      .toEqual({ startMs: utc(2026, 11, 25, 20), endMs: utc(2026, 11, 25, 22) });
  });
});

describe('clocks go forward — Sunday 2027-03-28, 03:00 becomes 04:00', () => {
  const midnight = utc(2027, 3, 27, 22);
  it('keeps slots after the change at wall-clock time', () => {
    expect(windowOnDay(midnight, '08:00', '09:00'))
      .toEqual({ startMs: utc(2027, 3, 28, 5), endMs: utc(2027, 3, 28, 6) });
  });
  it('gives a 23-hour day', () => {
    expect(addLocalDaysMs(midnight, 1)).toBe(utc(2027, 3, 28, 21));
    expect(addLocalDaysMs(midnight, -1)).toBe(utc(2027, 3, 26, 22));
    expect(windowOnDay(midnight, '22:00', '00:00').endMs).toBe(utc(2027, 3, 28, 21));
  });
  it('makes a slot inside the skipped hour empty, not negative', () => {
    const w = windowOnDay(midnight, '03:00', '04:00');
    expect(w.startMs).toBe(utc(2027, 3, 28, 1));
    expect(w.endMs).toBe(utc(2027, 3, 28, 1));
  });
});

describe('clocks go back — Sunday 2027-10-31, 04:00 becomes 03:00', () => {
  const midnight = utc(2027, 10, 30, 21);
  it('keeps slots after the change at wall-clock time', () => {
    expect(windowOnDay(midnight, '08:00', '09:00').startMs).toBe(utc(2027, 10, 31, 6));
    expect(localTimeOnDayMs(midnight, 5 * 60)).toBe(utc(2027, 10, 31, 3));
  });
  it('gives a 25-hour day', () => {
    expect(addLocalDaysMs(midnight, 1)).toBe(utc(2027, 10, 31, 22));
  });
  it('stretches the repeated hour', () => {
    expect(localTimeOnDayMs(midnight, 4 * 60) - localTimeOnDayMs(midnight, 3 * 60)).toBe(2 * 3_600_000);
  });
});

describe('campaign day and week boundaries', () => {
  it('starts the week at local Monday midnight', () => {
    // Wed 25 Nov 2026, 00:30 local
    expect(startOfIsoWeekMs(utc(2026, 11, 24, 22, 30))).toBe(utc(2026, 11, 22, 22));
    // Sunday of the March change still belongs to the week that began Mon 22 Mar
    expect(startOfIsoWeekMs(utc(2027, 3, 28, 12))).toBe(utc(2027, 3, 21, 22));
    // Monday after the October change starts its own week at EET midnight
    expect(startOfIsoWeekMs(utc(2027, 11, 1, 12))).toBe(utc(2027, 10, 31, 22));
  });
  it('counts campaign days inclusively across both clock changes', () => {
    expect(daysInclusive('2026-11-25', '2026-11-25')).toBe(1);
    expect(daysInclusive('2027-03-22', '2027-03-28')).toBe(7);
    expect(daysInclusive('2027-10-25', '2027-11-01')).toBe(8);
  });
});

describe('parseLocalYmd', () => {
  it('reads a date string as local midnight, not UTC midnight', () => {
    expect(parseLocalYmd('2026-11-25').getTime()).toBe(utc(2026, 11, 24, 22));
    expect(parseLocalYmd('2027-10-30').getTime()).toBe(utc(2027, 10, 29, 21)); // summer time
  });
});

describe('startedDaysBetween', () => {
  it('counts whole days between two midnights', () => {
    expect(startedDaysBetween(parseLocalYmd('2026-11-25'), parseLocalYmd('2026-12-02'))).toBe(7);
  });
  it('does not gain a day across the October clock change', () => {
    // campaign 25 Oct – 1 Nov 2027, end made exclusive (2 Nov): 8 days
    expect(startedDaysBetween(parseLocalYmd('2027-10-25'), parseLocalYmd('2027-11-02'))).toBe(8);
  });
  it('does not lose a day across the March clock change', () => {
    expect(startedDaysBetween(parseLocalYmd('2027-03-22'), parseLocalYmd('2027-03-29'))).toBe(7);
  });
  it('counts a started day as a day', () => {
    expect(startedDaysBetween(new Date(2026, 10, 25, 15, 0), parseLocalYmd('2026-11-28'))).toBe(3);
    expect(startedDaysBetween(parseLocalYmd('2026-11-25'), new Date(2026, 10, 27, 15, 0))).toBe(3);
  });
  it('is zero for the same instant and never negative', () => {
    expect(startedDaysBetween(parseLocalYmd('2026-11-25'), parseLocalYmd('2026-11-25'))).toBe(0);
    expect(startedDaysBetween(parseLocalYmd('2026-11-26'), parseLocalYmd('2026-11-25'))).toBe(0);
  });
});
