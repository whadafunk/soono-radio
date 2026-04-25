import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { icecastRoutes } from './routes/icecast.js';
import { certificateRoutes } from './routes/certificates.js';

const fastify = Fastify({
  logger: true,
});

fastify.register(helmet);
fastify.register(cors, {
  origin: ['http://localhost:3000', 'http://localhost:5173'],
});
fastify.register(multipart, {
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB — generous for cert files
  },
});

fastify.register(icecastRoutes);
fastify.register(certificateRoutes);

fastify.get('/', async () => {
  return { message: 'Radio API Server' };
});

const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
