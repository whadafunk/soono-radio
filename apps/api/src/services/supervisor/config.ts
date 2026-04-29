import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { SupervisorConfig, SupervisorConfigSchema } from '@radio/shared';

const CONFIG_PATH =
  process.env.SUPERVISOR_CONFIG ||
  join(process.cwd(), '..', '..', 'data', 'supervisor-config.json');

const DEFAULT_CONFIG: SupervisorConfig = SupervisorConfigSchema.parse({});

let cachedConfig: SupervisorConfig = DEFAULT_CONFIG;

/** Read from disk on boot; falls back to defaults when the file is missing. */
export async function loadSupervisorConfig(): Promise<SupervisorConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    cachedConfig = SupervisorConfigSchema.parse(JSON.parse(raw));
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    cachedConfig = DEFAULT_CONFIG;
  }
  return cachedConfig;
}

export function getSupervisorConfig(): SupervisorConfig {
  return cachedConfig;
}

export async function writeSupervisorConfig(config: SupervisorConfig): Promise<void> {
  cachedConfig = SupervisorConfigSchema.parse(config);
  await writeFile(CONFIG_PATH, JSON.stringify(cachedConfig, null, 2) + '\n', 'utf-8');
}
