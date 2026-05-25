import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { stationSettings } from '../db/schema.js';
import { StationSettingsSchema } from '@radio/shared';
import { invalidateInventory } from '../services/spotBudget.js';

async function ensureRow() {
  const [row] = await db.select().from(stationSettings).where(eq(stationSettings.id, 1));
  if (!row) {
    await db.insert(stationSettings).values({ id: 1, promo_margin: 0.10 });
    return { id: 1, promo_margin: 0.10 };
  }
  return row;
}

export async function stationSettingsRoutes(fastify: FastifyInstance) {
  fastify.get('/api/settings/station', async () => {
    return ensureRow();
  });

  fastify.patch('/api/settings/station', async (request, reply) => {
    const parsed = StationSettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    await ensureRow();
    const [updated] = await db
      .update(stationSettings)
      .set(parsed.data)
      .where(eq(stationSettings.id, 1))
      .returning();

    invalidateInventory();
    return updated;
  });
}
