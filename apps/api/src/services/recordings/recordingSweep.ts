// Runs the recordings sweep: gathers the folder, the Protect flags, free disk and the
// settings, asks sweepPlan what to delete, deletes it, and records what
// happened. At API start and every hour (same pattern as the database and
// log sweeps).
import type { RecordingSweepResult } from '@soono/shared';
import type { SLogger } from '../supervisor2/supervisorLogger.js';
import { protectedNames, removeFlagsFor } from './recordingFlags.js';
import { buildRecordingFiles } from './recordingIndex.js';
import { deleteFile, diskUsage, listAllRawFiles } from './recordingStore.js';
import { loadRecordingConfig, writeLastRecordingSweep } from './recordingSettings.js';
import { planSweep } from './sweepPlan.js';

const SWEEP_INTERVAL_MS = 3_600_000;
const GB = 1024 ** 3;

export async function runRecordingSweep(logger: SLogger | null): Promise<RecordingSweepResult | null> {
  const nowMs = Date.now();
  const disk = await diskUsage();
  if (disk == null) {
    // Folder missing: nothing to sweep, and nothing safe to conclude.
    logger?.warn({ event: 'RECORDING_SWEEP_NO_FOLDER' }, 'recordings: folder is missing — sweep skipped');
    return null;
  }

  // Settings unknown → delete nothing. Guessing the defaults here could
  // shorten a longer retention and destroy recordings (recordingSettings.ts).
  const config = loadRecordingConfig();
  if (!config.ok) {
    logger?.error({ event: 'RECORDING_SWEEP_SETTINGS_UNREADABLE' }, 'recordings: retention settings file is damaged — sweep skipped, nothing deleted; save the settings again on Reports → Recordings to repair it');
    return null;
  }
  const settings = config.settings;
  const files = buildRecordingFiles(await listAllRawFiles(), nowMs);

  const plan = planSweep({
    files,
    protectedNames: await protectedNames(),
    nowMs,
    retentionDays: settings.retention_days,
    protectedDays: settings.protected_days,
    freeBytes: disk.freeBytes,
    minFreeBytes: settings.min_free_gb * GB,
  });

  for (const d of plan.deletions) {
    await deleteFile(d.day, d.name);
    logger?.info({ event: 'RECORDING_DELETED', day: d.day, name: d.name, reason: d.reason }, 'recordings: deleted by sweep');
  }
  // A deleted recording takes its labels with it (never a Protect one — those
  // are not in the plan).
  await removeFlagsFor(plan.deletions.map((d) => d.name));

  const result: RecordingSweepResult = {
    at_ms: nowMs,
    deleted_retention: plan.deletions.filter((d) => d.reason === 'retention').length,
    deleted_disk_floor: plan.deletions.filter((d) => d.reason === 'disk_floor').length,
    floor_unmet: plan.floorUnmet,
  };
  writeLastRecordingSweep(settings, result);

  const level = result.floor_unmet || result.deleted_disk_floor > 0 ? 'warn' : 'info';
  logger?.[level]({ event: 'RECORDING_SWEEP', ...result }, result.floor_unmet
    ? 'recordings: disk is below the floor and nothing more can be deleted (protected or younger than the protected age)'
    : 'recordings: sweep complete');
  return result;
}

export function startRecordingSweep(logger: SLogger | null): void {
  const run = () =>
    void runRecordingSweep(logger).catch((err) => {
      logger?.error({ err, event: 'RECORDING_SWEEP_FAILED' }, 'recordings: sweep failed');
    });
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
}
