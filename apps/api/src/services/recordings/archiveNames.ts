// Names recordings get when they leave the app — station time, so a file can
// be identified without the app (docs/reports-recordings-list-design.md).
// On disk they keep their UTC names. "Local" is the station timezone (the
// process runs in it); pure, unit-tested in archiveNames.test.ts.

const p2 = (n: number): string => String(n).padStart(2, '0');

function stationDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function stationStem(ms: number): string {
  const d = new Date(ms);
  return `${stationDay(ms)}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
}

// "+0200": the station's offset from UTC at that moment.
function utcOffset(ms: number): string {
  const minutes = -new Date(ms).getTimezoneOffset();
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${p2(Math.floor(abs / 60))}${p2(abs % 60)}`;
}

// 2026-11-25_10-00-00.mp3
export function stationFileName(startMs: number): string {
  return `${stationStem(startMs)}.mp3`;
}

// File name on disk → path inside an archive, one folder per station day.
// The hour that repeats when the clocks go back gives two recordings the same
// station time; both then carry their UTC offset so neither overwrites the
// other and it is plain which came first.
export function archiveEntryPaths(files: Array<{ name: string; startMs: number }>): Map<string, string> {
  const stemCount = new Map<string, number>();
  for (const f of files) {
    const stem = stationStem(f.startMs);
    stemCount.set(stem, (stemCount.get(stem) ?? 0) + 1);
  }
  const paths = new Map<string, string>();
  for (const f of files) {
    const stem = stationStem(f.startMs);
    const suffix = (stemCount.get(stem) ?? 0) > 1 ? utcOffset(f.startMs) : '';
    paths.set(f.name, `${stationDay(f.startMs)}/${stem}${suffix}.mp3`);
  }
  return paths;
}

// soono-recordings_2026-11-25_to_2026-12-01.zip
export function archiveFileName(firstStartMs: number, lastStartMs: number): string {
  return `soono-recordings_${stationDay(firstStartMs)}_to_${stationDay(lastStartMs)}.zip`;
}
