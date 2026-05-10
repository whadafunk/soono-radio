import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { icecastRoutes } from './routes/icecast.js';
import { certificateRoutes } from './routes/certificates.js';
import { liquidsoapRoutes } from './routes/liquidsoap.js';
import { libraryRoutes } from './routes/library.js';
import { supervisorRoutes } from './routes/supervisor.js';
import { clockRoutes } from './routes/clocks.js';
import { showRoutes } from './routes/shows.js';
import { customerRoutes } from './routes/customers.js';
import { scheduleRoutes } from './routes/schedule.js';
import { rotationRoutes } from './routes/rotations.js';
import { runMigrations } from './db/index.js';
import { ingestQueue, recoverInterruptedJobs } from './services/ingest/queue.js';
import { ensureDirs } from './services/ingest/paths.js';
import * as supervisor from './services/supervisor/index.js';

const fastify = Fastify({
  logger: true,
});

fastify.register(helmet);
fastify.register(cors, {
  origin: ['http://localhost:3000', 'http://localhost:5173'],
});
fastify.register(multipart, {
  limits: {
    // Audio uploads need much more headroom than certs. A typical 5-minute
    // FLAC sits around 30–50 MB; allow 500 MB so users can drop full albums.
    fileSize: 500 * 1024 * 1024,
    files: 100,
  },
});

fastify.register(icecastRoutes);
fastify.register(certificateRoutes);
fastify.register(liquidsoapRoutes);
fastify.register(libraryRoutes);
fastify.register(supervisorRoutes);
fastify.register(clockRoutes);
fastify.register(showRoutes);
fastify.register(customerRoutes);
fastify.register(scheduleRoutes);
fastify.register(rotationRoutes);

fastify.get('/', async () => {
  return { message: 'Radio API Server' };
});

const start = async () => {
  try {
    await runMigrations();
    fastify.log.info('Database migrations applied');
    await ensureDirs();
    const recovered = await recoverInterruptedJobs();
    if (recovered > 0) {
      fastify.log.info({ recovered }, 'Marked interrupted ingest jobs as failed');
    }
    // Pick up any jobs that were left in 'queued' across restarts.
    ingestQueue.signal();

    // Hand the Supervisor a logger that funnels through Fastify so its
    // messages share the request log stream.
    supervisor.setLogger({
      info: (msg) => fastify.log.info(`[supervisor] ${msg}`),
      warn: (msg) => fastify.log.warn(`[supervisor] ${msg}`),
    });
    await supervisor.start();

    await fastify.listen({ port: 3000, host: '0.0.0.0' });

    // Stop the supervisor cleanly on SIGTERM / SIGINT so telnet sockets
    // close instead of dangling.
    const shutdown = async (signal: string) => {
      fastify.log.info(`Received ${signal}, shutting down supervisor`);
      await supervisor.stop();
      await fastify.close();
      process.exit(0);
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
