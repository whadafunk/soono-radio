import type { SupervisorStatus, PlayHistory } from '@radio/shared';
import { TelnetClient } from './telnet.js';

const TELNET_HOST = process.env.LIQUIDSOAP_TELNET_HOST || '127.0.0.1';
const TELNET_PORT = parseInt(process.env.LIQUIDSOAP_TELNET_PORT || '1234', 10);

interface SupervisorState {
  running: boolean;
  telnet: TelnetClient | null;
  current_play_id: number | null;
  on_air_source: 'live' | 'auto' | 'none';
  queue_depth: number;
  playedHandlers: Set<(play: PlayHistory) => void>;
}

const state: SupervisorState = {
  running: false,
  telnet: null,
  current_play_id: null,
  on_air_source: 'none',
  queue_depth: 0,
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
 * Start the supervisor: open telnet to Mix Engine, mark running.
 * Step 1 ships only the connection skeleton. Picker, scheduler, and
 * metadata watcher arrive in steps 2 and 3.
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
  state.running = true;
}

export async function stop(): Promise<void> {
  if (!state.running) return;
  state.running = false;
  if (state.telnet) {
    await state.telnet.stop();
    state.telnet = null;
  }
}

export function getStatus(): SupervisorStatus {
  return {
    running: state.running,
    reachable: state.telnet?.isConnected() ?? false,
    queue_depth: state.queue_depth,
    on_air_source: state.on_air_source,
    current_play_id: state.current_play_id,
  };
}

/**
 * Subscribe to play-start events. Returns an unsubscribe function.
 * Used by Live Assist later. No-op until Step 3 wires the metadata
 * watcher.
 */
export function onPlayed(handler: (play: PlayHistory) => void): () => void {
  state.playedHandlers.add(handler);
  return () => {
    state.playedHandlers.delete(handler);
  };
}

/**
 * Future Live Assist hook: queue a specific media file. Stub until
 * the picker + scheduler land in Step 2.
 */
export async function enqueueManual(_mediaId: number): Promise<void> {
  throw new Error('enqueueManual is not implemented yet (arrives with Step 2)');
}
