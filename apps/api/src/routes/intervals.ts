import { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import {
  BroadcastIntervalCreateSchema,
  BroadcastIntervalPatchSchema,
  BroadcastIntervalSlotCreateSchema,
  BroadcastIntervalSlotPatchSchema,
} from '@radio/shared';
import { db } from '../db/index.js';
import { broadcastIntervals, broadcastIntervalSlots } from '../db/schema.js';

export async function intervalRoutes(fastify: FastifyInstance) {
  // ── Intervals (named dayparts) ──────────────────────────────────────────────

  fastify.get('/intervals', async (_request, reply) => {
    const rows = await db.select().from(broadcastIntervals).orderBy(broadcastIntervals.default_start_time);
    return reply.send(rows);
  });

  fastify.post<{ Body: unknown }>('/intervals', async (request, reply) => {
    const parsed = BroadcastIntervalCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [row] = await db.insert(broadcastIntervals).values(parsed.data).returning();
    return reply.status(201).send(row);
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/intervals/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = BroadcastIntervalPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [updated] = await db.update(broadcastIntervals)
      .set({ ...parsed.data, updated_at: sql`(unixepoch())` })
      .where(eq(broadcastIntervals.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Interval not found' });
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/intervals/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(broadcastIntervals).where(eq(broadcastIntervals.id, id));
    return reply.status(204).send();
  });

  // ── Interval slots (per-day assignments) ───────────────────────────────────

  fastify.get('/interval-slots', async (_request, reply) => {
    const rows = await db.select().from(broadcastIntervalSlots)
      .orderBy(broadcastIntervalSlots.interval_id, broadcastIntervalSlots.day_of_week);
    return reply.send(rows);
  });

  fastify.post<{ Body: unknown }>('/interval-slots', async (request, reply) => {
    const parsed = BroadcastIntervalSlotCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [row] = await db.insert(broadcastIntervalSlots).values(parsed.data).returning();
    return reply.status(201).send(row);
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/interval-slots/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = BroadcastIntervalSlotPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [updated] = await db.update(broadcastIntervalSlots)
      .set(parsed.data)
      .where(eq(broadcastIntervalSlots.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Slot not found' });
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/interval-slots/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(broadcastIntervalSlots).where(eq(broadcastIntervalSlots.id, id));
    return reply.status(204).send();
  });
}
