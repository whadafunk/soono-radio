import { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { PromoCreateSchema, PromoPatchSchema } from '@radio/shared';
import { db } from '../db/index.js';
import { promos, promoMedia, media, shows } from '../db/schema.js';

const promoSelect = {
  id: promos.id,
  name: promos.name,
  show_id: promos.show_id,
  starts_on: promos.starts_on,
  ends_on: promos.ends_on,
  min_plays_per_day: promos.min_plays_per_day,
  max_plays_per_day: promos.max_plays_per_day,
  no_air_during_show: promos.no_air_during_show,
  active: promos.active,
  notes: promos.notes,
  created_at: promos.created_at,
  updated_at: promos.updated_at,
  show_name: shows.name,
} as const;

export async function promoRoutes(fastify: FastifyInstance) {
  // ─── Promos ────────────────────────────────────────────────────────────────

  fastify.get('/promos', async (_request, reply) => {
    const rows = await db
      .select(promoSelect)
      .from(promos)
      .leftJoin(shows, eq(promos.show_id, shows.id))
      .orderBy(promos.name);
    return reply.send(rows);
  });

  fastify.post<{ Body: unknown }>('/promos', async (request, reply) => {
    const parsed = PromoCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [promo] = await db
      .insert(promos)
      .values({
        name: parsed.data.name,
        show_id: parsed.data.show_id ?? null,
        starts_on: parsed.data.starts_on,
        ends_on: parsed.data.ends_on,
        min_plays_per_day: parsed.data.min_plays_per_day ?? 1,
        max_plays_per_day: parsed.data.max_plays_per_day ?? 3,
        no_air_during_show: parsed.data.no_air_during_show ?? false,
        notes: parsed.data.notes ?? null,
      })
      .returning();
    return reply.status(201).send({ ...promo, show_name: null });
  });

  fastify.get<{ Params: { id: string } }>('/promos/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const [row] = await db
      .select(promoSelect)
      .from(promos)
      .leftJoin(shows, eq(promos.show_id, shows.id))
      .where(eq(promos.id, id));
    if (!row) return reply.status(404).send({ error: 'Promo not found' });
    return reply.send(row);
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/promos/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = PromoPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [updated] = await db
      .update(promos)
      .set({ ...parsed.data, updated_at: sql`(unixepoch())` })
      .where(eq(promos.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Promo not found' });
    const [row] = await db
      .select(promoSelect)
      .from(promos)
      .leftJoin(shows, eq(promos.show_id, shows.id))
      .where(eq(promos.id, id));
    return reply.send(row);
  });

  fastify.delete<{ Params: { id: string } }>('/promos/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(promos).where(eq(promos.id, id));
    return reply.status(204).send();
  });

  // ─── Promo Media ──────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/promos/:id/media', async (request, reply) => {
    const promoId = Number(request.params.id);
    const rows = await db
      .select({
        id: promoMedia.id,
        promo_id: promoMedia.promo_id,
        media_id: promoMedia.media_id,
        created_at: promoMedia.created_at,
        title: media.title,
        artist: media.artist,
        duration_seconds: media.duration_seconds,
        original_filename: media.original_filename,
      })
      .from(promoMedia)
      .leftJoin(media, eq(promoMedia.media_id, media.id))
      .where(eq(promoMedia.promo_id, promoId));
    return reply.send(rows);
  });

  fastify.post<{ Params: { id: string }; Body: { media_id: number } }>(
    '/promos/:id/media',
    async (request, reply) => {
      const promoId = Number(request.params.id);
      if (!request.body?.media_id) return reply.status(400).send({ error: 'media_id required' });
      const [entry] = await db
        .insert(promoMedia)
        .values({ promo_id: promoId, media_id: request.body.media_id })
        .returning();
      const [withMedia] = await db
        .select({
          id: promoMedia.id,
          promo_id: promoMedia.promo_id,
          media_id: promoMedia.media_id,
          created_at: promoMedia.created_at,
          title: media.title,
          artist: media.artist,
          duration_seconds: media.duration_seconds,
          original_filename: media.original_filename,
        })
        .from(promoMedia)
        .leftJoin(media, eq(promoMedia.media_id, media.id))
        .where(eq(promoMedia.id, entry.id));
      return reply.status(201).send(withMedia);
    },
  );

  fastify.delete<{ Params: { id: string } }>('/promo-media/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(promoMedia).where(eq(promoMedia.id, id));
    return reply.status(204).send();
  });
}
