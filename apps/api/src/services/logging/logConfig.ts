// Log rotation settings, persisted as a small JSON file (same pattern as
// integrations-config.json). Read synchronously because the api.log stream is
// created before anything async (DB, routes) is up.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const CONFIG_PATH =
  process.env.LOGS_CONFIG || join(process.cwd(), '..', '..', 'data', 'logs-config.json');

export interface LogSettings {
  max_file_size_mb: number;
  rotated_files_kept: number;
}

export const DEFAULT_LOG_SETTINGS: LogSettings = {
  max_file_size_mb: 25,
  rotated_files_kept: 3,
};

export function readLogSettings(): LogSettings {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Partial<LogSettings>;
      return {
        max_file_size_mb:
          typeof raw.max_file_size_mb === 'number' && raw.max_file_size_mb >= 1
            ? raw.max_file_size_mb
            : DEFAULT_LOG_SETTINGS.max_file_size_mb,
        rotated_files_kept:
          typeof raw.rotated_files_kept === 'number' && raw.rotated_files_kept >= 1
            ? raw.rotated_files_kept
            : DEFAULT_LOG_SETTINGS.rotated_files_kept,
      };
    }
  } catch {
    // fall through to defaults — a corrupt config must never block boot
  }
  return { ...DEFAULT_LOG_SETTINGS };
}

export function writeLogSettings(settings: LogSettings): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(settings, null, 2) + '\n');
}
