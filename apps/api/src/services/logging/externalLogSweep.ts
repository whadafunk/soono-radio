// Size sweep for log files the API does NOT write itself (LiquidSoap,
// Icecast). Their writers keep the file open in append mode, so rotation by
// rename doesn't work (the writer follows the renamed inode and the fresh
// file never fills) — instead the sweep archives a copy and truncates the
// original in place, which append-mode writers handle transparently. The
// api.log/supervisor.log streams don't need this: they check size on every
// write (rotatingLog.ts).
//
// Runs at boot and then hourly. The window between copy and truncate can
// lose a handful of lines; acceptable for third-party logs.
import { copyFileSync, existsSync, renameSync, statSync, truncateSync, unlinkSync } from 'fs';
import type { SLogger } from '../supervisor2/supervisorLogger.js';
import { readLogSettings } from './logConfig.js';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export function sweepExternalLogs(files: Array<string | null>, logger: SLogger | null): void {
  const settings = readLogSettings();
  const maxBytes = settings.max_file_size_mb * 1024 * 1024;
  for (const file of files) {
    if (file == null || !existsSync(file)) continue;
    const size = statSync(file).size;
    if (size < maxBytes) continue;
    const oldest = `${file}.${settings.rotated_files_kept}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = settings.rotated_files_kept - 1; i >= 1; i--) {
      if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    copyFileSync(file, `${file}.1`);
    truncateSync(file, 0);
    logger?.info(
      { event: 'LOG_SWEPT', file, size_bytes: size },
      'logs: external log over size cap — archived and truncated',
    );
  }
}

export function startExternalLogSweep(
  resolveFiles: () => Array<string | null>,
  logger: SLogger | null,
): void {
  sweepExternalLogs(resolveFiles(), logger);
  const timer = setInterval(() => sweepExternalLogs(resolveFiles(), logger), SWEEP_INTERVAL_MS);
  timer.unref();
}
