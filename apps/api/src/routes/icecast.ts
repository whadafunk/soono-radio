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

  fastify.get<{ Reply: any }>('/icecast/config/raw', async (request, reply) => {
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');
    const CONFIG_PATH = process.env.ICECAST_CONFIG || join(process.cwd(), '..', '..', 'icecast', 'icecast.xml');
    const xml = await readFile(CONFIG_PATH, 'utf-8');
    return reply.send({ xml });
  });

  fastify.post<{ Body: any; Reply: any }>('/icecast/config/raw', async (request, reply) => {
    const { xml } = request.body as { xml?: string };
    if (!xml) {
      return reply.status(400).send({ error: 'XML content is required' });
    }

    try {
      const { parseStringPromise } = await import('xml2js');
      // Validate XML is parseable
      await parseStringPromise(xml);

      // Write the raw XML
      const { writeFile } = await import('fs/promises');
      const { join } = await import('path');
      const CONFIG_PATH = process.env.ICECAST_CONFIG || join(process.cwd(), '..', '..', 'icecast', 'icecast.xml');
      await writeFile(CONFIG_PATH, xml, 'utf-8');

      return reply.status(200).send({ success: true });
    } catch (error) {
      return reply.status(400).send({ error: `Invalid XML: ${(error as Error).message}` });
    }
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

  fastify.post<{ Reply: any }>('/icecast/restart', async (request, reply) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execPromise = promisify(exec);

      await execPromise('docker restart radio-icecast');
      return reply.status(200).send({ success: true, message: 'Icecast restarting...' });
    } catch (error) {
      return reply
        .status(500)
        .send({ error: `Failed to restart Icecast: ${(error as Error).message}` });
    }
  });
}
