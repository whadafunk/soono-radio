import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { IntegrationsConfig, IntegrationsConfigSchema } from '@soono/shared';

const CONFIG_PATH =
  process.env.INTEGRATIONS_CONFIG ||
  join(process.cwd(), '..', '..', 'data', 'integrations-config.json');

const DEFAULT_CONFIG: IntegrationsConfig = IntegrationsConfigSchema.parse({});

let cachedConfig: IntegrationsConfig = DEFAULT_CONFIG;

export async function loadIntegrationsConfig(): Promise<IntegrationsConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    cachedConfig = IntegrationsConfigSchema.parse(JSON.parse(raw));
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    cachedConfig = DEFAULT_CONFIG;
  }
  return cachedConfig;
}

export function getIntegrationsConfig(): IntegrationsConfig {
  return cachedConfig;
}

export async function writeIntegrationsConfig(config: IntegrationsConfig): Promise<void> {
  cachedConfig = IntegrationsConfigSchema.parse(config);
  await writeFile(CONFIG_PATH, JSON.stringify(cachedConfig, null, 2) + '\n', 'utf-8');
}
