import { expect, it } from 'vitest';
import { MAX_RANGE_MS, planRange } from './rangePlan.js';

const utc = (h: number, m = 0, s = 0) => Date.UTC(2026, 10, 24, h, m, s);
const file = (h1: number, m1: number, h2: number, m2: number) => ({
  day: '2026-11-24', name: `2026-11-24T${String(h1).padStart(2, '0')}-${String(m1).padStart(2, '0')}-00Z.mp3`,
  startMs: utc(h1, m1), endMs: utc(h2, m2), sizeBytes: 1, recordingNow: false,
});
const hours = [file(13, 0, 14, 0), file(14, 0, 15, 0), file(15, 0, 16, 0)];

it('trims the first and last file to the requested range', () => {
  const r = planRange(hours, utc(13, 30), utc(15, 15));
  expect(r).toEqual({
    parts: [
      { day: '2026-11-24', name: '2026-11-24T13-00-00Z.mp3', skipMs: 1_800_000, takeMs: 1_800_000 },
      { day: '2026-11-24', name: '2026-11-24T14-00-00Z.mp3', skipMs: 0, takeMs: 3_600_000 },
      { day: '2026-11-24', name: '2026-11-24T15-00-00Z.mp3', skipMs: 0, takeMs: 900_000 },
    ],
    gaps: [], coveredMs: 6_300_000,
  });
});
it('reports the gaps inside the range instead of hiding them', () => {
  const r = planRange([file(13, 0, 13, 40), file(14, 25, 15, 0)], utc(13), utc(15));
  expect('gaps' in r && r.gaps).toEqual([{ startMs: utc(13, 40), endMs: utc(14, 25) }]);
  expect('coveredMs' in r && r.coveredMs).toBe(75 * 60_000);
});
it('reports a missing start and a missing end as gaps too', () => {
  const r = planRange([file(14, 0, 15, 0)], utc(13), utc(16));
  expect('gaps' in r && r.gaps).toEqual([{ startMs: utc(13), endMs: utc(14) }, { startMs: utc(15), endMs: utc(16) }]);
});
it('takes a file that is still being written up to what exists', () => {
  const r = planRange([{ ...file(15, 0, 15, 20), recordingNow: true }], utc(15), utc(16));
  expect('parts' in r && r.parts).toEqual([{ day: '2026-11-24', name: '2026-11-24T15-00-00Z.mp3', skipMs: 0, takeMs: 1_200_000 }]);
});
it.each([[utc(15), utc(15)], [utc(16), utc(15)]])('refuses an empty or backwards range', (a, b) => {
  expect(planRange(hours, a, b)).toEqual({ error: 'invalid_range' });
});
it('refuses more than 24 hours', () => {
  expect(planRange(hours, utc(0), utc(0) + MAX_RANGE_MS + 1)).toEqual({ error: 'too_long' });
});
it('says so when nothing was recorded in the range', () => {
  expect(planRange(hours, utc(18), utc(19))).toEqual({ error: 'nothing_recorded' });
});
