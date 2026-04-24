import { FastifyInstance } from 'fastify';
import { IcecastConfigSchema } from '@radio/shared';
import { readIcecastConfig, writeIcecastConfig } from '../services/icecastConfig.js';
import { fetchAllMountStats, fetchIcecastStats } from '../services/icecastStats.js';

export async function icecastRoutes(fastify: FastifyInstance) {
  fastify.get<{ Reply: any }>('/icecast/config', async (request, reply) => {
    const config = await readIcecastConfig();
    return reply.send(config);
  });

  fastify.post<{ Body: any; Reply: any }>('/icecast/config', async (request, reply) => {
    const parsed = IcecastConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ errors: parsed.error.errors });
    }

    await writeIcecastConfig(parsed.data);
    return reply.status(200).send({ success: true });
  });

  fastify.get<{ Reply: any }>('/icecast/stats', async (request, reply) => {
    const stats = await fetchAllMountStats();
    return reply.send(stats);
  });

  fastify.get<{ Querystring: { mount?: string }; Reply: any }>(
    '/icecast/stats/:mount',
    async (request, reply) => {
      const mount = (request.params as any).mount || '/stream';
      const stats = await fetchIcecastStats(mount);
      return reply.send(stats);
    },
  );
}
