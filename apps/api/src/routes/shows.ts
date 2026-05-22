import { FastifyInstance } from 'fastify';
import { eq, asc, sql, and, ne } from 'drizzle-orm';
import {
  ShowCreateSchema,
  ShowPatchSchema,
  ShowPlaylistCreateSchema,
  ShowPlaylistPatchSchema,
} from '@radio/shared';
import { db } from '../db/index.js';
import { shows, showPlaylists, playlists, templateEntries, calendarEntries, templateClockEntries, campaigns, customers } from '../db/schema.js';

async function validateClockForShowAssignment(clockId: number): Promise<string | null> {
  const [te] = await db.select({ id: templateEntries.id })
    .from(templateEntries).where(eq(templateEntries.clock_id, clockId)).limit(1);
  if (te) return 'Clock is scheduled in the template and cannot be assigned to a show.';
  const [tce] = await db.select({ id: templateClockEntries.id })
    .from(templateClockEntries).where(eq(templateClockEntries.clock_id, clockId)).limit(1);
  if (tce) return 'Clock is scheduled in the template and cannot be assigned to a show.';
  const [ce] = await db.select({ id: calendarEntries.id })
    .from(calendarEntries).where(eq(calendarEntries.clock_id, clockId)).limit(1);
  if (ce) return 'Clock has individual calendar entries and cannot be assigned to a show.';
  return null;
}

export async function showRoutes(fastify: FastifyInstance) {
  fastify.get('/shows', async (_request, reply) => {
    const rows = await db.select().from(shows).orderBy(asc(shows.name));
    return reply.send(rows);
  });

  fastify.post<{ Body: unknown }>('/shows', async (request, reply) => {
    const parsed = ShowCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    if (parsed.data.default_clock_id != null) {
      const [conflict] = await db.select({ id: shows.id, name: shows.name })
        .from(shows).where(eq(shows.default_clock_id, parsed.data.default_clock_id));
      if (conflict) return reply.status(409).send({
        error: `Clock is already assigned to "${conflict.name}". A clock can only be used by one show.`,
        conflicting_show: { id: conflict.id, name: conflict.name },
      });
      const schedErr = await validateClockForShowAssignment(parsed.data.default_clock_id);
      if (schedErr) return reply.status(409).send({ error: schedErr });
    }
    const [show] = await db.insert(shows).values({
      name: parsed.data.name,
      host: parsed.data.host ?? null,
      producer: parsed.data.producer ?? null,
      default_clock_id: parsed.data.default_clock_id ?? null,
      duration_minutes: parsed.data.duration_minutes ?? 60,
      extension_policy: parsed.data.extension_policy ?? null,
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
    if (parsed.data.default_clock_id != null) {
      const [conflict] = await db.select({ id: shows.id, name: shows.name })
        .from(shows).where(and(eq(shows.default_clock_id, parsed.data.default_clock_id), ne(shows.id, id)));
      if (conflict) return reply.status(409).send({
        error: `Clock is already assigned to "${conflict.name}". A clock can only be used by one show.`,
        conflicting_show: { id: conflict.id, name: conflict.name },
      });
      const schedErr = await validateClockForShowAssignment(parsed.data.default_clock_id);
      if (schedErr) return reply.status(409).send({ error: schedErr });
    }
    const [updated] = await db.update(shows)
      .set({ ...parsed.data, updated_at: sql`(unixepoch())` })
      .where(eq(shows.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Show not found' });
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/shows/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const [show] = await db.select({ name: shows.name }).from(shows).where(eq(shows.id, id));
    if (show) {
      await db.update(templateEntries).set({ orphaned_show_name: show.name }).where(eq(templateEntries.show_id, id));
      await db.update(calendarEntries).set({ orphaned_show_name: show.name }).where(eq(calendarEntries.show_id, id));
    }
    await db.update(campaigns).set({ show_id: null }).where(eq(campaigns.show_id, id));
    await db.delete(showPlaylists).where(eq(showPlaylists.show_id, id));
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

  fastify.get<{ Params: { id: string } }>('/shows/:id/campaigns', async (request, reply) => {
    const showId = Number(request.params.id);
    const rows = await db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        customer_id: campaigns.customer_id,
        customer_name: customers.name,
        plays_per_show: campaigns.plays_per_show,
        active: campaigns.active,
      })
      .from(campaigns)
      .innerJoin(customers, eq(campaigns.customer_id, customers.id))
      .where(eq(campaigns.show_id, showId));
    return reply.send(rows);
  });
}
