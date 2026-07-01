import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getIntegrationsConfig } from '../integrations/config.js';

export interface AudioAnalysisResult {
  bpm: number | null;
  musical_key: string | null;
  key_scale: string | null;
  mood_tags: Array<{ tag: string; score: number }>;
  energy: number | null;
  danceability: number | null;
  warnings?: string[];
}

// Anchor to this file's location so the path works regardless of CWD
// (dev: src/services/ingest/, Docker: dist/services/ingest/ — both 3 levels below apps/api/)
const ANALYSIS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'analysis');
const SCRIPT_PATH = join(ANALYSIS_DIR, 'analyse.py');
const MODELS_DIR = join(ANALYSIS_DIR, 'models');
// Use the venv Python when available; fall back to system python3.
const VENV_PYTHON = join(ANALYSIS_DIR, 'venv', 'bin', 'python3');

export async function runAudioAnalysis(filePath: string): Promise<AudioAnalysisResult> {
  const releaseSlot = await acquireAnalysisSlot();
  try {
    const raw = await run([VENV_PYTHON, SCRIPT_PATH, filePath, MODELS_DIR]);
    const parsed = JSON.parse(raw) as AudioAnalysisResult & { error?: string };
    if (parsed.error) throw new Error(parsed.error);
    return {
      bpm: parsed.bpm ?? null,
      musical_key: parsed.musical_key ?? null,
      key_scale: parsed.key_scale ?? null,
      mood_tags: parsed.mood_tags ?? [],
      energy: parsed.energy ?? null,
      danceability: parsed.danceability ?? null,
      warnings: parsed.warnings,
    };
  } finally {
    releaseSlot();
  }
}

// Caps concurrent analyse.py subprocesses (each can pull several hundred MB
// for TensorFlow/Essentia) so a batch import doesn't fire off N of them at
// once — see docs/deployment.md for why that risks an OOM kill. Re-reads the
// configured max on every acquire so a settings change takes effect for new
// analyses without a restart.
let activeAnalyses = 0;
const analysisWaiters: Array<() => void> = [];

function acquireAnalysisSlot(): Promise<() => void> {
  const max = Math.max(1, getIntegrationsConfig().max_concurrent_analysis);
  if (activeAnalyses < max) {
    activeAnalyses++;
    return Promise.resolve(releaseAnalysisSlot);
  }
  return new Promise((resolve) => {
    analysisWaiters.push(() => {
      activeAnalyses++;
      resolve(releaseAnalysisSlot);
    });
  });
}

function releaseAnalysisSlot(): void {
  activeAnalyses--;
  const next = analysisWaiters.shift();
  if (next) next();
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const [cmd, ...rest] = args;
    const proc = spawn(cmd, rest, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Suppress TensorFlow's benign INFO/WARNING noise (missing-GPU dlerrors,
      // allocator-size notices) so stderr only carries genuine failures.
      env: { ...process.env, TF_CPP_MIN_LOG_LEVEL: '2' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new Error(
          'Audio analysis venv not found — run: ./apps/api/analysis/setup.sh'
        ));
      } else {
        reject(err);
      }
    });
    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        resolve(stdout);
      } else if (signal) {
        const hint =
          signal === 'SIGKILL'
            ? ' — likely killed by the OS for using too much memory (out-of-memory); see docs/deployment.md for RAM requirements'
            : '';
        reject(new Error(`analyse.py was killed by signal ${signal}${hint}: ${stderr.trim()}`));
      } else {
        reject(new Error(`analyse.py exited ${code}: ${stderr.trim()}`));
      }
    });
  });
}
