// Joins the recordings covering a time range into one MP3, without
// re-encoding: each part is trimmed with a stream copy, then the parts are
// concatenated. ffmpeg is already in the API image (ingest uses it).
// Arguments always go to spawn() as an array — never through a shell.
import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { filePath } from './recordingStore.js';
import { joinMode, type AudioFormat } from './joinMode.js';
import type { RangePart } from './rangePlan.js';

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const lastLine = stderr.trim().split('\n').pop() ?? '';
      reject(new Error(`ffmpeg failed (${code}): ${lastLine}`));
    });
  });
}

const seconds = (ms: number): string => (ms / 1000).toFixed(3);

// Sample rate, channels and bitrate of a recording, read from the file.
function probeFormat(path: string): Promise<AudioFormat> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate,channels,bit_rate', '-of', 'json', path,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const stream = (JSON.parse(out) as { streams?: Array<{ sample_rate?: string; channels?: number; bit_rate?: string }> }).streams?.[0];
        if (code !== 0 || !stream) throw new Error('no audio stream');
        resolve({
          sampleRate: Number(stream.sample_rate),
          channels: Number(stream.channels),
          bitrateKbps: Math.round(Number(stream.bit_rate) / 1000),
        });
      } catch (err) {
        reject(new Error(`could not read the format of a recording: ${(err as Error).message}`));
      }
    });
  });
}

// Builds the joined file in a fresh temp folder. The caller streams
// `outputPath` and then calls `cleanup()` — also on error or client abort.
export async function exportRange(parts: RangePart[]): Promise<{ outputPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'soono-recording-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const partPaths: string[] = [];
    for (const [i, part] of parts.entries()) {
      const out = join(dir, `part-${String(i).padStart(4, '0')}.mp3`);
      await runFfmpeg([
        '-ss', seconds(part.skipMs), '-t', seconds(part.takeMs),
        '-i', filePath(part.day, part.name),
        '-c', 'copy', '-f', 'mp3', out,
      ]);
      partPaths.push(out);
    }
    if (partPaths.length === 1) return { outputPath: partPaths[0], cleanup };

    // Same settings throughout → exact stream copy. If the recording quality
    // changed inside the range, re-encode once to the best format present
    // (a stream copy would "succeed" and produce a file that plays wrong).
    const join_ = joinMode(await Promise.all(partPaths.map(probeFormat)));
    const codec = join_.mode === 'copy'
      ? ['-c', 'copy']
      : ['-c:a', 'libmp3lame', '-b:a', `${join_.bitrateKbps}k`, '-ar', String(join_.sampleRate), '-ac', String(join_.channels)];

    const listPath = join(dir, 'parts.txt');
    await writeFile(listPath, partPaths.map((p) => `file '${p}'`).join('\n') + '\n', 'utf-8');
    const outputPath = join(dir, 'range.mp3');
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, ...codec, '-f', 'mp3', outputPath]);
    // The parts are no longer needed; don't hold twice the range on disk
    // while the result is being downloaded.
    await Promise.all(partPaths.map((p) => rm(p, { force: true })));
    return { outputPath, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
