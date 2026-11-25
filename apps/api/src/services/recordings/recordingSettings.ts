// Retention settings and the last sweep's result, persisted as a small JSON
// file next to the other config files in data/.
//
// FAIL-SAFE ON PURPOSE. These settings decide what the sweep deletes. If the
// file is damaged (the disk filled while it was being written, say), falling
// back to the defaults would silently shorten a longer retention and delete
// recordings that cannot be recovered. So: a missing file means defaults, a
// DAMAGED file means "unknown" — the sweep then does nothing and says so —
// and every write goes to a temp file first and is renamed into place, so a
// failed write can never leave a half-written file behind.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { RecordingSettingsSchema, type RecordingSettings, type RecordingSweepResult } from '@soono/shared';

const CONFIG_PATH =
  process.env.RECORDINGS_CONFIG || join(process.cwd(), '..', '..', 'data', 'recordings-config.json');

export type StoredRecordingConfig =
  | { ok: true; settings: RecordingSettings; lastSweep: RecordingSweepResult | null }
  | { ok: false };

// `text` is the file's content, or null when there is no file yet.
export function interpretStoredConfig(text: string | null): StoredRecordingConfig {
  if (text == null) return { ok: true, settings: RecordingSettingsSchema.parse({}), lastSweep: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
  const stored = raw as { settings?: unknown; last_sweep?: RecordingSweepResult };
  const settings = RecordingSettingsSchema.safeParse(stored.settings ?? {});
  if (!settings.success) return { ok: false };
  return { ok: true, settings: settings.data, lastSweep: stored.last_sweep ?? null };
}

export function loadRecordingConfig(): StoredRecordingConfig {
  if (!existsSync(CONFIG_PATH)) return interpretStoredConfig(null);
  try {
    return interpretStoredConfig(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return { ok: false }; // exists but cannot be read
  }
}

function writeConfig(settings: RecordingSettings, lastSweep: RecordingSweepResult | null): void {
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify({ settings, ...(lastSweep ? { last_sweep: lastSweep } : {}) }, null, 2) + '\n', 'utf-8');
  renameSync(tmp, CONFIG_PATH);
}

// An explicit save by the operator replaces whatever was there — it is also
// how a damaged file gets repaired.
export function writeRecordingSettings(settings: RecordingSettings): void {
  const current = loadRecordingConfig();
  writeConfig(settings, current.ok ? current.lastSweep : null);
}

// Only ever called by a sweep that already loaded a good config.
export function writeLastRecordingSweep(settings: RecordingSettings, result: RecordingSweepResult): void {
  writeConfig(settings, result);
}
