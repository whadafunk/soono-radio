// Decode-based verification: play the whole file through ffmpeg's null
// muxer and report how much audio ACTUALLY decodes, plus any decode errors.
//
// Why this exists: ffprobe's duration (ffprobe.ts) is a header read — for
// MP3 it comes from the Xing/LAME frame or a bitrate×filesize estimate. A
// truncated file (interrupted download/copy) keeps its original header
// claiming the full length, so ffprobe reports e.g. 6:00 for a file with
// 2:30 of decodable audio. The planner then budgets with the lie and the
// track ends far early on air. Only decoding end-to-end reveals the truth.
import { spawn } from 'child_process';

export interface DecodeVerifyResult {
  decoded_duration_seconds: number;
  decode_error_count: number;
  // First few stderr lines, for the integrity detail / logs.
  error_sample: string[];
  // ffmpeg exited non-zero (file unreadable / decoder gave up entirely).
  failed: boolean;
}

const ERROR_SAMPLE_MAX = 3;

// ffmpeg -v error also complains about malformed metadata (ID3 comment
// frames with a bad BOM, unreadable tag frames it then skips). Those are
// tag-parser noise, not audio corruption — a file flagged for them would be
// a false positive that erodes trust in the integrity flag. Real audio
// decode errors look like "Header missing", "Invalid data found when
// processing input", "Error while decoding stream".
const BENIGN_STDERR = [/Incorrect BOM value/i, /Error reading \S+ frame\b.*skipped/i];

function isBenignStderrLine(line: string): boolean {
  return BENIGN_STDERR.some((re) => re.test(line));
}

export function decodeVerify(filePath: string): Promise<DecodeVerifyResult> {
  return new Promise((resolve, reject) => {
    // -map 0:a:0 decodes exactly the first audio stream — embedded cover art
    // (an attached mjpeg "video" stream in many MP3s) would otherwise pollute
    // both the progress clock and the error count.
    const proc = spawn(
      'ffmpeg',
      ['-hide_banner', '-v', 'error', '-nostdin', '-progress', 'pipe:1',
       '-i', filePath, '-map', '0:a:0', '-f', 'null', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let lastOutTimeUs = 0;
    let stdoutBuf = '';
    let stderrBuf = '';
    let errorCount = 0;
    const errorSample: string[] = [];

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.startsWith('out_time_us=')) {
          const v = parseInt(line.slice('out_time_us='.length), 10);
          if (Number.isFinite(v) && v > lastOutTimeUs) lastOutTimeUs = v;
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk;
      let idx: number;
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, idx).trim();
        stderrBuf = stderrBuf.slice(idx + 1);
        if (line.length === 0 || isBenignStderrLine(line)) continue;
        errorCount += 1;
        if (errorSample.length < ERROR_SAMPLE_MAX) errorSample.push(line);
      }
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({
        decoded_duration_seconds: lastOutTimeUs / 1_000_000,
        decode_error_count: errorCount,
        error_sample: errorSample,
        failed: code !== 0,
      });
    });
  });
}

// A header-vs-decoded difference is a real mismatch (not codec padding /
// estimation noise) when it exceeds both an absolute and a relative floor.
export function durationMismatchTolerance(claimedSeconds: number): number {
  return Math.max(2, claimedSeconds * 0.02);
}
