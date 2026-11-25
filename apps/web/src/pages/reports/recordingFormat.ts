// Formatting shared by the Recordings tab's parts. Times are shown in the
// browser's timezone, which is the station's (docs/station-timezone-design.md).

export const formatTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes > 0) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return '0 MB';
}

// "23 h 53 m", "7 m", "0 m"
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} m`;
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}

// "Tue 25 Nov 2026" from a station date.
export function formatDay(date: string): string {
  const [y, m, d] = date.split('-').map((s) => parseInt(s, 10));
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

export const recordingKey = (file: { day: string; name: string }): string => `${file.day}/${file.name}`;

export const inputClass = 'bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200';
export const buttonClass = 'inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white rounded text-sm disabled:opacity-40';
