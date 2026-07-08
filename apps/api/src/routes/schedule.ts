import { FastifyInstance } from 'fastify';
import { eq, and, gte, lte, sql } from 'drizzle-orm';
import {
  TemplateEntryCreateSchema,
  TemplateEntryPatchSchema,
  CalendarEntryCreateSchema,
  CalendarEntryPatchSchema,
  TemplateClockEntryUpsertSchema,
  ApplyTemplateSchema,
  TemplateEntryBatchRequestSchema,
  CalendarEntryBatchRequestSchema,
} from '@soono/shared';
import { db } from '../db/index.js';
import { templateEntries, calendarEntries, templateClockEntries, rundownAssignments, rundownDurationOverrides, rundownShowContent, shows, clockSegments, clocks } from '../db/schema.js';
import { invalidateInventory } from '../services/spotBudget.js';
import { requestReconcile } from '../services/supervisor2/bus.js';

// A batch op failing mid-transaction throws this to identify which op/row
// caused the rollback, instead of a generic 500 or a bare array index.
class BatchOpError extends Error {
  constructor(public readonly opIndex: number, public readonly rowId: number | null, message: string) {
    super(message);
  }
}

// ─── Clock scheduling validation ──────────────────────────────────────────────

async function validateClockForScheduling(clockId: number): Promise<string | null> {
  const [assignedShow] = await db.select({ name: shows.name })
    .from(shows).where(eq(shows.default_clock_id, clockId)).limit(1);
  if (assignedShow) {
    return `Clock is assigned to show "${assignedShow.name}" and cannot be scheduled individually.`;
  }
  const [emptyMusic] = await db.select({ id: clockSegments.id })
    .from(clockSegments)
    .where(and(
      eq(clockSegments.clock_id, clockId),
      eq(clockSegments.type, 'music'),
      sql`${clockSegments.sources} = '[]'`,
    ))
    .limit(1);
  if (emptyMusic) {
    return 'Clock has music segments with no content configured. Add a rotation or playlist source before scheduling.';
  }
  const [clockRow] = await db.select({ jingle_playlist_id: clocks.jingle_playlist_id, station_id_playlist_id: clocks.station_id_playlist_id })
    .from(clocks).where(eq(clocks.id, clockId)).limit(1);
  if (clockRow) {
    const missing: string[] = [];
    if (!clockRow.jingle_playlist_id) missing.push('jingle');
    if (!clockRow.station_id_playlist_id) missing.push('station ID');
    if (missing.length > 0) {
      return `Clock is missing a ${missing.join(' and ')} playlist. Branding won't play until these are configured.`;
    }
  }
  return null;
}

async function validateShowForScheduling(showId: number): Promise<string | null> {
  const [show] = await db.select({ name: shows.name, jingle_playlist_id: shows.jingle_playlist_id })
    .from(shows).where(eq(shows.id, showId)).limit(1);
  if (show && !show.jingle_playlist_id) {
    return `Show "${show.name}" has no jingle playlist configured. Jingles won't play until one is assigned.`;
  }
  return null;
}

// ─── Apply-template helpers ────────────────────────────────────────────────────

function applyPad2(n: number): string { return String(n).padStart(2, '0'); }

function applyTimeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m ?? 0);
}

function applyMinToTime(min: number): string {
  return `${applyPad2(Math.floor(min / 60) % 24)}:${applyPad2(min % 60)}`;
}

function materializeTemplateEntry(
  te: { time_start: string; time_end: string; show_id: number | null; clock_id: number | null },
  hourOverrides: Map<number, number>,
): Array<{ time_start: string; time_end: string; show_id: number | null; clock_id: number | null }> {
  const startMin = applyTimeToMin(te.time_start);
  const endMin   = applyTimeToMin(te.time_end);
  if (hourOverrides.size === 0) {
    return [{ time_start: te.time_start, time_end: te.time_end, show_id: te.show_id, clock_id: te.clock_id }];
  }
  // Collect hour-boundary split points within [startMin, endMin)
  const breaks: number[] = [startMin];
  const startHour = Math.ceil(startMin / 60);
  const endHour   = Math.floor(endMin   / 60);
  for (let h = startHour; h < endHour; h++) {
    if (hourOverrides.has(h)) breaks.push(h * 60);
  }
  breaks.push(endMin);
  const points = [...new Set(breaks)].sort((a, b) => a - b);

  const result: { time_start: string; time_end: string; show_id: number | null; clock_id: number | null }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const segStart = points[i];
    const segEnd   = points[i + 1];
    const segHour  = Math.floor(segStart / 60);
    const overrideClock = hourOverrides.get(segHour);
    result.push({
      time_start: applyMinToTime(segStart),
      time_end:   applyMinToTime(segEnd),
      show_id:    overrideClock !== undefined ? null : te.show_id,
      clock_id:   overrideClock !== undefined ? overrideClock : te.clock_id,
    });
  }
  return result.length > 0 ? result
    : [{ time_start: te.time_start, time_end: te.time_end, show_id: te.show_id, clock_id: te.clock_id }];
}

