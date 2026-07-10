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
}
