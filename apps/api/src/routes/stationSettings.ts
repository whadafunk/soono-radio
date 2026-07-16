import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { stationSettings } from '../db/schema.js';
import { StationSettingsPatchSchema } from '@soono/shared';
import { invalidateInventory } from '../services/spotBudget.js';

async function ensureRow() {
  const [row] = await db.select().from(stationSettings).where(eq(stationSettings.id, 1));
  if (!row) {
    await db.insert(stationSettings).values({
      id: 1,
      promo_margin: 0.10,
      drift_recovery_cap_seconds: 300,
      reality_check_interval_seconds: 3,
      drift_full_authority_threshold_s: 100,
    });
    return {
      id: 1,
      promo_margin: 0.10,
      default_clock_id: null,
      drift_recovery_cap_seconds: 300,
      reality_check_interval_seconds: 3,
      drift_full_authority_threshold_s: 100,
    };
  }
  return row;
}

export async function stationSettingsRoutes(fastify: FastifyInstance) {
  fastify.get('/settings/station', async () => {
    return ensureRow();
  });

  fastify.patch('/settings/station', async (request, reply) => {
    const parsed = StationSettingsPatchSchema.safeParse(request.body);
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
