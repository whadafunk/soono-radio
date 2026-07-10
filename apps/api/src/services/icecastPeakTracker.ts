import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { fetchAllMountStats } from './icecastStats.js';

const STATE_PATH =
  process.env.ICECAST_PEAK_STATE || join(process.cwd(), '..', '..', 'data', 'icecast-peak.json');

const SAMPLE_INTERVAL_MS = 10_000;

interface PeakState {
  peak_listener: number;
  since: string;
}

let cachedState: PeakState = { peak_listener: 0, since: new Date().toISOString() };

async function loadState(): Promise<void> {
  try {
    const raw = await readFile(STATE_PATH, 'utf-8');
    cachedState = JSON.parse(raw);
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function persistState(): Promise<void> {
  await writeFile(STATE_PATH, JSON.stringify(cachedState, null, 2) + '\n', 'utf-8');
}

export function getPeakState(): PeakState {
  return cachedState;
}

export async function resetPeakState(currentListenerCount: number): Promise<PeakState> {
  cachedState = { peak_listener: currentListenerCount, since: new Date().toISOString() };
  await persistState();
  return cachedState;
}

async function sampleAndUpdatePeak(): Promise<void> {
  try {
    const { listener } = await fetchAllMountStats();
    if (listener > cachedState.peak_listener) {
      cachedState = { ...cachedState, peak_listener: listener };
      await persistState();
    }
  } catch {
    // Icecast unreachable this tick — fetchAllMountStats already logs; skip silently.
  }
}

export async function startPeakTracker(): Promise<void> {
  await loadState();
  setInterval(() => void sampleAndUpdatePeak(), SAMPLE_INTERVAL_MS);
}
