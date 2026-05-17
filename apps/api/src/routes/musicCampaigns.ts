import { FastifyInstance } from 'fastify';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { MusicCampaignCreateSchema, MusicCampaignPatchSchema } from '@radio/shared';
import { db } from '../db/index.js';
import {
  customers,
  musicCampaigns,
  playHistory,
  playlists,
} from '../db/schema.js';

export async function musicCampaignRoutes(fastify: FastifyInstance) {
  // ─── List ───────────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { customer_id?: string; active?: string } }>(
    '/music-campaigns',
    async (request, reply) => {
      const { customer_id, active } = request.query;
      const conditions = [] as any[];
      if (customer_id) conditions.push(eq(musicCampaigns.customer_id, Number(customer_id)));
      if (active === 'true') conditions.push(eq(musicCampaigns.active, true));
      if (active === 'false') conditions.push(eq(musicCampaigns.active, false));
      const rows =
        conditions.length > 0
          ? await db.select().from(musicCampaigns).where(and(...conditions))
          : await db.select().from(musicCampaigns);

      // Join customer + playlist names for the UI list view.
      const customerIds = [...new Set(rows.map((r) => r.customer_id))];
      const playlistIds = [...new Set(rows.map((r) => r.playlist_id))];
      const [customerRows, playlistRows] = await Promise.all([
        customerIds.length > 0
          ? db.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, customerIds))
          : Promise.resolve([] as Array<{ id: number; name: string }>),
        playlistIds.length > 0
          ? db.select({ id: playlists.id, name: playlists.name }).from(playlists).where(inArray(playlists.id, playlistIds))
          : Promise.resolve([] as Array<{ id: number; name: string }>),
      ]);
      const customerName = new Map(customerRows.map((c) => [c.id, c.name]));
      const playlistName = new Map(playlistRows.map((p) => [p.id, p.name]));
      return reply.send(
        rows.map((c) => ({
          ...c,
          customer_name: customerName.get(c.customer_id) ?? 'Unknown',
          playlist_name: playlistName.get(c.playlist_id) ?? 'Unknown',
        })),
      );
    },
  );

  // ─── Detail ─────────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/music-campaigns/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const [row] = await db.select().from(musicCampaigns).where(eq(musicCampaigns.id, id));
    if (!row) return reply.status(404).send({ error: 'Music campaign not found' });
    return reply.send(row);
  });

  // ─── Create ─────────────────────────────────────────────────────────────────
  fastify.post<{ Body: unknown }>('/music-campaigns', async (request, reply) => {
    const parsed = MusicCampaignCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [row] = await db
      .insert(musicCampaigns)
      .values({
        customer_id: parsed.data.customer_id,
        name: parsed.data.name,
        playlist_id: parsed.data.playlist_id,
        starts_on: parsed.data.starts_on,
        ends_on: parsed.data.ends_on,
        plays_per_day: parsed.data.plays_per_day,
        notes: parsed.data.notes ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  // ─── Update ─────────────────────────────────────────────────────────────────
  fastify.patch<{ Params: { id: string }; Body: unknown }>(
    '/music-campaigns/:id',
    async (request, reply) => {
      const id = Number(request.params.id);
      const parsed = MusicCampaignPatchSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
      const [updated] = await db
        .update(musicCampaigns)
        .set({ ...parsed.data, updated_at: sql`(unixepoch())` })
        .where(eq(musicCampaigns.id, id))
        .returning();
      if (!updated) return reply.status(404).send({ error: 'Music campaign not found' });
      return reply.send(updated);
    },
  );

  // ─── Delete ─────────────────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/music-campaigns/:id', async (request, reply) => {
    const id = Number(request.params.id);
    await db.delete(musicCampaigns).where(eq(musicCampaigns.id, id));
    return reply.status(204).send();
  });

  // ─── Pacing ─────────────────────────────────────────────────────────────────
  // Plays-today = play_history rows tagged with this music_campaign_id since
  // local midnight (server time = station time per project convention).
  fastify.get<{ Params: { id: string } }>(
    '/music-campaigns/:id/pacing',
    async (request, reply) => {
      const id = Number(request.params.id);
      const [campaign] = await db
        .select({ plays_per_day: musicCampaigns.plays_per_day })
        .from(musicCampaigns)
        .where(eq(musicCampaigns.id, id));
      if (!campaign) return reply.status(404).send({ error: 'Music campaign not found' });

      const midnight = startOfLocalDay(new Date());
      const playsToday = await db
        .select({ n: sql<number>`count(*)` })
        .from(playHistory)
        .where(
          and(
            eq(playHistory.music_campaign_id, id),
            gte(playHistory.started_at, midnight),
          ),
        );
      const count = Number(playsToday[0]?.n ?? 0);
      const target = campaign.plays_per_day;
      // Cap displayed pct at 200 to keep the UI tidy when over-pacing.
      const pct = target > 0 ? Math.min(200, Math.round((count / target) * 100)) : 0;
      return reply.send({
        plays_today: count,
        target,
        pct,
        on_track: pct >= 80 && pct <= 120,
      });
    },
  );
}

function startOfLocalDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}
