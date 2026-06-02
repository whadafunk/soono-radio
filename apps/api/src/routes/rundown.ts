import { FastifyInstance } from 'fastify';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { RundownAssignmentUpsertSchema, RundownDurationOverrideUpsertSchema, RundownShowContentUpsertSchema, RUNDOWN_SEGMENT_TYPES } from '@soono/shared';
import { db } from '../db/index.js';
import {
  calendarEntries, clocks, clockSegments, media, playlists,
  rundownAssignments, rundownDurationOverrides, rundownShowContent, templateClockEntries, templateEntries,
} from '../db/schema.js';

// ── Time helpers ──────────────────────────────────────────────────────────────

function pad2(n: number) { return n < 10 ? `0${n}` : `${n}`; }

function timeStrToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m ?? 0);
}

function minutesToTimeStr(m: number): string {
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** JS Date.getDay() (0=Sun…6=Sat) → schema dow (1=Mon…7=Sun) */
function dateToDow(dateStr: string): number {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const jsDay = new Date(y, mo - 1, d).getDay();
  return ((jsDay + 6) % 7) + 1;
}

function enumerateDateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const cur = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = cur.getMonth() + 1;
    const d = cur.getDate();
    dates.push(`${y}-${pad2(m)}-${pad2(d)}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// ── Span resolution ───────────────────────────────────────────────────────────
// For a given date, determine which clock is scheduled at each minute using
// three precedence levels: template span (0) < per-hour override (1) < calendar (2).
// Returns non-overlapping spans ordered by time_start.

async function resolvedSpansForDate(date: string): Promise<{ timeStart: string; timeEnd: string; clockId: number }[]> {
  const dow = dateToDow(date);

  const [calRows, templateRows, tcRows] = await Promise.all([
    db.select().from(calendarEntries).where(eq(calendarEntries.date, date)),
    db.select().from(templateEntries).where(eq(templateEntries.day_of_week, dow)),
    db.select().from(templateClockEntries).where(eq(templateClockEntries.day_of_week, dow)),
  ]);

  // minute-granularity clock map for the day (1440 slots)
  const minuteClock: (number | null)[] = new Array(24 * 60).fill(null);

  const layers: { timeStart: string; timeEnd: string; clockId: number; priority: number }[] = [];

  for (const t of templateRows) {
    if (t.clock_id) layers.push({ timeStart: t.time_start, timeEnd: t.time_end, clockId: t.clock_id, priority: 0 });
  }
  for (const tc of tcRows) {
    const hStr = `${pad2(tc.hour)}:00`;
    const hEnd = tc.hour < 23 ? `${pad2(tc.hour + 1)}:00` : '24:00';
    layers.push({ timeStart: hStr, timeEnd: hEnd, clockId: tc.clock_id, priority: 1 });
  }
  for (const cal of calRows) {
    if (cal.clock_id) layers.push({ timeStart: cal.time_start, timeEnd: cal.time_end, clockId: cal.clock_id, priority: 2 });
  }

  // Apply ascending priority so higher overwrites lower
  layers.sort((a, b) => a.priority - b.priority);
  for (const layer of layers) {
    const s = timeStrToMinutes(layer.timeStart);
    const e = Math.min(timeStrToMinutes(layer.timeEnd), 24 * 60);
    for (let m = s; m < e; m++) minuteClock[m] = layer.clockId;
  }

  // Reconstruct non-overlapping spans
  const spans: { timeStart: string; timeEnd: string; clockId: number }[] = [];
  let cur: number | null = null;
  let start = 0;
  for (let m = 0; m <= 24 * 60; m++) {
    const cid = m < 24 * 60 ? minuteClock[m] : null;
    if (cid !== cur) {
      if (cur !== null) spans.push({ timeStart: minutesToTimeStr(start), timeEnd: minutesToTimeStr(m), clockId: cur });
      cur = cid;
      start = m;
    }
  }
  return spans;
}

// ── Slot enumeration ──────────────────────────────────────────────────────────

export interface RundownSlotKey {
  date: string;
  time_start: string;   // clock instance start ("08:00")
  clock_id: number;
}

async function enumerateSlots(dateFrom: string, dateTo: string): Promise<RundownSlotKey[]> {
  // Only care about clocks that have at least one assignable segment type
  const assignableRows = await db
    .selectDistinct({ clock_id: clockSegments.clock_id })
    .from(clockSegments)
    .where(inArray(clockSegments.type, [...RUNDOWN_SEGMENT_TYPES]));

  if (assignableRows.length === 0) return [];
  const assignableClockIds = new Set(assignableRows.map((r) => r.clock_id));

  // Clock duration = sum of segment durations (not stored on the clock row itself)
  const allSegsForDuration = await db
    .select({ clock_id: clockSegments.clock_id, duration_seconds: clockSegments.duration_seconds })
    .from(clockSegments)
    .where(inArray(clockSegments.clock_id, [...assignableClockIds]));
  const clockDuration = new Map<number, number>();
  for (const s of allSegsForDuration) {
    clockDuration.set(s.clock_id, (clockDuration.get(s.clock_id) ?? 0) + s.duration_seconds);
  }

  const dates = enumerateDateRange(dateFrom, dateTo);
  const slots: RundownSlotKey[] = [];

  for (const date of dates) {
    const spans = await resolvedSpansForDate(date);
    for (const span of spans) {
      if (!assignableClockIds.has(span.clockId)) continue;
      const dur = clockDuration.get(span.clockId) ?? 0;
      if (dur <= 0) continue;
      const durMin = dur / 60;
      const startMin = timeStrToMinutes(span.timeStart);
      const endMin = timeStrToMinutes(span.timeEnd);
      for (let t = startMin; t < endMin; t += durMin) {
        slots.push({ date, time_start: minutesToTimeStr(Math.round(t)), clock_id: span.clockId });
      }
    }
  }
  return slots;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function rundownRoutes(fastify: FastifyInstance) {

  // GET /rundown?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
  fastify.get<{ Querystring: { date_from: string; date_to: string } }>('/rundown', async (request, reply) => {
    const { date_from, date_to } = request.query;
    if (!date_from || !date_to) return reply.status(400).send({ error: 'date_from and date_to required' });

    const slots = await enumerateSlots(date_from, date_to);
    if (slots.length === 0) return reply.send([]);

    // Load clock + segment info for all involved (clock_id, date, time_start) combos
    const involvedClockIds = [...new Set(slots.map((s) => s.clock_id))];

    const [segRows, clockRows, assignmentRows, overrideRows, showContentRows] = await Promise.all([
      db.select().from(clockSegments)
        .where(and(
          inArray(clockSegments.clock_id, involvedClockIds),
          inArray(clockSegments.type, [...RUNDOWN_SEGMENT_TYPES]),
        ))
        .orderBy(clockSegments.sort_order),
      db.select({ id: clocks.id, name: clocks.name }).from(clocks)
        .where(inArray(clocks.id, involvedClockIds)),
      db.select({
        id: rundownAssignments.id,
        date: rundownAssignments.date,
        time_start: rundownAssignments.time_start,
        clock_id: rundownAssignments.clock_id,
        segment_index: rundownAssignments.segment_index,
        media_id: rundownAssignments.media_id,
        notes: rundownAssignments.notes,
        assigned_at: rundownAssignments.assigned_at,
        media_title: media.title,
        media_artist: media.artist,
        media_duration_seconds: media.duration_seconds,
        media_original_filename: media.original_filename,
      })
        .from(rundownAssignments)
        .leftJoin(media, eq(rundownAssignments.media_id, media.id))
        .where(and(
          gte(rundownAssignments.date, date_from),
          lte(rundownAssignments.date, date_to),
          inArray(rundownAssignments.clock_id, involvedClockIds),
        )),
      db.select().from(rundownDurationOverrides)
        .where(and(
          gte(rundownDurationOverrides.date, date_from),
          lte(rundownDurationOverrides.date, date_to),
          inArray(rundownDurationOverrides.clock_id, involvedClockIds),
        )),
      db.select({
        id: rundownShowContent.id,
        date: rundownShowContent.date,
        time_start: rundownShowContent.time_start,
        clock_id: rundownShowContent.clock_id,
        segment_type: rundownShowContent.segment_type,
        playlist_id: rundownShowContent.playlist_id,
        playlist_name: playlists.name,
      })
        .from(rundownShowContent)
        .leftJoin(playlists, eq(rundownShowContent.playlist_id, playlists.id))
        .where(and(
          gte(rundownShowContent.date, date_from),
          lte(rundownShowContent.date, date_to),
          inArray(rundownShowContent.clock_id, involvedClockIds),
        )),
    ]);

    const clockNameMap = new Map(clockRows.map((c) => [c.id, c.name]));

    // Index segments by clock_id; also build sort_order → segment_index map per clock
    const segsByClockId = new Map<number, typeof segRows>();
    for (const seg of segRows) {
      if (!segsByClockId.has(seg.clock_id)) segsByClockId.set(seg.clock_id, []);
      segsByClockId.get(seg.clock_id)!.push(seg);
    }

    // Need full sort_order-to-index mapping for segment_index (index within clock, not among assignable segs only)
    const allSegsByClockId = new Map<number, { id: number; sort_order: number; type: string; duration_seconds: number; name: string; fallback_playlist_id: number | null }[]>();
    for (const clockId of involvedClockIds) {
      const rows = await db.select({
        id: clockSegments.id, sort_order: clockSegments.sort_order,
        type: clockSegments.type, duration_seconds: clockSegments.duration_seconds,
        name: clockSegments.name, fallback_playlist_id: clockSegments.fallback_playlist_id,
      }).from(clockSegments)
        .where(eq(clockSegments.clock_id, clockId))
        .orderBy(clockSegments.sort_order);
      allSegsByClockId.set(clockId, rows);
    }

    // Index assignments and overrides by slot key
    const assignmentKey = (a: { date: string; time_start: string; clock_id: number; segment_index: number }) =>
      `${a.date}|${a.time_start}|${a.clock_id}|${a.segment_index}`;
    const assignmentMap = new Map(assignmentRows.map((a) => [assignmentKey(a), a]));
    const overrideMap = new Map(overrideRows.map((o) => [assignmentKey(o), o]));

    // Index show_content by clock instance + segment_type
    // showContentMap[instanceKey][segment_type] = { id, playlist_id, playlist_name }
    const showContentMap = new Map<string, Record<string, { id: number; playlist_id: number | null; playlist_name: string | null }>>();
    for (const sc of showContentRows) {
      const k = `${sc.date}|${sc.time_start}|${sc.clock_id}`;
      if (!showContentMap.has(k)) showContentMap.set(k, {});
      showContentMap.get(k)![sc.segment_type] = { id: sc.id, playlist_id: sc.playlist_id, playlist_name: sc.playlist_name };
    }

    // Build result
    const result: object[] = [];

    for (const slot of slots) {
      const allSegs = allSegsByClockId.get(slot.clock_id) ?? [];
      for (let segIdx = 0; segIdx < allSegs.length; segIdx++) {
        const seg = allSegs[segIdx];
        if (!RUNDOWN_SEGMENT_TYPES.includes(seg.type as any)) continue;

        const key = `${slot.date}|${slot.time_start}|${slot.clock_id}|${segIdx}`;
        const assignment = assignmentMap.get(key) ?? null;
        const override = overrideMap.get(key) ?? null;
        const templateDur = seg.duration_seconds;
        const effectiveDur = override?.duration_seconds ?? assignment?.media_duration_seconds ?? templateDur;

        const instanceKey = `${slot.date}|${slot.time_start}|${slot.clock_id}`;
        const showContent = showContentMap.get(instanceKey) ?? {};

        result.push({
          date: slot.date,
          time_start: slot.time_start,
          clock_id: slot.clock_id,
          clock_name: clockNameMap.get(slot.clock_id) ?? '',
          segment_index: segIdx,
          segment_id: seg.id,
          segment_name: seg.name,
          segment_type: seg.type,
          template_duration_seconds: templateDur,
          fallback_playlist_id: seg.fallback_playlist_id ?? null,
          assignment: assignment ? {
            id: assignment.id,
            media_id: assignment.media_id,
            media_title: assignment.media_title,
            media_artist: assignment.media_artist,
            media_duration_seconds: assignment.media_duration_seconds,
            media_original_filename: assignment.media_original_filename,
            notes: assignment.notes,
            assigned_at: assignment.assigned_at,
          } : null,
          duration_override_id: override?.id ?? null,
          duration_override_seconds: override?.duration_seconds ?? null,
          is_assigned: assignment?.media_id != null,
          effective_duration_seconds: effectiveDur,
          // Per-type show content for this clock instance (news/bulletin)
          show_content: showContent,
          // All segments in this clock instance (for the mini timeline)
          clock_segments: allSegs,
        });
      }
    }

    return reply.send(result);
  });

  // PUT /rundown/assignments — upsert
  fastify.put<{ Body: unknown }>('/rundown/assignments', async (request, reply) => {
    const parsed = RundownAssignmentUpsertSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const { date, time_start, clock_id, segment_index, media_id, notes } = parsed.data;

    const [row] = await db
      .insert(rundownAssignments)
      .values({ date, time_start, clock_id, segment_index, media_id: media_id ?? null, notes: notes ?? null, assigned_at: new Date() })
      .onConflictDoUpdate({
        target: [rundownAssignments.date, rundownAssignments.time_start, rundownAssignments.clock_id, rundownAssignments.segment_index],
        set: { media_id: media_id ?? null, notes: notes ?? null, assigned_at: new Date(), updated_at: new Date() },
      })
      .returning();

    // Join media info for the response
    if (row.media_id) {
      const [m] = await db.select().from(media).where(eq(media.id, row.media_id));
      return reply.send({ ...row, media: m ?? null });
    }
    return reply.send({ ...row, media: null });
  });

  // DELETE /rundown/assignments/:id
  fastify.delete<{ Params: { id: string } }>('/rundown/assignments/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(rundownAssignments).where(eq(rundownAssignments.id, id));
    return reply.status(204).send();
  });

  // PUT /rundown/duration-overrides — upsert
  fastify.put<{ Body: unknown }>('/rundown/duration-overrides', async (request, reply) => {
    const parsed = RundownDurationOverrideUpsertSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const { date, time_start, clock_id, segment_index, duration_seconds } = parsed.data;

    const [row] = await db
      .insert(rundownDurationOverrides)
      .values({ date, time_start, clock_id, segment_index, duration_seconds })
      .onConflictDoUpdate({
        target: [rundownDurationOverrides.date, rundownDurationOverrides.time_start, rundownDurationOverrides.clock_id, rundownDurationOverrides.segment_index],
        set: { duration_seconds, updated_at: new Date() },
      })
      .returning();
    return reply.send(row);
  });

  // DELETE /rundown/duration-overrides/:id
  fastify.delete<{ Params: { id: string } }>('/rundown/duration-overrides/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(rundownDurationOverrides).where(eq(rundownDurationOverrides.id, id));
    return reply.status(204).send();
  });

  // GET /rundown/slot-content?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
  // Lightweight flat list of rundown_show_content rows for the date range — used by the
  // calendar schedule view to compute per-slot satisfaction state.
  fastify.get<{ Querystring: { date_from: string; date_to: string } }>('/rundown/slot-content', async (request, reply) => {
    const { date_from, date_to } = request.query;
    if (!date_from || !date_to) return reply.status(400).send({ error: 'date_from and date_to required' });

    const rows = await db
      .select({
        id: rundownShowContent.id,
        date: rundownShowContent.date,
        time_start: rundownShowContent.time_start,
        clock_id: rundownShowContent.clock_id,
        segment_type: rundownShowContent.segment_type,
        playlist_id: rundownShowContent.playlist_id,
        playlist_name: playlists.name,
      })
      .from(rundownShowContent)
      .leftJoin(playlists, eq(rundownShowContent.playlist_id, playlists.id))
      .where(and(
        gte(rundownShowContent.date, date_from),
        lte(rundownShowContent.date, date_to),
      ));

    return reply.send(rows);
  });

  // PUT /rundown/show-content — upsert a playlist for a segment type in a clock instance
  fastify.put<{ Body: unknown }>('/rundown/show-content', async (request, reply) => {
    const parsed = RundownShowContentUpsertSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const { date, time_start, clock_id, segment_type, playlist_id } = parsed.data;

    const [row] = await db
      .insert(rundownShowContent)
      .values({ date, time_start, clock_id, segment_type, playlist_id, assigned_at: new Date() })
      .onConflictDoUpdate({
        target: [rundownShowContent.date, rundownShowContent.time_start, rundownShowContent.clock_id, rundownShowContent.segment_type],
        set: { playlist_id, assigned_at: new Date(), updated_at: new Date() },
      })
      .returning();

    const [pl] = await db.select({ id: playlists.id, name: playlists.name }).from(playlists).where(eq(playlists.id, playlist_id));
    return reply.send({ ...row, playlist_name: pl?.name ?? null });
  });

  // DELETE /rundown/show-content/:id
  fastify.delete<{ Params: { id: string } }>('/rundown/show-content/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(rundownShowContent).where(eq(rundownShowContent.id, id));
    return reply.status(204).send();
  });
}
