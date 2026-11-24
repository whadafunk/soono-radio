// The station timezone — see docs/station-timezone-design.md.

export const DEFAULT_STATION_TIMEZONE = 'Europe/Bucharest';

// True only for a timezone NAME the runtime knows ("Europe/Bucharest",
// "UTC"). Numeric offsets are refused on purpose even though newer runtimes
// accept them as zones: Romania's offset changes twice a year, and only a
// zone name carries that.
export function isValidTimeZoneName(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  if (/^[+\-\d]/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
