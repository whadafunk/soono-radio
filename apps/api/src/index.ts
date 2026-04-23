import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { icecastRoutes } from './routes/icecast.js';

const fastify = Fastify({
  logger: true,
});

fastify.register(helmet);
fastify.register(cors, {
  origin: ['http://localhost:3000', 'http://localhost:5173'],
});

fastify.register(icecastRoutes);

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
