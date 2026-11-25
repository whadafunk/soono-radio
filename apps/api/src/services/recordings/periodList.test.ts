process.env.TZ = 'Europe/Bucharest';

import { expect, it } from 'vitest';
import { dayItems, summariseDay } from './periodList.js';
import type { RecordingFile } from './recordingIndex.js';

const H = 3_600_000;
const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const file = (startMs: number, endMs: number, sizeBytes = 100): RecordingFile => {
  const iso = new Date(startMs).toISOString();
  return { day: iso.slice(0, 10), name: `${iso.slice(0, 19).replace(/:/g, '-')}Z.mp3`, startMs, endMs, sizeBytes, recordingNow: false };
};

it('a recording crossing midnight is listed only on the day it starts', () => {
  // Station midnight between 24 and 25 November is 22:00Z on the 24th.
  const crossing = file(utc(2026, 11, 24, 21, 30), utc(2026, 11, 24, 22, 30));
  const next = file(utc(2026, 11, 24, 22, 30), utc(2026, 11, 24, 23));
  const the24th = dayItems([crossing, next], [], utc(2026, 11, 23, 22), utc(2026, 11, 24, 22));
  const the25th = dayItems([crossing, next], [], utc(2026, 11, 24, 22), utc(2026, 11, 24, 23));
  expect(the24th.filter((i) => i.kind === 'file').map((i) => i.startMs)).toEqual([crossing.startMs]);
  // On the 25th it is neither listed again nor shown as missing time.
  expect(the25th).toEqual([{ kind: 'file', ...next }]);
});

it('summarises a day', () => {
  const start = utc(2026, 11, 24, 22);
  const a = file(start, start + H, 100);
  const b = file(start + H, start + 2 * H, 200);
  const items = dayItems(
    [a, b, file(start + 5 * H + 600_000, start + 6 * H, 0)],
    [{ fromMs: start + 2 * H, toMs: start + 5 * H }],
    start, start + 5 * H + 600_000,
  );
  expect(summariseDay(items)).toEqual({ recordedMs: 2 * H, noRecordingMs: 600_000, sizeBytes: 300 });
});

it('a 25-hour day sums to 25 hours', () => {
  // 25 October 2026 in Bucharest: 21:00Z on the 24th to 22:00Z on the 25th.
  const start = utc(2026, 10, 24, 21);
  const files = Array.from({ length: 25 }, (_, i) => file(start + i * H, start + (i + 1) * H));
  const items = dayItems(files, [], start, start + 25 * H);
  expect(items).toHaveLength(25);
  expect(summariseDay(items).recordedMs).toBe(25 * H);
});
