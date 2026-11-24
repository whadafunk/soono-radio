import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchStationSettings } from '../api';

// The current time in the station's timezone — the zone every scheduled
// clock time is read in (Settings → Scheduling), which is not necessarily the
// timezone of the browser showing this page.
export function StationClock() {
  const { data } = useQuery({ queryKey: ['station-settings'], queryFn: fetchStationSettings });
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!data) return null;

  const time = new Intl.DateTimeFormat(undefined, {
    timeZone: data.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);

  return (
    <span className="text-sm text-zinc-300 tabular-nums">
      {time} <span className="text-zinc-400">· {data.timezone}</span>
    </span>
  );
}
