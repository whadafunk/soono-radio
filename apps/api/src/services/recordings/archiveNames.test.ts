process.env.TZ = 'Europe/Bucharest';

import { expect, it } from 'vitest';
import { archiveEntryPaths, archiveFileName, stationFileName } from './archiveNames.js';

const utc = (y: number, mo: number, d: number, h = 0) => Date.UTC(y, mo - 1, d, h);
const f = (startMs: number) => ({ name: `${new Date(startMs).toISOString().slice(0, 19).replace(/:/g, '-')}Z.mp3`, startMs });

it('names a recording in station time', () => {
  expect(stationFileName(utc(2026, 11, 25, 8))).toBe('2026-11-25_10-00-00.mp3');
});

it('puts a recording in its station day\'s folder', () => {
  const late = f(utc(2026, 11, 24, 22));
  expect(archiveEntryPaths([late]).get(late.name)).toBe('2026-11-25/2026-11-25_00-00-00.mp3');
});

it('the repeated autumn hour gets two different names', () => {
  const first = f(utc(2026, 10, 25, 0));
  const second = f(utc(2026, 10, 25, 1));
  const other = f(utc(2026, 10, 25, 2));
  const paths = archiveEntryPaths([first, second, other]);
  expect(paths.get(first.name)).toBe('2026-10-25/2026-10-25_03-00-00+0300.mp3');
  expect(paths.get(second.name)).toBe('2026-10-25/2026-10-25_03-00-00+0200.mp3');
  expect(paths.get(other.name)).toBe('2026-10-25/2026-10-25_04-00-00.mp3');
});

it('names the archive after its first and last station day', () => {
  expect(archiveFileName(utc(2026, 11, 24, 22), utc(2026, 12, 1, 10))).toBe('soono-recordings_2026-11-25_to_2026-12-01.zip');
});
