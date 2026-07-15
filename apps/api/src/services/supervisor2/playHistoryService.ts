// Thin write/update helpers around the play_history table for Phase 4.
//
// The Queue Feeder inserts a row when it pushes a track to LiquidSoap
// (started_at = null — audio hasn't actually started yet). The Supervisor
// stamps started_at on LS_TRACK_STARTED and closes the previous row by
// setting ended_at.
//
// play_history.started_at / ended_at use Drizzle's `timestamp` mode, which
// maps Date <→ unix seconds in SQLite. Internally everything else in the
// supervisor uses unix milliseconds, so all helpers here accept unix ms and
// translate.

import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import {
  playHistory as playHistoryTable,
  type PlayHistoryInsert,
  type PlaySource,
} from '../../db/schema.js';

export interface InsertPushedFields {
  media_id: number;
  source: PlaySource;
  plan_item_id: number | null;
  campaign_id: number | null;
  music_campaign_id: number | null;
  pushed_at_ms: number; // unix ms — when the push was sent to LS
  pick_reason: string | null;
}

// Inserts a play_history row at push time. started_at is left null and is
// stamped later when LS confirms playback via the on_track webhook. ended_at
// is also null — it is set when the *next* track starts and we close this one.
export async function insertPushed(
  db: typeof defaultDb,
  fields: InsertPushedFields,
): Promise<number> {
  // Drizzle's timestamp mode requires a Date (or null) — never null on
  // started_at because the column is NOT NULL. To insert a row before audio
  // starts we pass a placeholder Date of pushed_at; the Supervisor overwrites
  // it on LS_TRACK_STARTED with the real on_air_timestamp. This keeps the
  // schema unchanged while still letting us link the plan_item to a play_history
  // id at push time.
  const placeholder = new Date(fields.pushed_at_ms);
  const insert: PlayHistoryInsert = {
    media_id: fields.media_id,
    source: fields.source,
    started_at: placeholder,
    confirmed: false,
    ended_at: null,
    aborted: false,
    pick_reason: fields.pick_reason,
    campaign_id: fields.campaign_id,
    music_campaign_id: fields.music_campaign_id,
    plan_item_id: fields.plan_item_id,
  };
  const inserted = await db
    .insert(playHistoryTable)
    .values(insert)
    .returning({ id: playHistoryTable.id });
  const id = inserted[0]?.id;
  if (id == null) {
    throw new Error('playHistoryService.insertPushed: insert returned no id');
  }
  return id;
}

// Overwrites started_at with the real on-air time once LS confirms playback,
// and marks the row confirmed — the only signal consumers have that this
// started_at is ground truth rather than insertPushed's push-time placeholder.
export async function stampStarted(
  db: typeof defaultDb,
  id: number,
  startedAtMs: number,
): Promise<void> {
  await db
    .update(playHistoryTable)
    .set({ started_at: new Date(startedAtMs), confirmed: true })
    .where(eq(playHistoryTable.id, id));
}

// Sets ended_at on a single row. Used by the Supervisor to close the
// previously-playing row when LS_TRACK_STARTED fires for the next item.
export async function closeRow(
  db: typeof defaultDb,
  id: number,
  endedAtMs: number,
): Promise<void> {
  await db
    .update(playHistoryTable)
    .set({ ended_at: new Date(endedAtMs) })
    .where(eq(playHistoryTable.id, id));
}

// Marks a row as aborted (cut short before it finished) and closes it — used
// when the Supervisor forcibly stops a `playing` item (hard-start trim, the
// manual operator skip) rather than letting it finish naturally (Decision
// 63). Distinct from closeRow: a naturally-finished play is never aborted,
// only one that was actively cut. Billing/pacing-cap counters (Campaign) must
// exclude aborted rows; LRP/rotation queries (Music, Branding, Rundown) must
// not — a cut-short play still occupied a rotation slot.
export async function abortRow(
  db: typeof defaultDb,
  id: number,
  endedAtMs: number,
): Promise<void> {
  await db
    .update(playHistoryTable)
    .set({ ended_at: new Date(endedAtMs), aborted: true })
    .where(eq(playHistoryTable.id, id));
}

// Closes every still-open row whose id is strictly less than `currentId`.
// Catches the case where webhooks were missed and we need to retroactively
// stamp ended_at on whatever was playing before the current track.
export async function closeOpenRowsBefore(
  db: typeof defaultDb,
  currentId: number,
  endedAtMs: number,
): Promise<void> {
  await db
    .update(playHistoryTable)
    .set({ ended_at: new Date(endedAtMs) })
    .where(
      and(
        isNull(playHistoryTable.ended_at),
        lt(playHistoryTable.id, currentId),
      ),
    );
}

// Closes the single most recent open row regardless of id ordering — used
// when LS_TRACK_STARTED carries no play_history_id (manual / live / safety
// fill) but a previous auto play_history row is still open.
export async function closeMostRecentOpenRow(
  db: typeof defaultDb,
  endedAtMs: number,
): Promise<number | null> {
  const rows = await db
    .select({ id: playHistoryTable.id })
    .from(playHistoryTable)
    .where(isNull(playHistoryTable.ended_at))
    .orderBy(playHistoryTable.id);
  const last = rows[rows.length - 1];
  if (!last) return null;
  await db
    .update(playHistoryTable)
    .set({ ended_at: new Date(endedAtMs) })
    .where(eq(playHistoryTable.id, last.id));
  return last.id;
}

// Returns the most recent play_history row with id > minId — used for
// drift accounting where the Supervisor wants to look up the plan_item_id
// of the freshly-started track when LS does not echo it in the webhook
// metadata (e.g. an outboard restart). Currently unused but kept for the
// expected Phase 5 read paths.
export async function findRecentRowAfter(
  db: typeof defaultDb,
  minId: number,
): Promise<{ id: number; plan_item_id: number | null } | null> {
  const rows = await db
    .select({ id: playHistoryTable.id, plan_item_id: playHistoryTable.plan_item_id })
    .from(playHistoryTable)
    .where(gt(playHistoryTable.id, minId))
    .orderBy(playHistoryTable.id);
  const last = rows[rows.length - 1];
  return last ?? null;
}
