import { describe, expect, it } from 'vitest';
import { isValidTimeZoneName } from '@soono/shared';
import { applyStationTimeZone } from './stationTimeZone.js';

describe('isValidTimeZoneName', () => {
  it.each(['Europe/Bucharest', 'UTC', 'America/Argentina/Buenos_Aires'])('accepts %s', (tz) => {
    expect(isValidTimeZoneName(tz)).toBe(true);
  });
  it.each(['', 'Bucharest', '+02:00', '-0300', '2', 'Europe/Nowhere'])('rejects %j', (tz) => {
    expect(isValidTimeZoneName(tz)).toBe(false);
  });
});

describe('applyStationTimeZone', () => {
  it('applies a valid zone and the process clock follows', () => {
    expect(applyStationTimeZone('Europe/Bucharest')).toBe('Europe/Bucharest');
    expect(new Date(Date.UTC(2026, 10, 25, 10)).getHours()).toBe(12);
    expect(new Date(Date.UTC(2026, 6, 1, 10)).getHours()).toBe(13); // summer time
  });
  it('overrides a zone already present in the environment', () => {
    process.env.TZ = 'America/New_York';
    expect(applyStationTimeZone('Europe/Bucharest')).toBe('Europe/Bucharest');
    expect(process.env.TZ).toBe('Europe/Bucharest');
  });
  it.each([null, undefined, '', '+02:00', 'Nope/Nope'])('falls back to the default for %j', (tz) => {
    process.env.TZ = 'UTC';
    expect(applyStationTimeZone(tz)).toBe('Europe/Bucharest');
    expect(process.env.TZ).toBe('Europe/Bucharest');
  });
});
