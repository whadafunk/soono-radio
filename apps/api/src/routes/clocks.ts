import { FastifyInstance } from 'fastify';
import { eq, asc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ClockCreateSchema, ClockPatchSchema, ClockSegmentCreateSchema } from '@radio/shared';
import { db } from '../db/index.js';
import { clocks, clockSegments } from '../db/schema.js';

export async function clockRoutes(fastify: FastifyInstance) {
  fastify.get('/clocks', async (_req, reply) => {
    const rows = await db
      .select({
        id: clocks.id,
        name: clocks.name,
        description: clocks.description,
        sweep_config: clocks.sweep_config,
        duration_seconds: sql<number>`COALESCE(SUM(${clockSegments.duration_seconds}), 0)`,
        created_at: clocks.created_at,
        updated_at: clocks.updated_at,
      })
      .from(clocks)
      .leftJoin(clockSegments, eq(clockSegments.clock_id, clocks.id))
      .groupBy(clocks.id)
      .orderBy(asc(clocks.name));
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
    const [clock] = await db
      .select({
        id: clocks.id,
        name: clocks.name,
        description: clocks.description,
        sweep_config: clocks.sweep_config,
        duration_seconds: sql<number>`COALESCE(SUM(${clockSegments.duration_seconds}), 0)`,
        created_at: clocks.created_at,
        updated_at: clocks.updated_at,
      })
      .from(clocks)
      .leftJoin(clockSegments, eq(clockSegments.clock_id, clocks.id))
      .where(eq(clocks.id, id))
      .groupBy(clocks.id);
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
          sources: s.sources ?? [],
          filler_playlist_id: s.filler_playlist_id ?? null,
          start_clip_playlist_id: s.start_clip_playlist_id ?? null,
          end_clip_playlist_id: s.end_clip_playlist_id ?? null,
          bed_playlist_id: s.bed_playlist_id ?? null,
          interstitial_jingle_playlist_id: s.interstitial_jingle_playlist_id ?? null,
          jingle_every_n_tracks: s.jingle_every_n_tracks ?? null,
          start_policy: s.start_policy ?? { type: 'soft', plus_seconds: 30, minus_seconds: 0 },
          trailing_time: s.trailing_time ?? [],
          recovery_tactics: s.recovery_tactics ?? [],
          accept_live: s.accept_live ?? true,
          accept_sweepers: s.accept_sweepers ?? [],
          silence_detection_action: s.silence_detection_action ?? null,
          rotation_type: s.rotation_type ?? null,
        })),
      );
    }

    const rows = await db.select().from(clockSegments)
      .where(eq(clockSegments.clock_id, id))
      .orderBy(asc(clockSegments.sort_order));
    return reply.send(rows);
  });
}
