import { and, eq, gte, isNotNull } from 'drizzle-orm';
import type { SupervisorStatus, ScheduledState, PlayHistory, StartPolicy } from '@radio/shared';
import { db } from '../../db/index.js';
import { clockSegments, media, playHistory } from '../../db/schema.js';
import { TelnetClient } from './telnet.js';
import { Scheduler } from './scheduler.js';
import { MetadataWatcher } from './metadataWatcher.js';
import { closeStaleOpenRows, recordPushed } from './playHistory.js';
import { loadSupervisorConfig } from './config.js';
import { resolveCurrentSegment, type ResolvedSegment } from './clockResolver.js';

/** Lookahead window for hard-cut warning — operators get this much advance notice. */
const HARD_CUT_WARNING_SECONDS = 120;

const TELNET_HOST = process.env.LIQUIDSOAP_TELNET_HOST || '127.0.0.1';
const TELNET_PORT = parseInt(process.env.LIQUIDSOAP_TELNET_PORT || '1234', 10);
const MEDIA_CONTAINER_PATH = '/media';

interface HeldSegmentState {
  segment_id: number;
  // Snapshot of the segment at hold time. Refresh-loop reads from this and
  // doesn't re-resolve from the clock; otherwise the clock instance would
  // continue advancing and the "elapsed in segment" math would be wrong.
  snapshot: ResolvedSegment;
  // When the hold began. UI shows this so operators can see how long they've
  // been holding (a hint that the schedule is drifting).
  held_at: Date;
}

interface SupervisorState {
  running: boolean;
  telnet: TelnetClient | null;
  scheduler: Scheduler | null;
  metadataWatcher: MetadataWatcher | null;
  playedHandlers: Set<(play: PlayHistory) => void>;
  scheduled: ResolvedSegment | null;
  scheduleTimer: NodeJS.Timeout | null;
  /** When true, scheduler tick skips picking + pushing (queue/live polling still runs). */
  paused: boolean;
  /** When set, the schedule resolver returns this segment regardless of wall-clock advance. */
  held: HeldSegmentState | null;
}

const state: SupervisorState = {
  running: false,
  telnet: null,
  scheduler: null,
  metadataWatcher: null,
  playedHandlers: new Set(),
  scheduled: null,
  scheduleTimer: null,
  paused: false,
  held: null,
};

// Refresh the resolved-schedule snapshot every 5s. Synchronous getStatus()
// reads from the cache — never blocks on a DB query. The cadence matches the
// scheduler tick because the snapshot only changes at segment boundaries,
// and a 5s lag in the UI is invisible against ~minute-long segments.
const SCHEDULE_REFRESH_MS = 5000;

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

  // Prime the schedule snapshot immediately so the first status read isn't
  // empty, then refresh on a timer for as long as the supervisor runs.
  void refreshScheduled();
  state.scheduleTimer = setInterval(() => void refreshScheduled(), SCHEDULE_REFRESH_MS);

  state.running = true;
}

async function refreshScheduled(): Promise<void> {
  // Hold pins the resolved segment so the supervisor reports "this segment is
  // still active" even as wall-clock crosses what would normally be a
  // boundary. We synthesize an updated ResolvedSegment with elapsed-since-hold
  // so the UI clock keeps ticking but the segment identity stays put.
  if (state.held) {
    const heldFor = Math.floor((Date.now() - state.held.held_at.getTime()) / 1000);
    const original = state.held.snapshot;
    state.scheduled = {
      ...original,
      segment_elapsed_seconds: original.segment_elapsed_seconds + heldFor,
      segment_remaining_seconds: 0, // "unknown — held" surfaced in UI
      // Drift and hard-cut warning don't apply while held — operator is in
      // explicit-override mode.
      drift_seconds: 0,
      hard_cut_warning: false,
    };
    return;
  }
  try {
    const resolved = await resolveCurrentSegment(new Date());
    if (!resolved) {
      state.scheduled = null;
      return;
    }
    // Enrich with drift + hard-cut warning. Both are advisory — they don't
    // affect picker behavior at this layer (look-ahead handles boundary
    // protection separately inside the snapshot loader).
    const [drift, warning] = await Promise.all([
      computeDrift(resolved),
      computeHardCutWarning(resolved),
    ]);
    state.scheduled = {
      ...resolved,
      drift_seconds: drift,
      hard_cut_warning: warning,
    };
  } catch (err) {
    // A bad row or transient DB hiccup must not bring down the supervisor.
    logger.warn(`Schedule resolver failed: ${(err as Error).message}`);
    state.scheduled = null;
  }
}

/**
 * drift = segment_elapsed - sum(durations of completed plays in this segment).
 * Positive = music behind segment clock (running long). Negative = music has
 * played more seconds than the segment has elapsed (overrun).
 *
 * Uses completed rows only (ended_at IS NOT NULL) for a stable, discrete
 * update at track boundaries instead of a continuously-shifting signal.
 */
