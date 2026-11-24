// Applies the station timezone to this process.
//
// Every clock time in the schedule ("08:00") and every calendar day is read
// through the process's local time, so setting the process timezone is what
// makes them mean station time. The value comes from
// station_settings.timezone and nowhere else — a TZ already present in the
// environment is overridden, so there is exactly one source of truth.
// Node re-reads process.env.TZ when it is assigned, at startup or later.
// See docs/station-timezone-design.md.
import { DEFAULT_STATION_TIMEZONE, isValidTimeZoneName } from '@soono/shared';

// Sets the process timezone to `tz` when it is a valid zone name, otherwise
// to the default. Returns the zone now in force.
export function applyStationTimeZone(tz: string | null | undefined): string {
  const zone = tz != null && isValidTimeZoneName(tz) ? tz : DEFAULT_STATION_TIMEZONE;
  process.env.TZ = zone;
  return zone;
}
