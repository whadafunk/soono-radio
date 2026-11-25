process.env.TZ = 'Europe/Bucharest';

import { expect, it } from 'vitest';
import { buildListingCsv } from './archiveListing.js';
import { archiveEntryPaths } from './archiveNames.js';
import type { RecordingFile } from './recordingIndex.js';

const H = 3_600_000;
const utc = (h: number, mi = 0) => Date.UTC(2026, 10, 25, h, mi);
const file = (startMs: number, endMs: number): RecordingFile => {
  const iso = new Date(startMs).toISOString();
  return { day: iso.slice(0, 10), name: `${iso.slice(0, 19).replace(/:/g, '-')}Z.mp3`, startMs, endMs, sizeBytes: 1, recordingNow: false };
};
const csv = (files: RecordingFile[], included: RecordingFile[], flags = new Map()) =>
  buildListingCsv({
    files,
    included: new Set(included.map((f) => f.name)),
    offAir: [],
    flags,
    entryPaths: archiveEntryPaths(included),
  });
const rows = (text: string) => text.replace(/^﻿/, '').trimEnd().split('\r\n');

it('starts with the byte-order mark and the header', () => {
  const a = file(utc(8), utc(9));
  const text = csv([a], [a]);
  expect(text.startsWith('﻿start,end,length,type,file,included,flags,notes\r\n')).toBe(true);
});

it('lists included, not-included and gaps in time order', () => {
  const a = file(utc(8), utc(9));
  const b = file(utc(9), utc(10));
  const c = file(utc(10), utc(11));
  const d = file(utc(11, 10), utc(12));
  expect(rows(csv([a, b, c, d], [a, c, d])).slice(1)).toEqual([
    '2026-11-25 10:00:00,2026-11-25 11:00:00,1:00:00,recorded,2026-11-25/2026-11-25_10-00-00.mp3,yes,,',
    '2026-11-25 11:00:00,2026-11-25 12:00:00,1:00:00,recorded,2026-11-25_11-00-00.mp3,no,,',
    '2026-11-25 12:00:00,2026-11-25 13:00:00,1:00:00,recorded,2026-11-25/2026-11-25_12-00-00.mp3,yes,,',
    '2026-11-25 13:00:00,2026-11-25 13:10:00,0:10:00,no recording,,,,',
    '2026-11-25 13:10:00,2026-11-25 14:00:00,0:50:00,recorded,2026-11-25/2026-11-25_13-10-00.mp3,yes,,',
  ]);
});

it('the span starts and ends at the selection', () => {
  const before = file(utc(7), utc(8));
  const a = file(utc(8), utc(9));
  const after = file(utc(9), utc(10));
  expect(rows(csv([before, a, after], [a]))).toHaveLength(2);
});

it('labels off-air time inside the span', () => {
  const a = file(utc(8), utc(9));
  const b = file(utc(11), utc(12));
  const text = buildListingCsv({
    files: [a, b], included: new Set([a.name, b.name]),
    offAir: [{ fromMs: utc(9), toMs: utc(11) }], flags: new Map(), entryPaths: archiveEntryPaths([a, b]),
  });
  expect(rows(text)[2]).toBe('2026-11-25 11:00:00,2026-11-25 13:00:00,2:00:00,off air,,,,');
});

it('writes flags as labels and quotes a note with a comma and a quote', () => {
  const a = file(utc(8), utc(9));
  const flags = new Map([[a.name, [{ flag: 'protect' as const, note: 'said "live", twice' }, { flag: 'review' as const, note: '' }]]]);
  expect(rows(csv([a], [a], flags))[1].endsWith(',yes,Protect; Review,"said ""live"", twice"')).toBe(true);
});
