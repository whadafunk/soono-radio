// Database maintenance — stats, retention settings, manual sweep.
// The automatic nightly sweep lives in services/maintenance/dbRetention.ts
// and runs regardless of this UI.
import type { FastifyInstance } from 'fastify';
import { statSync } from 'fs';
import { count } from 'drizzle-orm';
import { MaintenanceSettingsSchema } from '@soono/shared';
import { db, dbFilePath } from '../db/index.js';
import {
  liveEvents,
  planItems,
  plans,
  playHistory,
  stopSetEstimates,
} from '../db/schema.js';
import {
  readLastSweep,
  readMaintenanceSettings,
  sweepDatabase,
  writeMaintenanceSettings,
} from '../services/maintenance/dbRetention.js';
import {
  getMediaIntegrityState,
  isSweepRunning,
  startMediaIntegritySweep,
} from '../services/maintenance/mediaIntegrity.js';

export async function maintenanceRoutes(fastify: FastifyInstance) {
  fastify.get('/maintenance/db-stats', async (_request, reply) => {
    try {
      const [[p], [pi], [ph], [sse], [le]] = await Promise.all([
        db.select({ n: count() }).from(plans),
        db.select({ n: count() }).from(planItems),
        db.select({ n: count() }).from(playHistory),
        db.select({ n: count() }).from(stopSetEstimates),
        db.select({ n: count() }).from(liveEvents),
      ]);
      return reply.send({
        file_size_bytes: statSync(dbFilePath).size,
        counts: {
          plans: p.n,
          plan_items: pi.n,
          play_history: ph.n,
          stop_set_estimates: sse.n,
          live_events: le.n,
        },
        settings: readMaintenanceSettings(),
        last_sweep: readLastSweep(),
      });
    } catch (err) {
      fastify.log.error(err, 'maintenance db-stats failed');
      return reply.status(500).send({ error: 'Failed to read database stats' });
    }
  });

  fastify.post('/maintenance/settings', async (request, reply) => {
    const parsed = MaintenanceSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid settings' });
    }
    writeMaintenanceSettings(parsed.data);
    fastify.log.info(
      { event: 'MAINTENANCE_SETTINGS_UPDATED', ...parsed.data },
      'maintenance: settings updated',
    );
    return reply.send(parsed.data);
  });

  fastify.post('/maintenance/db-sweep', async (_request, reply) => {
    try {
      const result = await sweepDatabase(null);
      return reply.send(result);
    } catch (err) {
      fastify.log.error(err, 'maintenance manual sweep failed');
      return reply.status(500).send({ error: 'Sweep failed' });
    }
  });

  fastify.get('/maintenance/media-integrity', async (_request, reply) => {
    try {
      return reply.send(await getMediaIntegrityState());
    } catch (err) {
      fastify.log.error(err, 'maintenance media-integrity status failed');
      return reply.status(500).send({ error: 'Failed to read integrity state' });
    }
  });

  fastify.post('/maintenance/media-integrity/run', async (_request, reply) => {
    if (isSweepRunning()) {
      return reply.status(409).send({ error: 'An integrity sweep is already running' });
    }
    startMediaIntegritySweep(fastify.log);
    return reply.send(await getMediaIntegrityState());
  });
}
