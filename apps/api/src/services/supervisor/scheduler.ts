import { pickNext, type PickedMedia } from './picker.js';
import { recordPushed } from './playHistory.js';
import type { TelnetClient } from './telnet.js';
import { getSupervisorConfig } from './config.js';

// Container-side path where the host's media/ pool is mounted by
// start-liquidsoap.sh. Liquidsoap accesses files via this absolute path.
const MEDIA_CONTAINER_PATH = '/media';

export interface SchedulerState {
  queue_depth: number;
  on_air_source: 'live' | 'auto' | 'none';
  last_push_request_id: number | null;
}

export interface SchedulerEvents {
  pushed: (info: { media: PickedMedia; requestId: number | null; pickReason: string }) => void;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private paused = false;
  private state: SchedulerState = {
    queue_depth: 0,
    on_air_source: 'none',
    last_push_request_id: null,
  };

  constructor(
    private telnet: TelnetClient,
    private logger: { info: (msg: string) => void; warn: (msg: string) => void },
    private onPushed?: (info: { media: PickedMedia; requestId: number | null; pickReason: string }) => void,
  ) {}

  getState(): SchedulerState {
    return { ...this.state };
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = getSupervisorConfig().scheduler_tick_ms;
    // Run a tick immediately on start so we don't wait the full interval
    // for the first push when the API boots into a connected Mix Engine.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Pause picking. Queue/live polling continues so status stays fresh. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Force an immediate tick — used by /supervisor/resync. */
  async tickNow(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    if (!this.telnet.isConnected()) {
      this.state.on_air_source = 'none';
      return;
    }
    this.busy = true;
    try {
      // 1. Read queue depth and live status (we keep doing this even when
      //    paused so the UI still reflects what LS is doing).
      const queueLines = await this.telnet.command('auto.queue').catch(() => [] as string[]);
      this.state.queue_depth = parseQueueDepth(queueLines);

      const liveLines = await this.telnet.command('live.status').catch(() => [] as string[]);
      this.state.on_air_source = isLiveConnected(liveLines) ? 'live' : 'auto';

      // 2. Paused → skip picking. Operator must Resume to push fresh tracks.
      if (this.paused) return;

      // 3. If queue is short, pick and push.
      if (this.state.queue_depth >= getSupervisorConfig().queue_depth_threshold) return;

      const pick = await pickNext();
      if (!pick) {
        // Empty library or every track blocked by separation. Don't spam
        // the log; warn once per tick at most.
        this.logger.warn('Picker returned no track (empty library or all blocked)');
        return;
      }

      // Insert the play_history row first so we know its id, then push
      // with an annotation that lets the metadata watcher correlate the
      // currently-playing track back to this row.
      const playId = await recordPushed({
        mediaId: pick.media.id,
        source: 'auto',
        pickReason: pick.reason,
        clockSegmentId: pick.clock_segment_id,
        musicCampaignId: pick.music_campaign_id,
        campaignId: pick.campaign_id,
        promoId: pick.promo_id,
        stopSetPosition: pick.stop_set_position,
      });
      if (!/^[0-9a-f]{64}$/.test(pick.media.sha256)) {
        throw new Error(`media ${pick.media.id} has corrupt SHA-256 in database`);
      }
      const containerUri = `${MEDIA_CONTAINER_PATH}/${pick.media.sha256}.mp3`;
      const annotated = `annotate:play_history_id="${playId}":${containerUri}`;
      const pushLines = await this.telnet.command(`auto.push ${annotated}`);
      const requestId = parsePushedRequestId(pushLines);
      this.state.last_push_request_id = requestId;

      this.logger.info(
        `Pushed ${pick.media.title || pick.media.original_filename} ` +
          `(media_id=${pick.media.id}, play_history_id=${playId}, request_id=${requestId ?? '?'})`,
      );

      this.onPushed?.({ media: pick.media, requestId, pickReason: pick.reason });
    } catch (err) {
      this.logger.warn(`Scheduler tick failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Liquidsoap's `<id>.queue` returns one or more lines. Each line lists
 * pending request IDs (often comma-separated, sometimes whitespace).
 * Empty queue: zero or one empty line. We count comma+whitespace tokens
 * across all returned lines.
 */
function parseQueueDepth(lines: string[]): number {
  const joined = lines.join(' ').trim();
  if (joined.length === 0) return 0;
  return joined.split(/[\s,]+/).filter((s) => /^\d+$/.test(s)).length;
}

/**
 * `live.status` returns lines like:
 *   "live source: connected"  or  "live: no source connected"
 * We treat any line containing "connected" but not "no source" as live.
 */
function isLiveConnected(lines: string[]): boolean {
  for (const line of lines) {
    if (/no\s*source/i.test(line)) return false;
    if (/connected/i.test(line)) return true;
  }
  return false;
}

/**
 * `<id>.push <uri>` returns the new request id on the first non-empty line.
 * Returns null if we can't parse — the push still happened.
 */
function parsePushedRequestId(lines: string[]): number | null {
  for (const line of lines) {
    const m = /^\s*(\d+)\s*$/.exec(line);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}
