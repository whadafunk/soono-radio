import { FastifyInstance } from 'fastify';
import { eq, and, gte, lte, sql } from 'drizzle-orm';
import {
  TemplateEntryCreateSchema,
  TemplateEntryPatchSchema,
  CalendarEntryCreateSchema,
  CalendarEntryPatchSchema,
  TemplateClockEntryUpsertSchema,
  ApplyTemplateSchema,
} from '@radio/shared';
import { db } from '../db/index.js';
import { templateEntries, calendarEntries, templateClockEntries } from '../db/schema.js';

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
    const [entry] = await db.insert(templateEntries).values({
      day_of_week: parsed.data.day_of_week,
      time_start: parsed.data.time_start,
      time_end: parsed.data.time_end,
      show_id: parsed.data.show_id ?? null,
      clock_id: parsed.data.clock_id ?? null,
    }).returning();
    return reply.status(201).send(entry);
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/template-entries/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = TemplateEntryPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [updated] = await db.update(templateEntries)
      .set(parsed.data)
      .where(eq(templateEntries.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Template entry not found' });
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/template-entries/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(templateEntries).where(eq(templateEntries.id, id));
    return reply.status(204).send();
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
    const [entry] = await db.insert(calendarEntries).values({
      date: parsed.data.date,
      time_start: parsed.data.time_start,
      time_end: parsed.data.time_end,
      show_id: parsed.data.show_id ?? null,
      clock_id: parsed.data.clock_id ?? null,
      is_override: parsed.data.is_override ?? false,
    }).returning();
    return reply.status(201).send(entry);
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/calendar-entries/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = CalendarEntryPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [updated] = await db.update(calendarEntries)
      .set(parsed.data)
      .where(eq(calendarEntries.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Calendar entry not found' });
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/calendar-entries/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(calendarEntries).where(eq(calendarEntries.id, id));
    return reply.status(204).send();
  });

  fastify.delete('/calendar-entries', async (_req, reply) => {
    await db.delete(calendarEntries);
    return reply.status(204).send();
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
      return reply.send(updated);
    }
    const [created] = await db.insert(templateClockEntries).values({
      day_of_week: parsed.data.day_of_week,
      hour: parsed.data.hour,
      clock_id: parsed.data.clock_id,
    }).returning();
    return reply.status(201).send(created);
  });

  fastify.delete<{ Params: { id: string } }>('/template-clock-entries/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(templateClockEntries).where(eq(templateClockEntries.id, id));
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

    return reply.send({ created: toInsert.length, skipped, deleted });
  });
}
