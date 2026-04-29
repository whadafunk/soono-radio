import type { TelnetClient } from './telnet.js';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { playHistory, media as mediaTable } from '../../db/schema.js';
import {
  recordEnded,
  recordPushed,
  recordStarted,
} from './playHistory.js';
import { fetchIcecastStats } from '../icecastStats.js';

const POLL_INTERVAL_MS = 5_000;

interface OpenRowState {
  id: number;
  startedAt: Date;
  expectedDurationSeconds: number | null;
}

/**
 * Polls Liquidsoap telnet to detect track transitions and live
 * source changes. Updates play_history rows accordingly.
 *
 * Approach: when the scheduler pushes a track, it tags the request URI
 * with `annotate:play_history_id="N":/media/<sha>.mp3`. Liquidsoap
 * exposes the current request's metadata via `auto.metadata`. The
 * watcher reads that on each tick; when the visible play_history_id
 * changes, we close the previous row and stamp started_at on the new one.
 *
 * The "live" source is a separate concern: when harbor is connected and
 * the fallback selects it, we open a play_history row with source='live'
 * (no media_id). When live disconnects, we close it.
 */
export class MetadataWatcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private currentAuto: OpenRowState | null = null;
  private currentLive: OpenRowState | null = null;
  private lastSeenSource: 'live' | 'auto' | 'none' = 'none';

  constructor(
    private telnet: TelnetClient,
    private logger: { info: (msg: string) => void; warn: (msg: string) => void },
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Current play_history.id of the auto-source row, if any. */
  getCurrentPlayId(): number | null {
    return this.currentAuto?.id ?? null;
  }

  private async tick(): Promise<void> {
    if (this.busy || !this.telnet.isConnected()) return;
    this.busy = true;
    try {
      // 1. Detect live takeover transitions.
      const liveLines = await this.telnet.command('live.status').catch(() => [] as string[]);
      const liveOn = isLiveConnected(liveLines);

      // Live transition: 'auto' → 'live'
      if (liveOn && this.lastSeenSource !== 'live') {
        const liveListenerCount = await safeListenerCount();
        // Close the auto row as aborted (live cut it short).
        if (this.currentAuto) {
          await recordEnded({
            id: this.currentAuto.id,
            endedAt: new Date(),
            aborted: true,
          });
          this.currentAuto = null;
        }
        // Open a new live row (no media_id, no expected duration).
        const id = await recordPushed({
          mediaId: null,
          source: 'live',
          pickReason: 'harbor connected',
        });
        const startedAt = new Date();
        await recordStarted({ id, startedAt, liveListenerCount });
        this.currentLive = { id, startedAt, expectedDurationSeconds: null };
        this.logger.info(`Live source connected (play_history_id=${id})`);
      }

      // Live transition: 'live' → 'auto'
      if (!liveOn && this.lastSeenSource === 'live' && this.currentLive) {
        await recordEnded({
          id: this.currentLive.id,
          endedAt: new Date(),
          aborted: false,
        });
        this.logger.info(`Live source disconnected (play_history_id=${this.currentLive.id})`);
        this.currentLive = null;
      }

      this.lastSeenSource = liveOn ? 'live' : 'auto';

      // While live is on-air, the auto-source isn't audible; skip auto
      // metadata polling.
      if (liveOn) return;

      // 2. Auto-source: read the queue's current track metadata.
      const metadataLines = await this.telnet
        .command('auto.metadata')
        .catch(() => [] as string[]);
      const metadata = parseMetadataBlock(metadataLines);
      const seenPlayId = parseInt(metadata.play_history_id ?? '', 10);

      // No metadata yet (queue hasn't started a track) — nothing to do.
      if (!Number.isFinite(seenPlayId)) return;

      // Same row as before — no transition.
      if (this.currentAuto && this.currentAuto.id === seenPlayId) return;

      // New auto row took over. Close the previous one.
      if (this.currentAuto) {
        const playedSeconds =
          (Date.now() - this.currentAuto.startedAt.getTime()) / 1000;
        const expected = this.currentAuto.expectedDurationSeconds ?? 0;
        const aborted = expected > 0 && playedSeconds < expected - 5;
        await recordEnded({
          id: this.currentAuto.id,
          endedAt: new Date(),
          aborted,
        });
      }

      // Stamp the new row's actual play-start time and snapshot listener count.
      const liveListenerCount = await safeListenerCount();
      const startedAt = new Date();
      await recordStarted({ id: seenPlayId, startedAt, liveListenerCount });

      // Look up the track's expected duration so we can compute "aborted"
      // correctly when the next track replaces this one.
      const trackRows = await db
        .select({
          id: playHistory.id,
          duration_seconds: mediaTable.duration_seconds,
        })
        .from(playHistory)
        .leftJoin(mediaTable, eq(playHistory.media_id, mediaTable.id))
        .where(eq(playHistory.id, seenPlayId))
        .limit(1);
      const expectedDurationSeconds = trackRows[0]?.duration_seconds ?? null;

      this.currentAuto = { id: seenPlayId, startedAt, expectedDurationSeconds };
      this.logger.info(
        `Now playing play_history_id=${seenPlayId} ` +
          (expectedDurationSeconds ? `(${expectedDurationSeconds.toFixed(0)}s)` : ''),
      );
    } catch (err) {
      this.logger.warn(`Metadata watcher tick failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Liquidsoap telnet returns metadata as one key="value" per line.
 * Robust against stray whitespace; ignores lines that don't match.
 */
function parseMetadataBlock(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const m = /^\s*([\w.\-]+)\s*=\s*"(.*)"\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2];
  }
  return out;
}

function isLiveConnected(lines: string[]): boolean {
  for (const line of lines) {
    if (/no\s*source/i.test(line)) return false;
    if (/connected/i.test(line)) return true;
  }
  return false;
}

async function safeListenerCount(): Promise<number | null> {
  try {
    const stats = await fetchIcecastStats();
    return stats.listener ?? null;
  } catch {
    return null;
  }
}
