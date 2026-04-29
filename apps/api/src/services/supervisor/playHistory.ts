import { eq, desc, and, isNull, lt } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { playHistory, media as mediaTable } from '../../db/schema.js';
import type { PlaySource } from '../../db/schema.js';

/**
 * Insert a fresh play_history row at push time. Returns the new id so
 * the scheduler can attach it as an annotation when calling
 * request.queue.push, letting the metadata watcher correlate the
 * row back to the actual airing event.
 */
export async function recordPushed(args: {
  mediaId: number | null;
  source: PlaySource;
  pickReason: string | null;
}): Promise<number> {
  const result = await db
    .insert(playHistory)
    .values({
      media_id: args.mediaId,
      source: args.source,
      pick_reason: args.pickReason,
    })
    .returning({ id: playHistory.id });
  return result[0].id;
}

/**
 * Mark a play_history row as having actually started airing — bumps
 * started_at from the push time to the real play-start time. Optionally
 * stamps the live listener count seen at that moment.
 */
export async function recordStarted(args: {
  id: number;
  startedAt: Date;
  liveListenerCount: number | null;
}): Promise<void> {
  await db
    .update(playHistory)
    .set({
      started_at: args.startedAt,
      live_listener_count: args.liveListenerCount,
    })
    .where(eq(playHistory.id, args.id));
}

/**
 * Close out a row when the next track takes over. Aborted=true means the
 * track was cut short (live takeover, skip, error) — computed by
 * comparing actual airtime to the track's expected duration.
 */
export async function recordEnded(args: {
  id: number;
  endedAt: Date;
  aborted: boolean;
}): Promise<void> {
  await db
    .update(playHistory)
    .set({
      ended_at: args.endedAt,
      aborted: args.aborted,
    })
    .where(eq(playHistory.id, args.id));
}

/**
 * Find any open play_history rows older than `cutoff` and close them.
 * Used on Supervisor boot to recover from crashes — anything left open
 * is presumed to have ended at the cutoff time.
 */
export async function closeStaleOpenRows(cutoff: Date): Promise<number> {
  const result = await db
    .update(playHistory)
    .set({ ended_at: cutoff, aborted: true })
    .where(and(isNull(playHistory.ended_at), lt(playHistory.started_at, cutoff)));
  return Number((result as any).rowsAffected ?? 0);
}

/**
 * Most-recent N rows joined with media for display. The currently-playing
 * row (ended_at IS NULL) is the head; older rows follow.
 */
export async function getRecentPlays(limit = 20) {
  return db
    .select({
      id: playHistory.id,
      media_id: playHistory.media_id,
      source: playHistory.source,
      started_at: playHistory.started_at,
      ended_at: playHistory.ended_at,
      aborted: playHistory.aborted,
      live_listener_count: playHistory.live_listener_count,
      pick_reason: playHistory.pick_reason,
      title: mediaTable.title,
      artist: mediaTable.artist,
      original_filename: mediaTable.original_filename,
      duration_seconds: mediaTable.duration_seconds,
    })
    .from(playHistory)
    .leftJoin(mediaTable, eq(playHistory.media_id, mediaTable.id))
    .orderBy(desc(playHistory.id))
    .limit(limit);
}

/**
 * Single-row lookup by id — used when the supervisor knows which row is
 * currently airing (from the metadata watcher's request.on_air poll).
 *
 * Note: a "most recent open row" lookup doesn't work here because the
 * scheduler queues tracks ahead of time, so there are typically TWO
 * rows with ended_at=null: the currently-playing one and the next
 * queued one. The supervisor's current_play_id is the source of truth.
 */
export async function getPlayById(id: number) {
  const rows = await db
    .select({
      id: playHistory.id,
      media_id: playHistory.media_id,
      source: playHistory.source,
      started_at: playHistory.started_at,
      live_listener_count: playHistory.live_listener_count,
      title: mediaTable.title,
      artist: mediaTable.artist,
      original_filename: mediaTable.original_filename,
      duration_seconds: mediaTable.duration_seconds,
    })
    .from(playHistory)
    .leftJoin(mediaTable, eq(playHistory.media_id, mediaTable.id))
    .where(eq(playHistory.id, id))
    .limit(1);
  return rows[0] ?? null;
}
