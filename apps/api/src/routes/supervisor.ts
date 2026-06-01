import { FastifyInstance } from 'fastify';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { SupervisorConfigSchema } from '@soono/shared';

const CONFIG_PATH =
  process.env.SUPERVISOR_CONFIG ||
  join(process.cwd(), '..', '..', 'data', 'supervisor-config.json');

const DEFAULT_CONFIG = SupervisorConfigSchema.parse({});

async function readConfig() {
  try {
    return SupervisorConfigSchema.parse(JSON.parse(await readFile(CONFIG_PATH, 'utf-8')));
  } catch (err: any) {
    if (err.code === 'ENOENT') return DEFAULT_CONFIG;
    throw err;
  }
}

// V2 supervisor routes — Phase 1 stubs.
// Control endpoints (pause, resume, hold, resync) will be re-implemented in Phase 4
// when the SupervisorProcess is fully wired. Status reflects V2 state from SQLite.
export async function supervisorRoutes(fastify: FastifyInstance) {
  fastify.get('/supervisor/config', async (_request, reply) => {
    return reply.send(await readConfig());
  });

  fastify.post('/supervisor/config', async (request, reply) => {
    const parsed = SupervisorConfigSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    await writeFile(CONFIG_PATH, JSON.stringify(parsed.data, null, 2) + '\n', 'utf-8');
    return reply.send(parsed.data);
  });

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
}
