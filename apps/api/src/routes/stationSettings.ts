import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { stationSettings } from '../db/schema.js';
import { DEFAULT_STATION_TIMEZONE, StationSettingsPatchSchema } from '@soono/shared';
import { invalidateInventory } from '../services/spotBudget.js';
import { applyStationTimeZone } from '../services/stationTimeZone.js';
import { requestReconcile } from '../services/supervisor2/bus.js';

async function ensureRow() {
  const [row] = await db.select().from(stationSettings).where(eq(stationSettings.id, 1));
  if (!row) {
    await db.insert(stationSettings).values({
      id: 1,
      promo_margin: 0.10,
      timezone: DEFAULT_STATION_TIMEZONE,
      drift_recovery_cap_seconds: 300,
      reality_check_interval_seconds: 3,
      drift_full_authority_threshold_s: 100,
      runway_worth_it_threshold_s: 300,
    });
    return {
      id: 1,
      promo_margin: 0.10,
      timezone: DEFAULT_STATION_TIMEZONE,
      default_clock_id: null,
      drift_recovery_cap_seconds: 300,
      reality_check_interval_seconds: 3,
      drift_full_authority_threshold_s: 100,
      runway_worth_it_threshold_s: 300,
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

    const before = await ensureRow();
    const [updated] = await db
      .update(stationSettings)
      .set(parsed.data)
      .where(eq(stationSettings.id, 1))
      .returning();

    invalidateInventory();

    // A new station timezone changes what every scheduled clock time means.
    // Apply it to this process at once, then let the supervisor re-derive
    // which clock or show covers "now" (the same nudge a schedule edit gives;
    // its own rules decide whether that lands immediately or at the next
    // segment boundary).
    if (parsed.data.timezone != null && parsed.data.timezone !== before.timezone) {
      const applied = applyStationTimeZone(parsed.data.timezone);
      fastify.log.warn({ from: before.timezone, to: applied }, 'Station timezone changed by operator');
      requestReconcile('timezone_change');
    }
    return updated;
  });
}
