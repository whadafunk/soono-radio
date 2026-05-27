import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { bus } from '../services/supervisor2/bus.js';

const LS_HARBOR_SECRET = process.env.LS_HARBOR_SECRET ?? '';

// Validate the shared secret on all internal LS webhook calls.
// LS sends Authorization: Bearer <secret>.
function validateSecret(request: FastifyRequest, reply: FastifyReply): boolean {
  const auth = request.headers['authorization'] ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (LS_HARBOR_SECRET !== '' && provided !== LS_HARBOR_SECRET) {
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export async function lsWebhookRoutes(fastify: FastifyInstance) {
  // Receives the on_track webhook from LiquidSoap.
  // Fired the moment LS transitions to a new audio item.
  fastify.post<{ Body: Record<string, unknown> }>(
    '/internal/ls/track-started',
    async (request, reply) => {
      if (!validateSecret(request, reply)) return;

      const body = request.body ?? {};
      const on_air_timestamp =
        typeof body['on_air_timestamp'] === 'number'
          ? (body['on_air_timestamp'] as number)
          : Date.now() / 1000;

      const uri = typeof body['uri'] === 'string' ? (body['uri'] as string) : '';

      const rawPhid = body['play_history_id'];
      const play_history_id =
        rawPhid !== undefined && rawPhid !== null && rawPhid !== ''
          ? parseInt(String(rawPhid), 10)
          : null;

      const metadata: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === 'string') metadata[k] = v;
      }

      request.log.info(
        { on_air_timestamp, uri, play_history_id },
        'LS on_track webhook received',
      );

      bus.emit({
        type: 'LS_TRACK_STARTED',
        on_air_timestamp,
        uri,
        play_history_id: Number.isFinite(play_history_id) ? play_history_id : null,
        metadata,
      });

      return reply.status(200).send({ ok: true });
    },
  );

  // Receives the on_end webhook from LiquidSoap.
  // Fired N seconds before the current track ends (configured in LS script).
  fastify.post<{ Body: Record<string, unknown> }>(
    '/internal/ls/track-ending',
    async (request, reply) => {
      if (!validateSecret(request, reply)) return;

      const body = request.body ?? {};
      const remaining_seconds =
        typeof body['remaining_seconds'] === 'number'
          ? (body['remaining_seconds'] as number)
          : 0;

      const uri = typeof body['uri'] === 'string' ? (body['uri'] as string) : '';

      const rawPhid = body['play_history_id'];
      const play_history_id =
        rawPhid !== undefined && rawPhid !== null && rawPhid !== ''
          ? parseInt(String(rawPhid), 10)
          : null;

      const metadata: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === 'string') metadata[k] = v;
      }

      request.log.info(
        { remaining_seconds, uri, play_history_id },
        'LS on_end webhook received',
      );

      bus.emit({
        type: 'LS_TRACK_ENDING',
        remaining_seconds,
        uri,
        play_history_id: Number.isFinite(play_history_id) ? play_history_id : null,
        metadata,
      });

      return reply.status(200).send({ ok: true });
    },
  );
}
