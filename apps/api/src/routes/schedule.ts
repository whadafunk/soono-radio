import { FastifyInstance } from 'fastify';
import { eq, and, gte, lte, sql } from 'drizzle-orm';
import {
  TemplateEntryCreateSchema,
  TemplateEntryPatchSchema,
  CalendarEntryCreateSchema,
  CalendarEntryPatchSchema,
  TemplateClockEntryUpsertSchema,
} from '@radio/shared';
import { db } from '../db/index.js';
import { templateEntries, calendarEntries, templateClockEntries } from '../db/schema.js';

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
}
