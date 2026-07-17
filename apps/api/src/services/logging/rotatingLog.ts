// Size-based rotating file stream for the structured JSON logs.
//
// pino has no built-in size rotation (its docs point at logrotate), and this
// deployment has no system logrotate — before this existed, api.log and
// supervisor.log grew unbounded (173MB / 353MB observed on prod 2026-07-17).
// Rotation must be automatic and server-side; the Logs UI only *surfaces*
// state and manual actions on top of it.
//
// Semantics: when the active file would exceed maxBytes, it is renamed to
// <file>.1 (existing .1→.2, …, .keep dropped) and a fresh file is started.
// An oversized pre-existing file rotates at boot, so the first deploy of this
// feature immediately caps the two monster files.
import {
  createWriteStream,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'fs';
import { readLogSettings, type LogSettings } from './logConfig.js';

export class RotatingFileStream {
  private ws: WriteStream;
  private size: number;
  private maxBytes: number;
  private keep: number;

  constructor(readonly filePath: string) {
    const settings = readLogSettings();
    this.maxBytes = settings.max_file_size_mb * 1024 * 1024;
    this.keep = settings.rotated_files_kept;
    if (existsSync(filePath) && statSync(filePath).size >= this.maxBytes) {
      this.shiftFiles();
    }
    this.size = existsSync(filePath) ? statSync(filePath).size : 0;
    this.ws = createWriteStream(filePath, { flags: 'a' });
  }

  // Settings changes apply live — the next write that crosses the new cap
  // rotates. No restart needed.
  applySettings(settings: LogSettings): void {
    this.maxBytes = settings.max_file_size_mb * 1024 * 1024;
    this.keep = settings.rotated_files_kept;
  }

  // pino.multistream calls plain write(chunk) — a full Writable isn't needed.
  write(chunk: string | Buffer): void {
    const len = Buffer.byteLength(chunk);
    if (this.size + len > this.maxBytes) this.rotate();
    this.size += len;
    this.ws.write(chunk);
  }

  rotate(): void {
    this.ws.end();
    this.shiftFiles();
    this.size = 0;
    this.ws = createWriteStream(this.filePath, { flags: 'a' });
  }

  // The purge action truncates the active file out from under the stream.
  // Writes keep working (flags 'a' = O_APPEND), but the internal byte counter
  // must be reset or the next write would trigger a pointless early rotation.
  noteTruncated(): void {
    this.size = 0;
  }

  private shiftFiles(): void {
    const oldest = `${this.filePath}.${this.keep}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = `${this.filePath}.${i}`;
      if (existsSync(from)) renameSync(from, `${this.filePath}.${i + 1}`);
    }
    if (existsSync(this.filePath)) renameSync(this.filePath, `${this.filePath}.1`);
  }
}

// Registry so the logs routes can reach the live streams for manual
// rotate/purge actions. Keyed by log source id ('api', 'supervisor').
const registry = new Map<string, RotatingFileStream>();

export function createRotatingLogStream(sourceId: string, filePath: string): RotatingFileStream {
  const stream = new RotatingFileStream(filePath);
  registry.set(sourceId, stream);
  return stream;
}

export function getRotatingLogStream(sourceId: string): RotatingFileStream | null {
  return registry.get(sourceId) ?? null;
}

export function applyLogSettingsToStreams(settings: LogSettings): void {
  for (const stream of registry.values()) stream.applySettings(settings);
}
