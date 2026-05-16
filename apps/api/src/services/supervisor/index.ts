import { eq } from 'drizzle-orm';
import type { SupervisorStatus, PlayHistory } from '@radio/shared';
import { db } from '../../db/index.js';
import { media } from '../../db/schema.js';
import { TelnetClient } from './telnet.js';
import { Scheduler } from './scheduler.js';
import { MetadataWatcher } from './metadataWatcher.js';
import { closeStaleOpenRows, recordPushed } from './playHistory.js';
import { loadSupervisorConfig } from './config.js';

const TELNET_HOST = process.env.LIQUIDSOAP_TELNET_HOST || '127.0.0.1';
const TELNET_PORT = parseInt(process.env.LIQUIDSOAP_TELNET_PORT || '1234', 10);
const MEDIA_CONTAINER_PATH = '/media';

interface SupervisorState {
  running: boolean;
  telnet: TelnetClient | null;
  scheduler: Scheduler | null;
  metadataWatcher: MetadataWatcher | null;
  playedHandlers: Set<(play: PlayHistory) => void>;
}

const state: SupervisorState = {
  running: false,
  telnet: null,
  scheduler: null,
  metadataWatcher: null,
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
  // Load operator-tunable settings (poll intervals, separation, queue
  // depth threshold) before any tick reads them.
  await loadSupervisorConfig();
  state.telnet = new TelnetClient(TELNET_HOST, TELNET_PORT, logger);
  state.telnet.on('connected', () => {
    logger.info('Mix Engine telnet attached');
  });
  state.telnet.on('disconnected', (reason) => {
    logger.warn(`Mix Engine telnet detached (${reason}) — will reconnect`);
  });
  await state.telnet.start();

  // Recover from a previous unclean shutdown. The naive 'close all open
  // rows' is too aggressive — if LS is still playing or has queued
  // tracks from before the restart, those rows are legitimately still
  // in flight and shouldn't be closed. We probe LS for the live request
  // ids, look up their play_history_id annotations, and spare those rows.
  // If LS is unreachable, fall back to the simple close-everything logic.
  const liveIds = await fetchAlivePlayHistoryIds(state.telnet, logger);
  const recovered = await closeStaleOpenRows(new Date(), liveIds);
  if (recovered > 0) {
    logger.info(
      `Closed ${recovered} stale play_history rows from previous run` +
        (liveIds.length > 0 ? ` (spared ${liveIds.length} still alive in LS)` : ''),
    );
  }

  state.scheduler = new Scheduler(state.telnet, logger);
  state.scheduler.start();

  state.metadataWatcher = new MetadataWatcher(state.telnet, logger);
  state.metadataWatcher.start();

  state.running = true;
}

export async function stop(): Promise<void> {
  if (!state.running) return;
  state.running = false;
  if (state.metadataWatcher) {
    state.metadataWatcher.stop();
    state.metadataWatcher = null;
  }
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
    current_play_id: state.metadataWatcher?.getCurrentPlayId() ?? null,
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
/**
 * Probe LS for all alive request ids, fetch their metadata, and pull
 * the play_history_id annotation from each. Used at boot to know which
 * rows are still legitimately in flight.
 */
async function fetchAlivePlayHistoryIds(
  telnet: TelnetClient,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<number[]> {
  // Telnet may not be connected yet (start() returned but the socket
  // dance hasn't finished). Wait briefly for the first connect.
  for (let i = 0; i < 10 && !telnet.isConnected(); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!telnet.isConnected()) {
    log.warn('Mix Engine telnet not yet reachable — skipping smart boot recovery');
    return [];
  }
  try {
    const aliveLines = await telnet.command('request.alive');
    const rids = aliveLines
      .flatMap((l) => l.split(/\s+/))
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
    const playIds: number[] = [];
    for (const rid of rids) {
      const meta = await telnet.command(`request.metadata ${rid}`).catch(() => [] as string[]);
      for (const line of meta) {
        const m = /^\s*play_history_id\s*=\s*"(\d+)"\s*$/.exec(line);
        if (m) playIds.push(parseInt(m[1], 10));
      }
    }
    return playIds;
  } catch (err) {
    log.warn(`Boot recovery probe failed: ${(err as Error).message}`);
    return [];
  }
}

export async function enqueueManual(mediaId: number): Promise<void> {
  if (!state.telnet || !state.telnet.isConnected()) {
    throw new Error('Mix Engine telnet is not connected');
  }
  const rows = await db.select().from(media).where(eq(media.id, mediaId)).limit(1);
  if (rows.length === 0) throw new Error(`media ${mediaId} not found`);
  const m = rows[0];
  const playId = await recordPushed({
    mediaId: m.id,
    source: 'manual',
    pickReason: 'enqueueManual via API',
  });
  if (!/^[0-9a-f]{64}$/.test(m.sha256)) {
    throw new Error(`media ${m.id} has corrupt SHA-256 in database`);
  }
  const uri = `${MEDIA_CONTAINER_PATH}/${m.sha256}.mp3`;
  await state.telnet.command(`auto.push annotate:play_history_id="${playId}":${uri}`);
  logger.info(
    `Manual enqueue: ${m.title || m.original_filename} (media_id=${m.id}, play_history_id=${playId})`,
  );
}