// HH:MM strings compare correctly with plain string ordering as long as both
// are zero-padded 2-digit — true everywhere in this codebase (clockResolver.ts
// relies on the same assumption). Overnight wraparound (e.g. 22:00 → 02:00) is
// not supported: every day gets its own row spanning ~00:00-23:59, so
// time_end < time_start is always a data-entry mistake, not an intentional
// wraparound. Uncaught, it makes the window unmatchable by the Supervisor's
// clock resolver (plain string comparison, no wraparound handling) for the
// entire day — has caused two silent dead-air incidents.
function isValidTimeWindow(start: string, end: string): boolean {
  return end >= start;
}

function applyHasOverlap(
  startStr: string,
  endStr: string,
  existing: { time_start: string; time_end: string }[],
): boolean {
  const s = applyTimeToMin(startStr);
  const e = applyTimeToMin(endStr);
  return existing.some((ex) => applyTimeToMin(ex.time_start) < e && applyTimeToMin(ex.time_end) > s);
}

export async function scheduleRoutes(fastify: FastifyInstance) {
  // ─── Template Entries ──────────────────────────────────────────────────────

  fastify.get('/template-entries', async (_req, reply) => {
    const rows = await db.select().from(templateEntries);
    return reply.send(rows);
  });

  fastify.post<{ Body: unknown }>('/template-entries', async (request, reply) => {
    const parsed = TemplateEntryCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    if (!isValidTimeWindow(parsed.data.time_start, parsed.data.time_end)) {
      return reply.status(400).send({ error: `time_end (${parsed.data.time_end}) must not be before time_start (${parsed.data.time_start}) — overnight wraparound isn't supported` });
    }
    if (parsed.data.clock_id != null) {
      const err = await validateClockForScheduling(parsed.data.clock_id);
      if (err) return reply.status(409).send({ error: err });
    }
    if (parsed.data.show_id != null) {
      const err = await validateShowForScheduling(parsed.data.show_id);
      if (err) return reply.status(409).send({ error: err });
    }
    const [entry] = await db.insert(templateEntries).values({
      day_of_week: parsed.data.day_of_week,
      time_start: parsed.data.time_start,
      time_end: parsed.data.time_end,
      show_id: parsed.data.show_id ?? null,
      clock_id: parsed.data.clock_id ?? null,
    }).returning();
    requestReconcile('template_entry_change');
    return reply.status(201).send(entry);
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/template-entries/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = TemplateEntryPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    if (parsed.data.clock_id != null) {
      const err = await validateClockForScheduling(parsed.data.clock_id);
      if (err) return reply.status(409).send({ error: err });
    }
    if (parsed.data.show_id != null) {
      const err = await validateShowForScheduling(parsed.data.show_id);
      if (err) return reply.status(409).send({ error: err });
    }
    if (parsed.data.time_start != null || parsed.data.time_end != null) {
      const [current] = await db.select().from(templateEntries).where(eq(templateEntries.id, id));
      if (!current) return reply.status(404).send({ error: 'Template entry not found' });
      const newStart = parsed.data.time_start ?? current.time_start;
      const newEnd = parsed.data.time_end ?? current.time_end;
      if (!isValidTimeWindow(newStart, newEnd)) {
        return reply.status(400).send({ error: `time_end (${newEnd}) must not be before time_start (${newStart}) — overnight wraparound isn't supported` });
      }
    }
    const [updated] = await db.update(templateEntries)
      .set(parsed.data)
      .where(eq(templateEntries.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Template entry not found' });
    requestReconcile('template_entry_change');
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/template-entries/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(templateEntries).where(eq(templateEntries.id, id));
    requestReconcile('template_entry_change');
    return reply.status(204).send();
  });

  // Staged-editing batch commit (Decision 55): one transaction, one reconcile
  // call, for a whole editing session's worth of create/update/delete ops
  // instead of one round-trip (and one reconcile) per edit. template_entries
  // has no side-effect tables to migrate, so this is a straightforward
  // sequential apply — see /calendar-entries/batch below for the harder case.
  fastify.post<{ Body: unknown }>('/template-entries/batch', async (request, reply) => {
    const parsed = TemplateEntryBatchRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const ops = parsed.data.ops;

    // Each row must be targeted by at most one op — the staged frontend
    // squashes repeat edits to the same row into a single pending op before
    // ever building a batch, so this should never trip for the real client;
    // guard it anyway rather than silently doing the wrong thing.
    const dupCheck = new Set<number>();
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const target = op.kind === 'create' ? op.tempId : op.id;
      if (dupCheck.has(target)) {
        return reply.status(400).send({ error: `op ${i}: duplicate target id/tempId ${target} — each row must be touched by at most one op per batch`, op_index: i });
      }
      dupCheck.add(target);
    }

    // Pre-validate what doesn't depend on other ops in the batch, so a bad
    // row 400s the whole batch with no partial writes.
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.kind === 'create') {
        if (!isValidTimeWindow(op.data.time_start, op.data.time_end)) {
          return reply.status(400).send({ error: `op ${i} (create): time_end (${op.data.time_end}) must not be before time_start (${op.data.time_start})`, op_index: i });
        }
        if (op.data.clock_id != null) {
          const err = await validateClockForScheduling(op.data.clock_id);
          if (err) return reply.status(409).send({ error: `op ${i} (create): ${err}`, op_index: i });
        }
        if (op.data.show_id != null) {
          const err = await validateShowForScheduling(op.data.show_id);
          if (err) return reply.status(409).send({ error: `op ${i} (create): ${err}`, op_index: i });
        }
      } else if (op.kind === 'update') {
        if (op.patch.clock_id != null) {
          const err = await validateClockForScheduling(op.patch.clock_id);
          if (err) return reply.status(409).send({ error: `op ${i} (update): ${err}`, op_index: i });
        }
        if (op.patch.show_id != null) {
          const err = await validateShowForScheduling(op.patch.show_id);
          if (err) return reply.status(409).send({ error: `op ${i} (update): ${err}`, op_index: i });
        }
        // Time-window merge-check needs "current" row state, which for a
        // tempId-referenced row only exists once its create op has run
        // inside the transaction below — deferred there.
      }
    }

    const idMap = new Map<number, number>(); // tempId -> real id, for the response only

    try {
      await db.transaction(async (tx) => {
        for (let i = 0; i < ops.length; i++) {
          const op = ops[i];
          if (op.kind === 'create') {
            const [entry] = await tx.insert(templateEntries).values({
              day_of_week: op.data.day_of_week,
              time_start: op.data.time_start,
              time_end: op.data.time_end,
              show_id: op.data.show_id ?? null,
              clock_id: op.data.clock_id ?? null,
            }).returning();
            idMap.set(op.tempId, entry.id);
          } else if (op.kind === 'update') {
            const [current] = await tx.select().from(templateEntries).where(eq(templateEntries.id, op.id));
            if (!current) throw new BatchOpError(i, op.id, 'Template entry not found');
            const newStart = op.patch.time_start ?? current.time_start;
            const newEnd = op.patch.time_end ?? current.time_end;
            if (!isValidTimeWindow(newStart, newEnd)) {
              throw new BatchOpError(i, op.id, `time_end (${newEnd}) must not be before time_start (${newStart})`);
            }
            await tx.update(templateEntries).set(op.patch).where(eq(templateEntries.id, op.id));
          } else {
            await tx.delete(templateEntries).where(eq(templateEntries.id, op.id));
          }
        }
      });
    } catch (err) {
      if (err instanceof BatchOpError) {
        return reply.status(400).send({ error: err.message, op_index: err.opIndex, id: err.rowId });
      }
      throw err;
    }

    requestReconcile('template_batch_apply');
    return reply.send({ ok: true, id_map: Object.fromEntries(idMap) });
  });

  // ─── Calendar Entries ──────────────────────────────────────────────────────

  fastify.get<{ Querystring: { week_start?: string } }>('/calendar-entries', async (request, reply) => {
    const { week_start } = request.query;
    if (!week_start) {
      const rows = await db.select().from(calendarEntries);
      return reply.send(rows);
    }
    // Return the 7-day window starting from week_start
    const start = week_start; // "2026-05-04"
    const endDate = new Date(week_start);
    endDate.setDate(endDate.getDate() + 7);
    const end = endDate.toISOString().slice(0, 10);
    const rows = await db.select().from(calendarEntries)
      .where(and(gte(calendarEntries.date, start), lte(calendarEntries.date, end)));
    return reply.send(rows);
  });

  fastify.post<{ Body: unknown }>('/calendar-entries', async (request, reply) => {
    const parsed = CalendarEntryCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    if (!isValidTimeWindow(parsed.data.time_start, parsed.data.time_end)) {
      return reply.status(400).send({ error: `time_end (${parsed.data.time_end}) must not be before time_start (${parsed.data.time_start}) — overnight wraparound isn't supported` });
    }
    if (parsed.data.clock_id != null) {
      const err = await validateClockForScheduling(parsed.data.clock_id);
      if (err) return reply.status(409).send({ error: err });
    }
    if (parsed.data.show_id != null) {
      const err = await validateShowForScheduling(parsed.data.show_id);
      if (err) return reply.status(409).send({ error: err });
    }
    const [entry] = await db.insert(calendarEntries).values({
      date: parsed.data.date,
      time_start: parsed.data.time_start,
      time_end: parsed.data.time_end,
      show_id: parsed.data.show_id ?? null,
      clock_id: parsed.data.clock_id ?? null,
      is_override: parsed.data.is_override ?? false,
    }).returning();
    invalidateInventory();
    requestReconcile('calendar_entry_change');
    return reply.status(201).send(entry);
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/calendar-entries/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = CalendarEntryPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    if (parsed.data.clock_id != null) {
      const err = await validateClockForScheduling(parsed.data.clock_id);
      if (err) return reply.status(409).send({ error: err });
    }
    if (parsed.data.show_id != null) {
      const err = await validateShowForScheduling(parsed.data.show_id);
      if (err) return reply.status(409).send({ error: err });
    }

    const [current] = await db.select().from(calendarEntries).where(eq(calendarEntries.id, id));
    if (!current) return reply.status(404).send({ error: 'Calendar entry not found' });

    const newDate      = parsed.data.date       ?? current.date;
    const newTimeStart = parsed.data.time_start  ?? current.time_start;
    const newTimeEnd   = parsed.data.time_end    ?? current.time_end;
    if (!isValidTimeWindow(newTimeStart, newTimeEnd)) {
      return reply.status(400).send({ error: `time_end (${newTimeEnd}) must not be before time_start (${newTimeStart}) — overnight wraparound isn't supported` });
    }
    const positionChanged = newDate !== current.date || newTimeStart !== current.time_start;

    // Resolve effective clock_id for rundown migration: prefer the entry's own
    // clock_id; fall back to the show's default_clock_id (matches frontend key logic).
    let clockId = current.clock_id;
    if (clockId === null && current.show_id !== null) {
      const [show] = await db.select({ default_clock_id: shows.default_clock_id })
        .from(shows).where(eq(shows.id, current.show_id));
      clockId = show?.default_clock_id ?? null;
    }

    const updated = await db.transaction(async (tx) => {
      const [entry] = await tx.update(calendarEntries)
        .set(parsed.data)
        .where(eq(calendarEntries.id, id))
        .returning();

      if (positionChanged && clockId !== null) {
        // Clear any rundown rows already at the destination to avoid unique conflicts
        await tx.delete(rundownAssignments).where(and(
          eq(rundownAssignments.date, newDate),
          eq(rundownAssignments.time_start, newTimeStart),
          eq(rundownAssignments.clock_id, clockId),
        ));
        await tx.delete(rundownDurationOverrides).where(and(
          eq(rundownDurationOverrides.date, newDate),
          eq(rundownDurationOverrides.time_start, newTimeStart),
          eq(rundownDurationOverrides.clock_id, clockId),
        ));
        await tx.delete(rundownShowContent).where(and(
          eq(rundownShowContent.date, newDate),
          eq(rundownShowContent.time_start, newTimeStart),
          eq(rundownShowContent.clock_id, clockId),
        ));

        // Migrate rundown rows from old position to new position
        await tx.update(rundownAssignments)
          .set({ date: newDate, time_start: newTimeStart })
          .where(and(
            eq(rundownAssignments.date, current.date),
            eq(rundownAssignments.time_start, current.time_start),
            eq(rundownAssignments.clock_id, clockId),
          ));
        await tx.update(rundownDurationOverrides)
          .set({ date: newDate, time_start: newTimeStart })
          .where(and(
            eq(rundownDurationOverrides.date, current.date),
            eq(rundownDurationOverrides.time_start, current.time_start),
            eq(rundownDurationOverrides.clock_id, clockId),
          ));
        await tx.update(rundownShowContent)
          .set({ date: newDate, time_start: newTimeStart })
          .where(and(
            eq(rundownShowContent.date, current.date),
            eq(rundownShowContent.time_start, current.time_start),
            eq(rundownShowContent.clock_id, clockId),
          ));
      }

      return entry;
    });

    invalidateInventory();
    requestReconcile('calendar_entry_change');
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/calendar-entries/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.transaction(async (tx) => {
      const [entry] = await tx.select().from(calendarEntries).where(eq(calendarEntries.id, id));
      if (entry) {
        let clockId = entry.clock_id;
        if (clockId === null && entry.show_id !== null) {
          const [show] = await tx.select({ default_clock_id: shows.default_clock_id })
            .from(shows).where(eq(shows.id, entry.show_id));
          clockId = show?.default_clock_id ?? null;
        }
        if (clockId !== null) {
          await tx.delete(rundownAssignments).where(and(
            eq(rundownAssignments.date, entry.date),
            eq(rundownAssignments.time_start, entry.time_start),
            eq(rundownAssignments.clock_id, clockId),
          ));
          await tx.delete(rundownDurationOverrides).where(and(
            eq(rundownDurationOverrides.date, entry.date),
            eq(rundownDurationOverrides.time_start, entry.time_start),
            eq(rundownDurationOverrides.clock_id, clockId),
          ));
          await tx.delete(rundownShowContent).where(and(
            eq(rundownShowContent.date, entry.date),
            eq(rundownShowContent.time_start, entry.time_start),
            eq(rundownShowContent.clock_id, clockId),
          ));
        }
      }
      await tx.delete(calendarEntries).where(eq(calendarEntries.id, id));
    });
    invalidateInventory();
    requestReconcile('calendar_entry_change');
    return reply.status(204).send();
  });

  fastify.delete('/calendar-entries', async (_req, reply) => {
    await db.transaction(async (tx) => {
      await tx.delete(rundownAssignments);
      await tx.delete(rundownDurationOverrides);
      await tx.delete(rundownShowContent);
      await tx.delete(calendarEntries);
    });
    invalidateInventory();
    requestReconcile('calendar_entry_change');
    return reply.status(204).send();
  });

  // Staged-editing batch commit (Decision 55) — same shape as
  // /template-entries/batch, but calendar_entries carries real side effects
  // (rundown content keyed by (date, time_start, clock_id)) that the
  // individual PATCH/DELETE routes already migrate. Sequential per-op
  // replay composes correctly for repeat edits to the SAME row (each op
  // re-fetches "current" fresh), but naively replaying "clear rundown at
  // destination, then migrate rundown from source" per op breaks on a
  // position CYCLE within one batch — e.g. row A moves to row B's current
  // slot while row B moves elsewhere: op A's "clear destination" step would
  // delete row B's still-live rundown content before op B gets a chance to
  // migrate it. Fixed with a two-pass move: evacuate every position-changing
  // row's rundown content to a transaction-local sentinel slot BEFORE any
  // calendar_entries rows are updated, then in a second pass clear whatever
  // is genuinely at each destination (now guaranteed to only be non-batch
  // content, since every batch-internal source was already evacuated) and
  // move sentinel -> real destination. Sentinel values never escape this
  // transaction.
  fastify.post<{ Body: unknown }>('/calendar-entries/batch', async (request, reply) => {
    const parsed = CalendarEntryBatchRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const ops = parsed.data.ops;

    // Each row must be targeted by at most one op — the two-pass rundown
    // migration below assumes it; the staged frontend squashes repeat edits
    // to the same row into a single pending op before building a batch.
    const dupCheck = new Set<number>();
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const target = op.kind === 'create' ? op.tempId : op.id;
      if (dupCheck.has(target)) {
        return reply.status(400).send({ error: `op ${i}: duplicate target id/tempId ${target} — each row must be touched by at most one op per batch`, op_index: i });
      }
      dupCheck.add(target);
    }

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.kind === 'create') {
        if (!isValidTimeWindow(op.data.time_start, op.data.time_end)) {
          return reply.status(400).send({ error: `op ${i} (create): time_end (${op.data.time_end}) must not be before time_start (${op.data.time_start})`, op_index: i });
        }
        if (op.data.clock_id != null) {
          const err = await validateClockForScheduling(op.data.clock_id);
          if (err) return reply.status(409).send({ error: `op ${i} (create): ${err}`, op_index: i });
        }
        if (op.data.show_id != null) {
          const err = await validateShowForScheduling(op.data.show_id);
          if (err) return reply.status(409).send({ error: `op ${i} (create): ${err}`, op_index: i });
        }
      } else if (op.kind === 'update') {
        if (op.patch.clock_id != null) {
          const err = await validateClockForScheduling(op.patch.clock_id);
          if (err) return reply.status(409).send({ error: `op ${i} (update): ${err}`, op_index: i });
        }
        if (op.patch.show_id != null) {
          const err = await validateShowForScheduling(op.patch.show_id);
          if (err) return reply.status(409).send({ error: `op ${i} (update): ${err}`, op_index: i });
        }
      }
    }

    const idMap = new Map<number, number>(); // tempId -> real id, for the response only
    const sentinelDate = (opIndex: number) => `__batch_staging_${opIndex}__`;

    type Move = { opIndex: number; realId: number; clockId: number; oldDate: string; oldTime: string; newDate: string; newTime: string };

    try {
      await db.transaction(async (tx) => {
        // Pass 0: resolve every position-changing update's effective clockId
        // (own clock_id, else the show's default_clock_id — same resolution
        // the individual PATCH route uses) and evacuate its rundown content
        // to a sentinel slot, before any calendar_entries row is touched.
        const moves: Move[] = [];
        for (let i = 0; i < ops.length; i++) {
          const op = ops[i];
          if (op.kind !== 'update') continue;
          const [current] = await tx.select().from(calendarEntries).where(eq(calendarEntries.id, op.id));
          if (!current) throw new BatchOpError(i, op.id, 'Calendar entry not found');
          const newDate = op.patch.date ?? current.date;
          const newTimeStart = op.patch.time_start ?? current.time_start;
          const newTimeEnd = op.patch.time_end ?? current.time_end;
          if (!isValidTimeWindow(newTimeStart, newTimeEnd)) {
            throw new BatchOpError(i, op.id, `time_end (${newTimeEnd}) must not be before time_start (${newTimeStart})`);
          }
          const positionChanged = newDate !== current.date || newTimeStart !== current.time_start;
          if (!positionChanged) continue;

          let clockId = current.clock_id;
          if (clockId === null && current.show_id !== null) {
            const [show] = await tx.select({ default_clock_id: shows.default_clock_id }).from(shows).where(eq(shows.id, current.show_id));
            clockId = show?.default_clock_id ?? null;
          }
          if (clockId === null) continue;

          moves.push({ opIndex: i, realId: op.id, clockId, oldDate: current.date, oldTime: current.time_start, newDate, newTime: newTimeStart });

          const sDate = sentinelDate(i);
          await tx.update(rundownAssignments).set({ date: sDate, time_start: '00' }).where(and(eq(rundownAssignments.date, current.date), eq(rundownAssignments.time_start, current.time_start), eq(rundownAssignments.clock_id, clockId)));
          await tx.update(rundownDurationOverrides).set({ date: sDate, time_start: '00' }).where(and(eq(rundownDurationOverrides.date, current.date), eq(rundownDurationOverrides.time_start, current.time_start), eq(rundownDurationOverrides.clock_id, clockId)));
          await tx.update(rundownShowContent).set({ date: sDate, time_start: '00' }).where(and(eq(rundownShowContent.date, current.date), eq(rundownShowContent.time_start, current.time_start), eq(rundownShowContent.clock_id, clockId)));
        }

        // Pass 1: apply every op's actual calendar_entries write.
        for (let i = 0; i < ops.length; i++) {
          const op = ops[i];
          if (op.kind === 'create') {
            const [entry] = await tx.insert(calendarEntries).values({
              date: op.data.date,
              time_start: op.data.time_start,
              time_end: op.data.time_end,
              show_id: op.data.show_id ?? null,
              clock_id: op.data.clock_id ?? null,
              is_override: op.data.is_override ?? false,
            }).returning();
            idMap.set(op.tempId, entry.id);
          } else if (op.kind === 'update') {
            await tx.update(calendarEntries).set(op.patch).where(eq(calendarEntries.id, op.id));
          } else {
            const [entry] = await tx.select().from(calendarEntries).where(eq(calendarEntries.id, op.id));
            if (entry) {
              let clockId = entry.clock_id;
              if (clockId === null && entry.show_id !== null) {
                const [show] = await tx.select({ default_clock_id: shows.default_clock_id }).from(shows).where(eq(shows.id, entry.show_id));
                clockId = show?.default_clock_id ?? null;
              }
              if (clockId !== null) {
                await tx.delete(rundownAssignments).where(and(eq(rundownAssignments.date, entry.date), eq(rundownAssignments.time_start, entry.time_start), eq(rundownAssignments.clock_id, clockId)));
                await tx.delete(rundownDurationOverrides).where(and(eq(rundownDurationOverrides.date, entry.date), eq(rundownDurationOverrides.time_start, entry.time_start), eq(rundownDurationOverrides.clock_id, clockId)));
                await tx.delete(rundownShowContent).where(and(eq(rundownShowContent.date, entry.date), eq(rundownShowContent.time_start, entry.time_start), eq(rundownShowContent.clock_id, clockId)));
              }
            }
            await tx.delete(calendarEntries).where(eq(calendarEntries.id, op.id));
          }
        }

        // Pass 2: clear whatever is genuinely at each move's destination
        // (only ever non-batch content at this point — every batch-internal
        // source was evacuated in Pass 0), then land the sentinel content.
        for (const mv of moves) {
          await tx.delete(rundownAssignments).where(and(eq(rundownAssignments.date, mv.newDate), eq(rundownAssignments.time_start, mv.newTime), eq(rundownAssignments.clock_id, mv.clockId)));
          await tx.delete(rundownDurationOverrides).where(and(eq(rundownDurationOverrides.date, mv.newDate), eq(rundownDurationOverrides.time_start, mv.newTime), eq(rundownDurationOverrides.clock_id, mv.clockId)));
          await tx.delete(rundownShowContent).where(and(eq(rundownShowContent.date, mv.newDate), eq(rundownShowContent.time_start, mv.newTime), eq(rundownShowContent.clock_id, mv.clockId)));

          const sDate = sentinelDate(mv.opIndex);
          await tx.update(rundownAssignments).set({ date: mv.newDate, time_start: mv.newTime }).where(and(eq(rundownAssignments.date, sDate), eq(rundownAssignments.time_start, '00'), eq(rundownAssignments.clock_id, mv.clockId)));
          await tx.update(rundownDurationOverrides).set({ date: mv.newDate, time_start: mv.newTime }).where(and(eq(rundownDurationOverrides.date, sDate), eq(rundownDurationOverrides.time_start, '00'), eq(rundownDurationOverrides.clock_id, mv.clockId)));
          await tx.update(rundownShowContent).set({ date: mv.newDate, time_start: mv.newTime }).where(and(eq(rundownShowContent.date, sDate), eq(rundownShowContent.time_start, '00'), eq(rundownShowContent.clock_id, mv.clockId)));
        }
      });
    } catch (err) {
      if (err instanceof BatchOpError) {
        return reply.status(400).send({ error: err.message, op_index: err.opIndex, id: err.rowId });
      }
      throw err;
    }

    invalidateInventory();
    requestReconcile('calendar_batch_apply');
    return reply.send({ ok: true, id_map: Object.fromEntries(idMap) });
  });

  // ─── Template Clock Entries ────────────────────────────────────────────────

  fastify.get('/template-clock-entries', async (_req, reply) => {
    const rows = await db.select().from(templateClockEntries);
    return reply.send(rows);
  });

  // Upsert by (day_of_week, hour)
  fastify.put<{ Body: unknown }>('/template-clock-entries', async (request, reply) => {
    const parsed = TemplateClockEntryUpsertSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    if (parsed.data.clock_id != null) {
      const err = await validateClockForScheduling(parsed.data.clock_id);
      if (err) return reply.status(409).send({ error: err });
    }
    const existing = await db.select().from(templateClockEntries).where(
      and(
        eq(templateClockEntries.day_of_week, parsed.data.day_of_week),
        eq(templateClockEntries.hour, parsed.data.hour),
      ),
    );
    if (existing.length > 0) {
      const [updated] = await db.update(templateClockEntries)
        .set({ clock_id: parsed.data.clock_id })
        .where(eq(templateClockEntries.id, existing[0].id))
        .returning();
      requestReconcile('template_clock_entry_change');
      return reply.send(updated);
    }
    const [created] = await db.insert(templateClockEntries).values({
      day_of_week: parsed.data.day_of_week,
      hour: parsed.data.hour,
      clock_id: parsed.data.clock_id,
    }).returning();
    requestReconcile('template_clock_entry_change');
    return reply.status(201).send(created);
  });

  fastify.delete<{ Params: { id: string } }>('/template-clock-entries/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(templateClockEntries).where(eq(templateClockEntries.id, id));
    requestReconcile('template_clock_entry_change');
    return reply.status(204).send();
  });

  // ─── Apply Template ────────────────────────────────────────────────────────

  fastify.post<{ Body: unknown }>('/apply-template', async (request, reply) => {
    const parsed = ApplyTemplateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });

    const { date_from, date_to, mode: applyMode } = parsed.data;

    const tmplEntries     = await db.select().from(templateEntries);
    const tmplClockEntries = await db.select().from(templateClockEntries);

    // Build per-dow clock override map
    const clockOverrideMap = new Map<number, Map<number, number>>();
    for (const tce of tmplClockEntries) {
      if (!clockOverrideMap.has(tce.day_of_week)) clockOverrideMap.set(tce.day_of_week, new Map());
      clockOverrideMap.get(tce.day_of_week)!.set(tce.hour, tce.clock_id);
    }

    // Enumerate dates in range
    const dates: string[] = [];
    const cur = new Date(date_from + 'T12:00:00Z');
    const end = new Date(date_to   + 'T12:00:00Z');
    while (cur <= end) {
      dates.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    let deleted = 0;
    if (applyMode === 'override' && dates.length > 0) {
      const existing = await db.select({ id: calendarEntries.id })
        .from(calendarEntries)
        .where(and(gte(calendarEntries.date, date_from), lte(calendarEntries.date, date_to)));
      deleted = existing.length;
      if (deleted > 0) {
        const dateWhere = and(gte(rundownAssignments.date, date_from), lte(rundownAssignments.date, date_to));
        await db.delete(rundownAssignments).where(dateWhere);
        await db.delete(rundownDurationOverrides).where(
          and(gte(rundownDurationOverrides.date, date_from), lte(rundownDurationOverrides.date, date_to)),
        );
        await db.delete(rundownShowContent).where(
          and(gte(rundownShowContent.date, date_from), lte(rundownShowContent.date, date_to)),
        );
        await db.delete(calendarEntries).where(
          and(gte(calendarEntries.date, date_from), lte(calendarEntries.date, date_to)),
        );
      }
    }

    // Load existing entries once for fill mode
    const existingByDate = new Map<string, { time_start: string; time_end: string }[]>();
    if (applyMode === 'fill') {
      const rows = await db
        .select({ date: calendarEntries.date, time_start: calendarEntries.time_start, time_end: calendarEntries.time_end })
        .from(calendarEntries)
        .where(and(gte(calendarEntries.date, date_from), lte(calendarEntries.date, date_to)));
      for (const row of rows) {
        if (!existingByDate.has(row.date)) existingByDate.set(row.date, []);
        existingByDate.get(row.date)!.push(row);
      }
    }

    const toInsert: { date: string; time_start: string; time_end: string; show_id: number | null; clock_id: number | null; is_override: boolean }[] = [];
    let skipped = 0;

    for (const dateStr of dates) {
      const jsDay = new Date(dateStr + 'T12:00:00Z').getUTCDay();
      const dow = jsDay === 0 ? 7 : jsDay; // 1=Mon, 7=Sun
      const dayEntries   = tmplEntries.filter((te) => te.day_of_week === dow);
      const hourOverrides = clockOverrideMap.get(dow) ?? new Map<number, number>();
      const existing      = applyMode === 'fill' ? (existingByDate.get(dateStr) ?? []) : [];

      for (const te of dayEntries) {
        if (!isValidTimeWindow(te.time_start, te.time_end)) {
          // Defense in depth: the write endpoints reject this shape, but
          // don't propagate a legacy bad row into the calendar if one exists.
          skipped++;
          continue;
        }
        for (const slot of materializeTemplateEntry(te, hourOverrides)) {
          if (applyMode === 'fill' && applyHasOverlap(slot.time_start, slot.time_end, existing)) {
            skipped++;
            continue;
          }
          toInsert.push({ date: dateStr, ...slot, is_override: false });
        }
      }
    }

    if (toInsert.length > 0) {
      for (let i = 0; i < toInsert.length; i += 200) {
        await db.insert(calendarEntries).values(toInsert.slice(i, i + 200));
      }
    }

    // One reconcile for the whole batch (Decision 55), not one per row —
    // and only if the batch actually changed anything.
    if (toInsert.length > 0 || deleted > 0) requestReconcile('template_run');

    return reply.send({ created: toInsert.length, skipped, deleted });
  });
}
