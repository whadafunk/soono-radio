// History of the On Air / Off Air switch. The switch itself only keeps a
// current flag (supervisor_state.paused); the Recordings page needs to know
// WHEN the station was off, to tell an expected gap ("off air") from a
// recording that went missing.
import { asc, desc, lt, and, gte, lte } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { stationAirEvents } from '../../db/schema.js';

export async function recordAirEvent(state: 'off_air' | 'on_air', atMs: number, db: typeof defaultDb = defaultDb): Promise<void> {
  await db.insert(stationAirEvents).values({ at_ms: atMs, state });
}

// Off-air periods overlapping [fromMs, toMs]. A period still open has
// toMs: null. A period that began before fromMs and had not ended by then is
// included.
export async function offAirPeriods(
  fromMs: number,
  toMs: number,
  db: typeof defaultDb = defaultDb,
): Promise<Array<{ fromMs: number; toMs: number | null }>> {
  const [before] = await db
    .select()
    .from(stationAirEvents)
    .where(lt(stationAirEvents.at_ms, fromMs))
    .orderBy(desc(stationAirEvents.at_ms), desc(stationAirEvents.id))
    .limit(1);
  const within = await db
    .select()
    .from(stationAirEvents)
    .where(and(gte(stationAirEvents.at_ms, fromMs), lte(stationAirEvents.at_ms, toMs)))
    .orderBy(asc(stationAirEvents.at_ms), asc(stationAirEvents.id));

  const periods: Array<{ fromMs: number; toMs: number | null }> = [];
  let openSince: number | null = before?.state === 'off_air' ? before.at_ms : null;
  for (const event of within) {
    if (event.state === 'off_air') {
      if (openSince == null) openSince = event.at_ms;
    } else if (openSince != null) {
      periods.push({ fromMs: openSince, toMs: event.at_ms });
      openSince = null;
    }
  }
  if (openSince != null) periods.push({ fromMs: openSince, toMs: null });
  return periods;
}

// Makes the history agree with the current flag at API start. Without it, a
// station that was already off air when this table was introduced (or whose
// switch was flipped while the API was down) would show its off-air time as
// "no recording".
export async function syncAirEventsWithState(paused: boolean, nowMs: number, db: typeof defaultDb = defaultDb): Promise<void> {
  const [last] = await db
    .select()
    .from(stationAirEvents)
    .orderBy(desc(stationAirEvents.at_ms), desc(stationAirEvents.id))
    .limit(1);
  const wanted = paused ? 'off_air' : 'on_air';
  // No history yet and on air: nothing to say — "on air" is the default.
  if (!last && !paused) return;
  if (last?.state !== wanted) await recordAirEvent(wanted, nowMs, db);
}
