process.env.TZ = 'Europe/Bucharest';

import { describe, expect, it } from 'vitest';
import {
  buildRecordingFiles,
  describeWindow,
  isSafeRecordingRef,
  parseRecordingFileName,
  utcFoldersForWindow,
} from './recordingIndex.js';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);
const raw = (name: string, sizeBytes: number, mtimeMs: number) => ({ day: name.slice(0, 10), name, sizeBytes, mtimeMs });

describe('parseRecordingFileName', () => {
  it('reads the UTC start', () => {
    expect(parseRecordingFileName('2026-11-24T23-00-00Z.mp3')).toBe(utc(2026, 11, 24, 23));
  });
  it.each(['.write-test', 'notes.txt', '2026-11-24T23-00-00Z.mp3.part', '2026-13-40T99-00-00Z.mp3', '../x.mp3'])
    ('ignores %j', (n) => expect(parseRecordingFileName(n)).toBeNull());
});

describe('isSafeRecordingRef', () => {
  it('accepts a recording in its own day folder', () => {
    expect(isSafeRecordingRef('2026-11-24', '2026-11-24T23-00-00Z.mp3')).toBe(true);
  });
  it.each([
    ['..', '2026-11-24T23-00-00Z.mp3'], ['2026-11-24', '../../data/radio.db'],
    ['2026-11-24/..', '2026-11-24T23-00-00Z.mp3'], ['2026-11-25', '2026-11-24T23-00-00Z.mp3'],
    ['/etc', 'passwd'], ['2026-11-24', '.write-test'],
  ])('refuses %j / %j', (d, n) => expect(isSafeRecordingRef(d, n)).toBe(false));
});

describe('utcFoldersForWindow', () => {
  it('a Bucharest day spans two UTC folders', () => {
    expect(utcFoldersForWindow(utc(2026, 11, 23, 22), utc(2026, 11, 24, 22))).toEqual(['2026-11-23', '2026-11-24']);
  });
  it('includes the folder of a file that started before the window', () => {
    expect(utcFoldersForWindow(utc(2026, 11, 24, 0, 30), utc(2026, 11, 24, 1))).toEqual(['2026-11-23', '2026-11-24']);
  });
});

describe('buildRecordingFiles', () => {
  const now = utc(2026, 11, 24, 15, 20);
  const files = buildRecordingFiles([
    raw('2026-11-24T14-00-00Z.mp3', 28_800_000, utc(2026, 11, 24, 15, 0, 3)),
    raw('2026-11-24T13-00-00Z.mp3', 28_800_000, utc(2026, 11, 24, 14, 0, 2)),
    raw('2026-11-24T15-00-00Z.mp3', 9_600_000, utc(2026, 11, 24, 15, 19, 55)),
    { day: '2026-11-24', name: '.write-test', sizeBytes: 0, mtimeMs: now },
  ], now);
  it('sorts, drops strays, and clamps each end to the next start', () => {
    expect(files.map((f) => f.name)).toEqual(['2026-11-24T13-00-00Z.mp3', '2026-11-24T14-00-00Z.mp3', '2026-11-24T15-00-00Z.mp3']);
    expect(files[0].endMs).toBe(utc(2026, 11, 24, 14));
    expect(files[2].endMs).toBe(utc(2026, 11, 24, 15, 19, 55));
  });
  it('marks only a file still being written as recording now', () => {
    expect(files.map((f) => f.recordingNow)).toEqual([false, false, true]);
    expect(buildRecordingFiles([raw('2026-11-24T15-00-00Z.mp3', 1, utc(2026, 11, 24, 15, 10))], now)[0].recordingNow).toBe(false);
  });
  it('returns nothing for an empty folder', () => expect(buildRecordingFiles([], now)).toEqual([]));
  it('treats any file written in the last minute as being written, even if a later-named file exists', () => {
    const out = buildRecordingFiles([
      raw('2026-11-24T15-00-00Z.mp3', 9_600_000, utc(2026, 11, 24, 15, 19, 55)),
      raw('2026-11-24T18-00-00Z.mp3', 10, utc(2026, 11, 24, 12)), // stray with a future name
    ], now);
    expect(out.map((f) => f.recordingNow)).toEqual([true, false]);
  });
});

