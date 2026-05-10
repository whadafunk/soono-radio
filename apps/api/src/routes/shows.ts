import { FastifyInstance } from 'fastify';
import { eq, asc, sql } from 'drizzle-orm';
import { ShowCreateSchema, ShowPatchSchema } from '@radio/shared';
import { db } from '../db/index.js';
import { shows } from '../db/schema.js';

export async function showRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { active?: string } }>('/shows', async (request, reply) => {
    const rows = await db.select().from(shows).orderBy(asc(shows.name));
    const { active } = request.query;
    if (active === 'true') return reply.send(rows.filter((s) => s.active));
    if (active === 'false') return reply.send(rows.filter((s) => !s.active));
    return reply.send(rows);
  });

  fastify.post<{ Body: unknown }>('/shows', async (request, reply) => {
    const parsed = ShowCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [show] = await db.insert(shows).values({
      name: parsed.data.name,
      host: parsed.data.host ?? null,
      producer: parsed.data.producer ?? null,
      type: parsed.data.type ?? 'automated',
      default_clock_id: parsed.data.default_clock_id ?? null,
      intro_media_id: parsed.data.intro_media_id ?? null,
      outro_media_id: parsed.data.outro_media_id ?? null,
      duration_minutes: parsed.data.duration_minutes ?? 60,
      color: parsed.data.color ?? 'indigo',
      notes: parsed.data.notes ?? null,
    }).returning();
    return reply.status(201).send(show);
  });

  fastify.get<{ Params: { id: string } }>('/shows/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const [show] = await db.select().from(shows).where(eq(shows.id, id));
    if (!show) return reply.status(404).send({ error: 'Show not found' });
    return reply.send(show);
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/shows/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = ShowPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [updated] = await db.update(shows)
      .set({ ...parsed.data, updated_at: sql`(unixepoch())` })
      .where(eq(shows.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Show not found' });
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/shows/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(shows).where(eq(shows.id, id));
    return reply.status(204).send();
  });
}
