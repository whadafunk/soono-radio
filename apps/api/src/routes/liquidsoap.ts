import { FastifyInstance } from 'fastify';
import { LiquidsoapConfigSchema } from '@soono/shared';
import {
  readLiquidsoapConfig,
  writeLiquidsoapConfig,
  readRadioLiq,
  writeRadioLiq,
  generateRadioLiq,
} from '../services/liquidsoapConfig.js';
import { fetchLiquidsoapStatus } from '../services/liquidsoapStatus.js';
import { restartContainer } from '../services/dockerControl.js';

export async function liquidsoapRoutes(fastify: FastifyInstance) {
  fastify.get('/liquidsoap/config', async (_request, reply) => {
    const config = await readLiquidsoapConfig();
    return reply.send(config);
  });

  fastify.post<{ Body: any }>('/liquidsoap/config', async (request, reply) => {
    const parsed = LiquidsoapConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ errors: parsed.error.errors });
    }
    await writeLiquidsoapConfig(parsed.data);
    return reply.status(200).send({ success: true });
  });

  fastify.get('/liquidsoap/script/raw', async (_request, reply) => {
    try {
      const script = await readRadioLiq();
      return reply.send({ script });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        // Generate from current config so the editor isn't blank on first open.
        const config = await readLiquidsoapConfig();
        const script = await generateRadioLiq(config);
        return reply.send({ script });
      }
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post<{ Body: { script?: string } }>('/liquidsoap/script/raw', async (request, reply) => {
    const { script } = request.body || {};
    if (typeof script !== 'string' || script.length === 0) {
      return reply.status(400).send({ error: 'script is required' });
    }
    await writeRadioLiq(script);
    return reply.status(200).send({ success: true });
  });

  fastify.get('/liquidsoap/status', async (_request, reply) => {
    const status = await fetchLiquidsoapStatus();
    return reply.send(status);
  });

  fastify.post('/liquidsoap/restart', async (_request, reply) => {
    try {
      await restartContainer('soono-liquidsoap');
      return reply.status(200).send({ success: true, message: 'Liquidsoap restarting...' });
    } catch (error) {
      return reply
        .status(500)
        .send({ error: `Failed to restart Liquidsoap: ${(error as Error).message}` });
    }
  });
}
