import { FastifyInstance } from 'fastify';
import { eq, asc, sql } from 'drizzle-orm';
import {
  ShowCreateSchema,
  ShowPatchSchema,
  ShowPlaylistCreateSchema,
  ShowPlaylistPatchSchema,
} from '@radio/shared';
import { db } from '../db/index.js';
import { shows, showPlaylists, playlists } from '../db/schema.js';

export async function showRoutes(fastify: FastifyInstance) {
  fastify.get('/shows', async (_request, reply) => {
    const rows = await db.select().from(shows).orderBy(asc(shows.name));
    return reply.send(rows);
  });

  fastify.post<{ Body: unknown }>('/shows', async (request, reply) => {
    const parsed = ShowCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [show] = await db.insert(shows).values({
      name: parsed.data.name,
      host: parsed.data.host ?? null,
      producer: parsed.data.producer ?? null,
      default_clock_id: parsed.data.default_clock_id ?? null,
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

  // ── Show playlists (music) ────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/shows/:id/playlists', async (request, reply) => {
    const showId = Number(request.params.id);
    const rows = await db
      .select({
        id: showPlaylists.id,
        show_id: showPlaylists.show_id,
        playlist_id: showPlaylists.playlist_id,
        playlist_name: playlists.name,
        weight: showPlaylists.weight,
        sort_order: showPlaylists.sort_order,
        rotation_tier: showPlaylists.rotation_tier,
        rotation_id: showPlaylists.rotation_id,
        fallback_tier: showPlaylists.fallback_tier,
      })
      .from(showPlaylists)
      .innerJoin(playlists, eq(showPlaylists.playlist_id, playlists.id))
      .where(eq(showPlaylists.show_id, showId))
      .orderBy(asc(showPlaylists.sort_order));
    return reply.send(rows);
  });

  fastify.post<{ Params: { id: string }; Body: unknown }>('/shows/:id/playlists', async (request, reply) => {
    const showId = Number(request.params.id);
    const parsed = ShowPlaylistCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });

    const [row] = await db.insert(showPlaylists).values({
      show_id: showId,
      playlist_id: parsed.data.playlist_id,
      weight: parsed.data.weight ?? 1,
      rotation_tier: parsed.data.rotation_tier ?? null,
      rotation_id: parsed.data.rotation_id ?? null,
      fallback_tier: parsed.data.fallback_tier ?? null,
      sort_order: parsed.data.sort_order ?? 0,
    }).returning();

    const [withName] = await db
      .select({
        id: showPlaylists.id,
        show_id: showPlaylists.show_id,
        playlist_id: showPlaylists.playlist_id,
        playlist_name: playlists.name,
        weight: showPlaylists.weight,
        sort_order: showPlaylists.sort_order,
        rotation_tier: showPlaylists.rotation_tier,
        rotation_id: showPlaylists.rotation_id,
        fallback_tier: showPlaylists.fallback_tier,
      })
      .from(showPlaylists)
      .innerJoin(playlists, eq(showPlaylists.playlist_id, playlists.id))
      .where(eq(showPlaylists.id, row.id));

    return reply.status(201).send(withName);
  });

  fastify.patch<{ Params: { id: string; spid: string }; Body: unknown }>(
    '/shows/:id/playlists/:spid',
    async (request, reply) => {
      const spid = Number(request.params.spid);
      const parsed = ShowPlaylistPatchSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });

      await db.update(showPlaylists).set(parsed.data).where(eq(showPlaylists.id, spid));

      const [withName] = await db
        .select({
          id: showPlaylists.id,
          show_id: showPlaylists.show_id,
          playlist_id: showPlaylists.playlist_id,
          playlist_name: playlists.name,
          weight: showPlaylists.weight,
          sort_order: showPlaylists.sort_order,
          rotation_tier: showPlaylists.rotation_tier,
          rotation_id: showPlaylists.rotation_id,
          fallback_tier: showPlaylists.fallback_tier,
        })
        .from(showPlaylists)
        .innerJoin(playlists, eq(showPlaylists.playlist_id, playlists.id))
        .where(eq(showPlaylists.id, spid));

      if (!withName) return reply.status(404).send({ error: 'Show playlist not found' });
      return reply.send(withName);
    },
  );

  fastify.delete<{ Params: { id: string; spid: string } }>(
    '/shows/:id/playlists/:spid',
    async (request, reply) => {
      const spid = Number(request.params.spid);
      await db.delete(showPlaylists).where(eq(showPlaylists.id, spid));
      return reply.status(204).send();
    },
  );
}
