import { FastifyInstance } from 'fastify';
import { IcecastConfigSchema } from '@soono/shared';
import { readIcecastConfig, writeIcecastConfig } from '../services/icecastConfig.js';
import { fetchAllMountStats, fetchIcecastStats, killIcecastSource } from '../services/icecastStats.js';
import { getPeakState, resetPeakState } from '../services/icecastPeakTracker.js';
import { restartContainer } from '../services/dockerControl.js';
import { generateRadioLiq, readLiquidsoapConfig } from '../services/liquidsoapConfig.js';

export async function icecastRoutes(fastify: FastifyInstance) {
  fastify.get<{ Reply: any }>('/icecast/config', async (request, reply) => {
    try {
      const config = await readIcecastConfig();
      return reply.send(config);
    } catch (err) {
      fastify.log.error({ err }, 'Failed to read Icecast config');
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post<{ Body: any; Reply: any }>('/icecast/config', async (request, reply) => {
    const parsed = IcecastConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ errors: parsed.error.errors });
    }

    await writeIcecastConfig(parsed.data);
    // Regenerate the LiquidSoap script so the source password stays in sync with icecast.xml
    const lsConfig = await readLiquidsoapConfig();
    await generateRadioLiq(lsConfig);
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
    const peak = getPeakState();
    return reply.send({ ...stats, peak_listener: peak.peak_listener, peak_since: peak.since });
  });

  fastify.post<{ Reply: any }>('/icecast/stats/peak/reset', async (_request, reply) => {
    const { listener } = await fetchAllMountStats();
    const peak = await resetPeakState(listener);
    return reply.send({ peak_listener: peak.peak_listener, peak_since: peak.since });
  });

  fastify.get<{ Querystring: { mount?: string }; Reply: any }>(
    '/icecast/stats/:mount',
    async (request, reply) => {
      const mount = (request.params as any).mount || '/stream';
      const stats = await fetchIcecastStats(mount);
      return reply.send(stats);
    },
  );

  fastify.post<{ Body: { mount?: string }; Reply: any }>(
    '/icecast/mounts/kick',
    async (request, reply) => {
      const mount = request.body?.mount;
      if (!mount || typeof mount !== 'string' || !mount.startsWith('/')) {
        return reply.status(400).send({ error: 'mount must be a path starting with /' });
      }
      try {
        await killIcecastSource(mount);
        return reply.send({ success: true });
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  fastify.post<{ Reply: any }>('/icecast/restart', async (_request, reply) => {
    try {
      await restartContainer('soono-icecast');
      return reply.status(200).send({ success: true, message: 'Icecast restarting...' });
    } catch (error) {
      return reply
        .status(500)
        .send({ error: `Failed to restart Icecast: ${(error as Error).message}` });
    }
  });
}
