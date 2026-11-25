process.env.TZ = 'Europe/Bucharest';

// The filter rules live in @soono/shared because the page runs them in the
// browser; they are tested here because this package has the test runner.
import { expect, it } from 'vitest';
import { filterPeriodDays, type RecordingFilter, type RecordingFlagEntry, type RecordingListItem, type RecordingPeriodDay } from '@soono/shared';

const H = 3_600_000;
const all: RecordingFilter = { hourFrom: null, hourTo: null, weekdays: [], flag: 'any', noRecordingOnly: false };
// Station wall-clock time on a date → ms.
const at = (date: string, h: number, mi = 0) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, h, mi).getTime();
};
const rec = (startMs: number, endMs: number, flags: RecordingFlagEntry[] = []): RecordingListItem => {
  const iso = new Date(startMs).toISOString();
  return { kind: 'file', day: iso.slice(0, 10), name: `${iso.slice(0, 19).replace(/:/g, '-')}Z.mp3`, start_ms: startMs, end_ms: endMs, size_bytes: 10, recording_now: false, flags };
};
const gap = (startMs: number, endMs: number, label: 'off_air' | 'interruption' | 'no_recording'): RecordingListItem =>
  ({ kind: 'gap', start_ms: startMs, end_ms: endMs, label });
const day = (date: string, items: RecordingListItem[]): RecordingPeriodDay =>
  ({ date, recorded_ms: 111, no_recording_ms: 222, size_bytes: 333, items });
const starts = (days: RecordingPeriodDay[]) => days.flatMap((d) => d.items.map((i) => i.start_ms));

it('drops days whose weekday is not chosen', () => {
  const mon = day('2026-11-23', [rec(at('2026-11-23', 10), at('2026-11-23', 11))]);
  const sat = day('2026-11-28', [rec(at('2026-11-28', 10), at('2026-11-28', 11))]);
  expect(filterPeriodDays([sat, mon], { ...all, weekdays: [1, 2, 3, 4, 5] }).map((d) => d.date)).toEqual(['2026-11-23']);
});

it('keeps items overlapping the hours', () => {
  const d = '2026-11-24';
  const out = filterPeriodDays([day(d, [
    rec(at(d, 5), at(d, 6)),
    rec(at(d, 6), at(d, 7)),
    gap(at(d, 7, 30), at(d, 9), 'off_air'),
    rec(at(d, 9), at(d, 10)),
  ])], { ...all, hourFrom: 6, hourTo: 8 });
  expect(starts(out)).toEqual([at(d, 6), at(d, 7, 30)]);
});

it('hours on the autumn clock-change day are wall-clock hours', () => {
  // 03:00 happens twice on 25 October 2026; 04:00 station time is 02:00Z.
  const z = (h: number) => Date.UTC(2026, 9, 25, h);
  const d = day('2026-10-25', [0, 1, 2, 3].map((h) => rec(z(h), z(h + 1))));
  expect(starts(filterPeriodDays([d], { ...all, hourFrom: 4, hourTo: 5 }))).toEqual([z(2)]);
});

it('ignores hours that are not a forward range', () => {
  const d = '2026-11-24';
  const one = day(d, [rec(at(d, 5), at(d, 6))]);
  expect(starts(filterPeriodDays([one], { ...all, hourFrom: 8, hourTo: 8 }))).toEqual([at(d, 5)]);
  expect(starts(filterPeriodDays([one], { ...all, hourFrom: 8, hourTo: null }))).toEqual([at(d, 5)]);
});

it('a flag filter keeps no-recording rows and hides off-air rows', () => {
  const d = '2026-11-24';
  const out = filterPeriodDays([day(d, [
    rec(at(d, 1), at(d, 2), [{ flag: 'review', note: '' }]),
    rec(at(d, 2), at(d, 3)),
    gap(at(d, 3), at(d, 4), 'off_air'),
    gap(at(d, 4), at(d, 4, 1), 'interruption'),
    gap(at(d, 5), at(d, 6), 'no_recording'),
  ])], { ...all, flag: 'review' });
  expect(starts(out)).toEqual([at(d, 1), at(d, 5)]);
});

it('unflagged keeps only recordings without flags', () => {
  const d = '2026-11-24';
  const out = filterPeriodDays([day(d, [
    rec(at(d, 1), at(d, 2), [{ flag: 'protect', note: 'x' }]),
    rec(at(d, 2), at(d, 3)),
  ])], { ...all, flag: 'unflagged' });
  expect(starts(out)).toEqual([at(d, 2)]);
});

it('noRecordingOnly keeps only no-recording rows and drops days without any', () => {
  const a = '2026-11-24';
  const b = '2026-11-25';
  const out = filterPeriodDays([
    day(b, [rec(at(b, 1), at(b, 2)), gap(at(b, 2), at(b, 3), 'off_air')]),
    day(a, [rec(at(a, 1), at(a, 2)), gap(at(a, 2), at(a, 3), 'no_recording')]),
  ], { ...all, noRecordingOnly: true });
  expect(out.map((d) => d.date)).toEqual([a]);
  expect(starts(out)).toEqual([at(a, 2)]);
});

it('filtering never changes a day\'s totals', () => {
  const d = '2026-11-24';
  const [out] = filterPeriodDays([day(d, [rec(at(d, 1), at(d, 2)), rec(at(d, 9), at(d, 10))])], { ...all, hourFrom: 0, hourTo: 5 });
  expect(out).toMatchObject({ recorded_ms: 111, no_recording_ms: 222, size_bytes: 333 });
  expect(out.items).toHaveLength(1);
});
