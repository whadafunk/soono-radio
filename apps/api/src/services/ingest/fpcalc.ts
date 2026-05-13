import { spawn } from 'child_process';

export interface FpCalcResult {
  fingerprint: string;
  duration: number;
}

export async function runFpcalc(filePath: string): Promise<FpCalcResult> {
  const stdout = await run(['-json', filePath]);
  const parsed = JSON.parse(stdout) as { duration: number; fingerprint: string };
  return {
    fingerprint: parsed.fingerprint,
    duration: Math.round(parsed.duration),
  };
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('fpcalc', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new Error('fpcalc not found — install Chromaprint: brew install chromaprint'));
      } else {
        reject(err);
      }
    });
    proc.on('close', (code: number | null) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`fpcalc exited ${code ?? '?'}: ${stderr.trim()}`));
    });
  });
}
