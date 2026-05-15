import { FastifyInstance } from 'fastify';
import { and, eq, ne, sql } from 'drizzle-orm';
import { RotationCreateSchema, RotationPatchSchema } from '@radio/shared';
import { db } from '../db/index.js';
import { rotations } from '../db/schema.js';

export async function rotationRoutes(fastify: FastifyInstance) {
  fastify.get('/rotations', async (_req, reply) => {
    const rows = await db.select().from(rotations);
    return reply.send(rows);
  });

  fastify.post<{ Body: unknown }>('/rotations', async (request, reply) => {
    const parsed = RotationCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const kind = parsed.data.kind ?? 'music';
    if (parsed.data.is_default) {
      await db.update(rotations).set({ is_default: false }).where(eq(rotations.kind, kind));
    }
    const [rotation] = await db.insert(rotations).values({
      name: parsed.data.name,
      kind,
      type: parsed.data.type,
      song_position: parsed.data.song_position ?? null,
      params: parsed.data.params ?? {},
      is_default: parsed.data.is_default ?? false,
    }).returning();
    return reply.status(201).send(rotation);
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/rotations/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = RotationPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    if (parsed.data.is_default) {
      const [existing] = await db.select({ kind: rotations.kind }).from(rotations).where(eq(rotations.id, id));
      if (!existing) return reply.status(404).send({ error: 'Rotation not found' });
      const kind = parsed.data.kind ?? existing.kind;
      await db.update(rotations).set({ is_default: false }).where(and(eq(rotations.kind, kind), ne(rotations.id, id)));
    }
    const [updated] = await db.update(rotations)
      .set({ ...parsed.data, updated_at: sql`(unixepoch())` })
      .where(eq(rotations.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Rotation not found' });
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/rotations/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(rotations).where(eq(rotations.id, id));
    return reply.status(204).send();
  });
}
