process.env.TZ = 'Europe/Bucharest';

import { describe, expect, it } from 'vitest';
import { addDaysYmd, localYmd } from '@soono/shared';

describe('local calendar dates', () => {
  it('localYmd is the local date, not the UTC date, just after local midnight', () => {
    // 00:30 on 26 Nov in Bucharest is still 25 Nov in UTC
    expect(localYmd(new Date(Date.UTC(2026, 10, 25, 22, 30)))).toBe('2026-11-26');
  });
  it('addDaysYmd steps calendar days across month, year and clock-change boundaries', () => {
    expect(addDaysYmd('2026-11-25', 7)).toBe('2026-12-02');
    expect(addDaysYmd('2026-12-29', 7)).toBe('2027-01-05');
    expect(addDaysYmd('2027-03-27', 2)).toBe('2027-03-29');
    expect(addDaysYmd('2027-10-30', 2)).toBe('2027-11-01');
    expect(addDaysYmd('2026-11-25', -25)).toBe('2026-10-31');
  });
});
