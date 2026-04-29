import { eq, gte } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { media, playHistory } from '../../db/schema.js';
import type { Media } from '../../db/schema.js';

const SEPARATION_MINUTES = 30;

export interface PickResult {
  media: Media;
  reason: string;
}

/**
 * Random pick from category='music' with separation. Excludes any track
 * whose play_history shows a play within the last 30 minutes. Returns
 * null when the library is empty or every track is blocked — caller
 * should log and try again on the next tick.
 *
 * Decoupled from the scheduler / telnet for testability — pure DB I/O.
 */
export async function pickNext(now: Date = new Date()): Promise<PickResult | null> {
  const cutoff = new Date(now.getTime() - SEPARATION_MINUTES * 60_000);

  const candidates = await db
    .select()
    .from(media)
    .where(eq(media.category, 'music'));
  if (candidates.length === 0) return null;

  const recent = await db
    .select({ media_id: playHistory.media_id })
    .from(playHistory)
    .where(gte(playHistory.started_at, cutoff));
  const blocked = new Set(
    recent.map((r) => r.media_id).filter((id): id is number => id !== null),
  );

  const eligible = candidates.filter((c) => !blocked.has(c.id));
  if (eligible.length === 0) return null;

  const choice = eligible[Math.floor(Math.random() * eligible.length)];
  return {
    media: choice,
    reason: `random pick category=music separation=${SEPARATION_MINUTES}min eligible=${eligible.length}/${candidates.length}`,
  };
}
