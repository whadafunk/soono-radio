import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { bus } from '../services/supervisor2/bus.js';
import { readLiquidsoapConfig } from '../services/liquidsoapConfig.js';

// Validate the shared secret on all internal LS webhook calls.
// LS sends Authorization: Bearer <secret>. Password comes from the mix-engine config.
async function validateSecret(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const config = await readLiquidsoapConfig();
  const password = config.harbor.password;
  const auth = request.headers['authorization'] ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (password !== '' && provided !== password) {
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
      if (!await validateSecret(request, reply)) return;

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

      const ls_pid = typeof body['ls_pid'] === 'number' ? (body['ls_pid'] as number) : null;

      const metadata: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === 'string') metadata[k] = v;
      }

      request.log.info(
        { on_air_timestamp, uri, play_history_id, ls_pid },
        'LS on_track webhook received',
      );

      bus.emit({
        type: 'LS_TRACK_STARTED',
        on_air_timestamp,
        uri,
        play_history_id: Number.isFinite(play_history_id) ? play_history_id : null,
        metadata,
        ls_pid,
      });

      return reply.status(200).send({ ok: true });
    },
  );

  // Receives the on_end webhook from LiquidSoap.
  // Fired N seconds before the current track ends (configured in LS script).
  fastify.post<{ Body: Record<string, unknown> }>(
    '/internal/ls/track-ending',
    async (request, reply) => {
      if (!await validateSecret(request, reply)) return;

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

      const ls_pid = typeof body['ls_pid'] === 'number' ? (body['ls_pid'] as number) : null;

      const metadata: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === 'string') metadata[k] = v;
      }

      request.log.info(
        { remaining_seconds, uri, play_history_id, ls_pid },
        'LS on_end webhook received',
      );

      bus.emit({
        type: 'LS_TRACK_ENDING',
        remaining_seconds,
        uri,
        play_history_id: Number.isFinite(play_history_id) ? play_history_id : null,
        metadata,
        ls_pid,
      });

      return reply.status(200).send({ ok: true });
    },
  );

  // LS calls this when its live harbor input becomes active (DJ connected).
  // The Supervisor will suspend queue feeding and record a live_events row.
  fastify.post<{ Body: Record<string, unknown> }>(
    '/internal/ls/live-started',
    async (request, reply) => {
      if (!await validateSecret(request, reply)) return;

      const body = request.body ?? {};
      const source_name =
        typeof body['source_name'] === 'string' ? (body['source_name'] as string) : 'live';

      request.log.info({ source_name }, 'LS live-started webhook received');

      bus.emit({ type: 'LS_LIVE_STARTED', source_name });

      return reply.status(200).send({ ok: true });
    },
  );

  // LS calls this when its live harbor input disconnects. The Supervisor
  // re-engages queue feeding and may request a replan to absorb remaining
  // segment time.
  fastify.post<{ Body: Record<string, unknown> }>(
    '/internal/ls/live-ended',
    async (request, reply) => {
      if (!await validateSecret(request, reply)) return;

      const body = request.body ?? {};
      const source_name =
        typeof body['source_name'] === 'string' ? (body['source_name'] as string) : 'live';

      request.log.info({ source_name }, 'LS live-ended webhook received');

      bus.emit({ type: 'LS_LIVE_ENDED', source_name });

      return reply.status(200).send({ ok: true });
    },
  );
}
