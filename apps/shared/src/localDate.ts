// Calendar-date helpers shared by the API and the web app.
//
// A calendar date is never taken from toISOString(): that is the UTC date,
// which is the previous day for the first two or three hours after local
// midnight in Romania. See docs/station-timezone-design.md.

// The local calendar date of `d` (default: now) as YYYY-MM-DD. "Local" is the
// station timezone in the API process and the browser's timezone in the web
// app (the same place, by the operator's choice).
export function localYmd(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// `ymd` shifted by `days` calendar days. Pure date arithmetic: the result
// does not depend on the timezone the code runs in.
export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map((s) => parseInt(s, 10));
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
