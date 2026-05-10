import { FastifyInstance } from 'fastify';
import { eq, asc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ClockCreateSchema, ClockPatchSchema, ClockSegmentCreateSchema } from '@radio/shared';
import { db } from '../db/index.js';
import { clocks, clockSegments } from '../db/schema.js';

export async function clockRoutes(fastify: FastifyInstance) {
  fastify.get('/clocks', async (_req, reply) => {
    const rows = await db.select().from(clocks).orderBy(asc(clocks.name));
    return reply.send(rows);
  });

  fastify.post<{ Body: unknown }>('/clocks', async (request, reply) => {
    const parsed = ClockCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [clock] = await db.insert(clocks).values({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      sweep_config: parsed.data.sweep_config ?? null,
    }).returning();
    return reply.status(201).send(clock);
  });

  fastify.get<{ Params: { id: string } }>('/clocks/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const [clock] = await db.select().from(clocks).where(eq(clocks.id, id));
    if (!clock) return reply.status(404).send({ error: 'Clock not found' });
    return reply.send(clock);
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/clocks/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = ClockPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [updated] = await db.update(clocks)
      .set({ ...parsed.data, updated_at: sql`(unixepoch())` })
      .where(eq(clocks.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Clock not found' });
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/clocks/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(clocks).where(eq(clocks.id, id));
    return reply.status(204).send();
  });

  fastify.get<{ Params: { id: string } }>('/clocks/:id/segments', async (request, reply) => {
    const id = Number(request.params.id);
    const rows = await db.select().from(clockSegments)
      .where(eq(clockSegments.clock_id, id))
      .orderBy(asc(clockSegments.sort_order));
    return reply.send(rows);
  });

  fastify.put<{ Params: { id: string }; Body: unknown }>('/clocks/:id/segments', async (request, reply) => {
    const id = Number(request.params.id);
    const [clock] = await db.select().from(clocks).where(eq(clocks.id, id));
    if (!clock) return reply.status(404).send({ error: 'Clock not found' });

    const parsed = z.array(ClockSegmentCreateSchema).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });

    await db.delete(clockSegments).where(eq(clockSegments.clock_id, id));
    if (parsed.data.length > 0) {
      await db.insert(clockSegments).values(
        parsed.data.map((s, i) => ({
          clock_id: id,
          sort_order: i,
          name: s.name,
          type: s.type,
          duration_seconds: s.duration_seconds,
          source_type: s.source_type,
          source_playlist_id: s.source_playlist_id ?? null,
          source_rotation_id: s.source_rotation_id ?? null,
          source_tier: s.source_tier ?? null,
          filler_sources: s.filler_sources ?? [],
          mix_ratio: s.mix_ratio ?? null,
          fallback_source: s.fallback_source ?? null,
          start_clip_playlist_id: s.start_clip_playlist_id ?? null,
          end_clip_playlist_id: s.end_clip_playlist_id ?? null,
          bed_playlist_id: s.bed_playlist_id ?? null,
          blocks_live_override: s.blocks_live_override ?? false,
          delay_policy: s.delay_policy ?? { type: 'soft', plus_seconds: 30, minus_seconds: 0 },
          recovery_tactics: s.recovery_tactics ?? [],
        })),
      );
    }

    const rows = await db.select().from(clockSegments)
      .where(eq(clockSegments.clock_id, id))
      .orderBy(asc(clockSegments.sort_order));
    return reply.send(rows);
  });
}
