import { FastifyInstance } from 'fastify';

// V2 supervisor routes — Phase 1 stubs.
// Control endpoints (pause, resume, hold, resync) will be re-implemented in Phase 4
// when the SupervisorProcess is fully wired. Status reflects V2 state from SQLite.
export async function supervisorRoutes(fastify: FastifyInstance) {
  // Placeholder — returns static not-yet-running state.
  // Phase 4 will replace this with a live read from supervisor_state table + process health.
  fastify.get('/supervisor/status', async (_request, reply) => {
    return reply.send({
      running: false,
      reachable: false,
      queue_depth: 0,
      on_air_source: 'none',
      current_play_id: null,
      scheduled: null,
      paused: false,
      held: null,
    });
  });

  // Remaining V1 endpoints removed with V1 teardown.
  // They will be re-added or replaced as Phase 4 (Supervisor + Queue Feeder + Drift) lands.
}
