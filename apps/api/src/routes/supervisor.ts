import { FastifyInstance } from 'fastify';
import { getStatus } from '../services/supervisor/index.js';

export async function supervisorRoutes(fastify: FastifyInstance) {
  fastify.get('/supervisor/status', async (_request, reply) => {
    return reply.send(getStatus());
  });

  // Stubs for the upcoming steps. Surfaced here so the routes appear in
  // the API surface from the start; they return 501 until implemented.
  fastify.get('/supervisor/recent-plays', async (_request, reply) => {
    return reply.status(501).send({
      error: 'recent-plays arrives with Supervisor Step 3 (play_history)',
    });
  });

  fastify.post('/supervisor/skip', async (_request, reply) => {
    return reply.status(501).send({
      error: 'skip arrives with a later supervisor phase (Live Assist)',
    });
  });
}
