import { eq } from 'drizzle-orm';
import type { SupervisorStatus, PlayHistory } from '@radio/shared';
import { db } from '../../db/index.js';
import { media, playHistory } from '../../db/schema.js';
import { TelnetClient } from './telnet.js';
import { Scheduler } from './scheduler.js';

const TELNET_HOST = process.env.LIQUIDSOAP_TELNET_HOST || '127.0.0.1';
const TELNET_PORT = parseInt(process.env.LIQUIDSOAP_TELNET_PORT || '1234', 10);
const MEDIA_CONTAINER_PATH = '/media';

interface SupervisorState {
  running: boolean;
  telnet: TelnetClient | null;
  scheduler: Scheduler | null;
  current_play_id: number | null;
  playedHandlers: Set<(play: PlayHistory) => void>;
}

const state: SupervisorState = {
  running: false,
  telnet: null,
  scheduler: null,
  current_play_id: null,
  playedHandlers: new Set(),
};

let logger: { info: (msg: string) => void; warn: (msg: string) => void } = {
  info: (msg: string) => console.log(`[supervisor] ${msg}`),
  warn: (msg: string) => console.warn(`[supervisor] ${msg}`),
};

export function setLogger(l: { info: (msg: string) => void; warn: (msg: string) => void }): void {
  logger = l;
}

/**
 * Start the supervisor: open telnet to Mix Engine, spin up the scheduler.
 * Step 2 ships picker + scheduler tick (music plays automatically).
 * Step 3 will add the play_history-aware metadata watcher.
 */
export async function start(): Promise<void> {
  if (state.running) return;
  state.telnet = new TelnetClient(TELNET_HOST, TELNET_PORT, logger);
  state.telnet.on('connected', () => {
    logger.info('Mix Engine telnet attached');
  });
  state.telnet.on('disconnected', (reason) => {
    logger.warn(`Mix Engine telnet detached (${reason}) — will reconnect`);
  });
  await state.telnet.start();

  state.scheduler = new Scheduler(state.telnet, logger);
  state.scheduler.start();

  state.running = true;
}

export async function stop(): Promise<void> {
  if (!state.running) return;
  state.running = false;
  if (state.scheduler) {
    state.scheduler.stop();
    state.scheduler = null;
  }
  if (state.telnet) {
    await state.telnet.stop();
    state.telnet = null;
  }
}

export function getStatus(): SupervisorStatus {
  const sched = state.scheduler?.getState();
  return {
    running: state.running,
    reachable: state.telnet?.isConnected() ?? false,
    queue_depth: sched?.queue_depth ?? 0,
    on_air_source: sched?.on_air_source ?? 'none',
    current_play_id: state.current_play_id,
  };
}

export function onPlayed(handler: (play: PlayHistory) => void): () => void {
  state.playedHandlers.add(handler);
  return () => {
    state.playedHandlers.delete(handler);
  };
}

/**
 * Manually enqueue a specific track. Used by Live Assist later; for V1
 * exposed primarily so the API has a way to seed the queue from a UI
 * button when a station first comes up.
 */
export async function enqueueManual(mediaId: number): Promise<void> {
  if (!state.telnet || !state.telnet.isConnected()) {
    throw new Error('Mix Engine telnet is not connected');
  }
  const rows = await db.select().from(media).where(eq(media.id, mediaId)).limit(1);
  if (rows.length === 0) throw new Error(`media ${mediaId} not found`);
  const m = rows[0];
  const uri = `${MEDIA_CONTAINER_PATH}/${m.sha256}.mp3`;
  await state.telnet.command(`auto.push ${uri}`);
  await db.insert(playHistory).values({
    media_id: m.id,
    source: 'manual',
    pick_reason: 'enqueueManual via API',
  });
  logger.info(`Manual enqueue: ${m.title || m.original_filename} (media_id=${m.id})`);
}
