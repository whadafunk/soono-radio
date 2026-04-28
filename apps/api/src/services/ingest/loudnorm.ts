import { spawn } from 'child_process';

export interface LoudnessMeasurement {
  integrated_lufs: number;       // input_i
  loudness_range: number;        // input_lra
  true_peak_db: number;          // input_tp
  threshold: number;             // input_thresh
}

export interface LoudnessPlan {
  measurement: LoudnessMeasurement;
  target_lufs: number;
  gain_db: number;               // gain to apply at playout to hit target
  predicted_peak_after_gain: number;
  warning: string | null;        // set if predicted peak would exceed -1 dBFS
}

const TARGET_LUFS = -23;
const TARGET_LRA = 20;
const TARGET_TP = -1;
const PEAK_CEILING = -1;

export async function measureLoudness(filePath: string): Promise<LoudnessPlan> {
  const stderr = await runFFMpegLoudnorm(filePath);

  // ffmpeg's loudnorm prints a JSON block at the end of stderr when print_format=json.
  // It's wrapped in arbitrary log lines, so we extract the last balanced JSON object.
  const jsonText = extractTrailingJson(stderr);
  if (!jsonText) {
    throw new Error('Could not parse loudnorm JSON from ffmpeg output');
  }

  const parsed = JSON.parse(jsonText);
  const measurement: LoudnessMeasurement = {
    integrated_lufs: parseFloat(parsed.input_i),
    loudness_range: parseFloat(parsed.input_lra),
    true_peak_db: parseFloat(parsed.input_tp),
    threshold: parseFloat(parsed.input_thresh),
  };

  // Edge case: -inf for digital silence. Treat as no normalisation needed.
  if (!Number.isFinite(measurement.integrated_lufs)) {
    return {
      measurement,
      target_lufs: TARGET_LUFS,
      gain_db: 0,
      predicted_peak_after_gain: measurement.true_peak_db,
      warning: 'Source is silent or near-silent; no gain applied',
    };
  }

  const gain_db = TARGET_LUFS - measurement.integrated_lufs;
  const predicted_peak = measurement.true_peak_db + gain_db;
  const warning =
    predicted_peak > PEAK_CEILING
      ? `Predicted peak after gain (${predicted_peak.toFixed(2)} dBFS) exceeds ceiling ${PEAK_CEILING} dBFS — playback will need limiting or accept clipping`
      : null;

  return {
    measurement,
    target_lufs: TARGET_LUFS,
    gain_db,
    predicted_peak_after_gain: predicted_peak,
    warning,
  };
}

function runFFMpegLoudnorm(filePath: string): Promise<string> {
  const filter = `loudnorm=I=${TARGET_LUFS}:LRA=${TARGET_LRA}:TP=${TARGET_TP}:print_format=json`;
  const args = [
    '-hide_banner',
    '-nostats',
    '-i', filePath,
    '-af', filter,
    '-f', 'null',
    '-',
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg loudnorm exited ${code}: ${stderr.split('\n').slice(-5).join('\n')}`));
    });
  });
}

// Find the last well-formed top-level JSON object in a noisy stderr blob.
function extractTrailingJson(text: string): string | null {
  let depth = 0;
  let end = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '}') {
      if (depth === 0) end = i;
      depth++;
    } else if (ch === '{') {
      depth--;
      if (depth === 0 && end !== -1) {
        return text.slice(i, end + 1);
      }
    }
  }
  return null;
}