async function computeDrift(scheduled: ResolvedSegment): Promise<number> {
  const rows = await db
    .select({ duration: media.duration_seconds })
    .from(playHistory)
    .innerJoin(media, eq(playHistory.media_id, media.id))
    .where(
      and(
        eq(playHistory.clock_segment_id, scheduled.segment.id),
        gte(playHistory.started_at, scheduled.segment_started_at),
        isNotNull(playHistory.ended_at),
      ),
    );
  const playedSeconds = rows.reduce((sum, r) => sum + (r.duration ?? 0), 0);
  return Math.round(scheduled.segment_elapsed_seconds - playedSeconds);
}

/**
 * Hard-cut warning fires when:
 *   - The current segment is fixed-end (can_skip = false), AND
 *   - The next segment in the clock has start_policy.type === 'hard', AND
 *   - We're within HARD_CUT_WARNING_SECONDS of the boundary.
 *
 * For tiling clocks where the current segment is the last one, the boundary
 * is the start of the next clock instance — which for now we treat as a
 * soft handover (the clock's own finish_policy governs it). So warning only
 * fires intra-clock.
 */
async function computeHardCutWarning(scheduled: ResolvedSegment): Promise<boolean> {
  if (scheduled.segment.can_skip) return false;
  if (scheduled.segment_remaining_seconds > HARD_CUT_WARNING_SECONDS) return false;

  // Find the next segment in the same clock by sort_order.
  const siblings = await db
    .select({
      id: clockSegments.id,
      sort_order: clockSegments.sort_order,
      start_policy: clockSegments.start_policy,
    })
    .from(clockSegments)
    .where(eq(clockSegments.clock_id, scheduled.clock.id))
    .orderBy(clockSegments.sort_order);
  const idx = siblings.findIndex((s) => s.id === scheduled.segment.id);
  // Last segment in clock — boundary is the clock end, not a hard cut.
  if (idx < 0 || idx === siblings.length - 1) return false;
  const next = siblings[idx + 1];
  const policy = next.start_policy as StartPolicy | undefined;
  return policy?.type === 'hard';
}

export async function stop(): Promise<void> {
  if (!state.running) return;
  state.running = false;
  if (state.scheduleTimer) {
    clearInterval(state.scheduleTimer);
    state.scheduleTimer = null;
  }
  state.scheduled = null;
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
    scheduled: toScheduledState(state.scheduled),
    paused: state.paused,
    held: state.held
      ? {
          segment_id: state.held.segment_id,
          held_at: state.held.held_at,
        }
      : null,
  };
}

// ─── Controls ────────────────────────────────────────────────────────────────

export function pauseSupervisor(): void {
  if (!state.running) throw new Error('Supervisor not running');
  state.paused = true;
  state.scheduler?.setPaused(true);
  logger.info('Supervisor paused — picker will skip new pushes');
}

export function resumeSupervisor(): void {
  if (!state.running) throw new Error('Supervisor not running');
  state.paused = false;
  state.scheduler?.setPaused(false);
  logger.info('Supervisor resumed — picker will push again on next tick');
}

/**
 * Trigger an immediate scheduler tick. Note: this does NOT flush the LS
 * queue — that would require canceling alive requests via telnet, which
 * Phase F v1 leaves unsupported. For now, Resync means "re-evaluate the
 * schedule and push on the next available queue slot". For an aggressive
 * flush, operators can Pause → wait for queue to drain → Resume.
 */
export async function resyncNow(): Promise<void> {
  if (!state.running) throw new Error('Supervisor not running');
  await refreshScheduled();
  await state.scheduler?.tickNow();
  logger.info('Resync triggered — immediate scheduler tick');
}

export function holdCurrentSegment(): { segment_id: number; held_at: Date } {
  if (!state.running) throw new Error('Supervisor not running');
  if (!state.scheduled) {
    throw new Error('No segment currently resolved — nothing to hold');
  }
  if (state.held) {
    throw new Error('Hold already active — release first');
  }
  state.held = {
    segment_id: state.scheduled.segment.id,
    snapshot: state.scheduled,
    held_at: new Date(),
  };
  logger.info(
    `Hold engaged on segment ${state.scheduled.segment.name} (id=${state.scheduled.segment.id})`,
  );
  return { segment_id: state.held.segment_id, held_at: state.held.held_at };
}

export function releaseHold(): void {
  if (!state.held) throw new Error('No hold active');
  logger.info(`Hold released — segment ${state.held.segment_id}`);
  state.held = null;
}

function toScheduledState(r: ResolvedSegment | null): ScheduledState | null {
  if (!r) return null;
  return {
    source: r.source,
    clock_id: r.clock.id,
    clock_name: r.clock.name,
    segment_id: r.segment.id,
    segment_name: r.segment.name,
    segment_type: r.segment.type,
    segment_index: r.segment_index,
    show_id: r.show?.id ?? null,
    show_name: r.show?.name ?? null,
    clock_instance_started_at: r.clock_instance_started_at,
    segment_started_at: r.segment_started_at,
    segment_elapsed_seconds: r.segment_elapsed_seconds,
    segment_remaining_seconds: r.segment_remaining_seconds,
    drift_seconds: r.drift_seconds,
    hard_cut_warning: r.hard_cut_warning,
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
