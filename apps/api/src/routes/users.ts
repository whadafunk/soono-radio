import { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { UserCreateSchema, UserPatchSchema } from '@radio/shared';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';

export async function userRoutes(fastify: FastifyInstance) {
  fastify.get('/users', async (_req, reply) => {
    const rows = await db.select().from(users);
    return reply.send(rows);
  });

  fastify.post<{ Body: unknown }>('/users', async (request, reply) => {
    const parsed = UserCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [user] = await db.insert(users).values({
      first_name: parsed.data.first_name,
      last_name: parsed.data.last_name,
      account_name: parsed.data.account_name ?? null,
      email: parsed.data.email ?? null,
      title: parsed.data.title ?? null,
    }).returning();
    return reply.status(201).send(user);
  });

  fastify.get<{ Params: { id: string } }>('/users/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const [user] = await db.select().from(users).where(eq(users.id, id));
    if (!user) return reply.status(404).send({ error: 'User not found' });
    return reply.send(user);
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/users/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = UserPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [updated] = await db.update(users)
      .set({ ...parsed.data, updated_at: sql`(unixepoch())` })
      .where(eq(users.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'User not found' });
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/users/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(users).where(eq(users.id, id));
    return reply.status(204).send();
  });
}
