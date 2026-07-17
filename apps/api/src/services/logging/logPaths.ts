// Central path resolution for every log file the API knows about.
//
// Two directory roots, resolved so the same code works in dev (tsx from
// apps/api, repo checkout layout) and in the container (WORKDIR /app,
// ./logs mounted at /app/logs, ./icecast mounted at /icecast):
//   - LOG_DIR      — repo-root/logs         (api.log, supervisor.log, liquidsoap/)
//   - ICECAST_LOG_DIR — repo-root/icecast/logs (written by the icecast container)
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

// Five levels up from this file = repo root, both compiled
// (apps/api/dist/services/logging/) and in dev (apps/api/src/services/logging/).
const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));

export const LOG_DIR = join(REPO_ROOT, 'logs');
export const API_LOG_FILE = join(LOG_DIR, 'api.log');
export const SUPERVISOR_LOG_FILE = join(LOG_DIR, 'supervisor.log');
// LiquidSoap writes here via the ./logs/liquidsoap:/var/log/liquidsoap mount.
export const LIQUIDSOAP_LOG_DIR = join(LOG_DIR, 'liquidsoap');
// Same cwd-relative convention icecastConfig.ts uses for icecast.xml —
// resolves to /icecast/logs in the container and repo/icecast/logs in dev.
export const ICECAST_LOG_DIR =
  process.env.ICECAST_LOG_DIR || join(process.cwd(), '..', '..', 'icecast', 'logs');

// LiquidSoap logs into its mounted directory with no fixed filename — pick
// the most recently modified .log file.
export function newestLogIn(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let best: string | null = null;
  let bestMtime = -1;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.log')) continue;
    const full = join(dir, name);
    const mtime = statSync(full).mtimeMs;
    if (mtime > bestMtime) { bestMtime = mtime; best = full; }
  }
  return best;
}
