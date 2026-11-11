import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { supervisorState } from '../db/schema.js';
import { LIQUIDSOAP_CONTAINER, startContainer, stopContainer } from '../services/dockerControl.js';

// The station-level On Air / Off Air switch.
//
// Off air is the whole station, not one component: stopping only the stream
// would leave the supervisor feeding spots to the mix engine and logging
// them as aired with nobody able to hear them. So the switch persists a flag
// the supervisor and queue feeder both obey (supervisor_state.paused —
// survives API and host restarts) and stops the mix engine container. The
// supervisor does the bookkeeping itself when it sees the flag change; see
// goOffAir / goOnAir in supervisor2/processes/supervisor.ts.
export async function stationRoutes(fastify: FastifyInstance) {
  fastify.post('/station/off-air', async (_request, reply) => {
    // Flag first: from this write on nothing new is pushed, so nothing can
    // start airing (and be logged) while the container is shutting down.
    await db.update(supervisorState).set({ paused: true }).where(eq(supervisorState.id, 1));
    fastify.log.warn('Station switched OFF AIR by operator');

    try {
      await stopContainer(LIQUIDSOAP_CONTAINER);
    } catch (err) {
      // The station stays off air regardless — the supervisor keeps
      // retrying the stop for as long as the mix engine answers.
      fastify.log.error(err, 'Off air: failed to stop the mix engine');
      return reply.send({
        ok: true,
        off_air: true,
        mix_engine_stopped: false,
        warning: `Scheduling is stopped, but the Mix Engine could not be stopped yet (${(err as Error).message}). It will be retried automatically.`,
      });
    }
    return reply.send({ ok: true, off_air: true, mix_engine_stopped: true });
  });

  fastify.post('/station/on-air', async (_request, reply) => {
    // Container first: if it can't be started the station stays off air
    // rather than planning and logging against a mix engine that isn't there.
    try {
      await startContainer(LIQUIDSOAP_CONTAINER);
    } catch (err) {
      fastify.log.error(err, 'On air: failed to start the mix engine');
      return reply
        .status(502)
        .send({ ok: false, error: `Could not start the Mix Engine: ${(err as Error).message}. The station is still off air.` });
    }

    await db.update(supervisorState).set({ paused: false }).where(eq(supervisorState.id, 1));
    fastify.log.warn('Station switched ON AIR by operator');
    return reply.send({ ok: true, off_air: false });
  });
}
