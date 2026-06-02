import { FastifyInstance } from 'fastify';
import { IntegrationsConfigSchema } from '@soono/shared';
import { getIntegrationsConfig, writeIntegrationsConfig } from '../services/integrations/config.js';

export async function integrationsRoutes(fastify: FastifyInstance) {
  fastify.get('/integrations/config', async (_request, reply) => {
    return reply.send(getIntegrationsConfig());
  });

  fastify.post<{ Body: unknown }>('/integrations/config', async (request, reply) => {
    const parsed = IntegrationsConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ errors: parsed.error.errors });
    }
    await writeIntegrationsConfig(parsed.data);
    return reply.send({ success: true });
  });
}