describe('describeWindow', () => {
  const file = (h1: number, m1: number, h2: number, m2: number) => ({
    day: '2026-11-24', name: `2026-11-24T${String(h1).padStart(2, '0')}-${String(m1).padStart(2, '0')}-00Z.mp3`,
    startMs: utc(2026, 11, 24, h1, m1), endMs: utc(2026, 11, 24, h2, m2), sizeBytes: 1, recordingNow: false,
  });
  const window = [utc(2026, 11, 24, 13), utc(2026, 11, 24, 17)] as const;
  it('labels a gap that overlaps an off-air period', () => {
    const out = describeWindow([file(13, 0, 15, 20), file(16, 5, 17, 0)],
      [{ fromMs: utc(2026, 11, 24, 15, 20), toMs: utc(2026, 11, 24, 16, 5) }], ...window);
    expect(out.map((x) => x.kind === 'gap' ? x.label : 'file')).toEqual(['file', 'off_air', 'file']);
  });
  it('labels a short gap as an interruption and a long unexplained one as no recording', () => {
    const out = describeWindow([file(13, 0, 13, 59), file(14, 0, 15, 0), file(16, 0, 17, 0)], [], ...window);
    expect(out.map((x) => x.kind === 'gap' ? x.label : 'file')).toEqual(['file', 'interruption', 'file', 'no_recording', 'file']);
  });
  it('reports the whole window as one gap when there are no files', () => {
    expect(describeWindow([], [], ...window)).toEqual([{ kind: 'gap', startMs: window[0], endMs: window[1], label: 'no_recording' }]);
  });
  it('does not report the seconds since the last write as a gap while a file is being written', () => {
    const live = { ...file(16, 0, 16, 59), recordingNow: true };
    const out = describeWindow([file(13, 0, 16, 0), live], [], ...window);
    expect(out.map((x) => x.kind)).toEqual(['file', 'file']);
  });
  it('does not let a short off-air period hide hours of missing recording around it', () => {
    // recording stopped at 13:30; the operator went off air 15:00–15:05 to restart
    const out = describeWindow([file(13, 0, 13, 30), file(15, 5, 17, 0)],
      [{ fromMs: utc(2026, 11, 24, 15), toMs: utc(2026, 11, 24, 15, 5) }], ...window);
    expect(out.filter((x) => x.kind === 'gap')).toEqual([
      { kind: 'gap', startMs: utc(2026, 11, 24, 13, 30), endMs: utc(2026, 11, 24, 15), label: 'no_recording' },
      { kind: 'gap', startMs: utc(2026, 11, 24, 15), endMs: utc(2026, 11, 24, 15, 5), label: 'off_air' },
    ]);
  });
  it('splits a gap that starts before and ends after an off-air period into three', () => {
    const out = describeWindow([file(13, 0, 14, 0), file(16, 30, 17, 0)],
      [{ fromMs: utc(2026, 11, 24, 15), toMs: utc(2026, 11, 24, 15, 30) }], ...window);
    expect(out.map((x) => x.kind === 'gap' ? x.label : 'file')).toEqual(['file', 'no_recording', 'off_air', 'no_recording', 'file']);
  });
  it('treats an off-air period that has not ended as running to the window end', () => {
    const out = describeWindow([file(13, 0, 14, 0)], [{ fromMs: utc(2026, 11, 24, 14), toMs: null }], ...window);
    expect(out[1]).toEqual({ kind: 'gap', startMs: utc(2026, 11, 24, 14), endMs: window[1], label: 'off_air' });
  });
});
