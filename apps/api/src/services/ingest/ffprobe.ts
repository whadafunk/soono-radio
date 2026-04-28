import { spawn } from 'child_process';

export interface ProbeResult {
  format_name: string;          // e.g. 'mp3', 'flac', 'wav', 'mov,mp4,m4a'
  duration_seconds: number;
  bitrate_kbps: number;          // overall container bitrate
  samplerate_hz: number;
  channels: number;
  codec: string;                 // e.g. 'mp3', 'flac', 'pcm_s16le'
  audio_streams: number;
}

interface FFProbeJson {
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    sample_rate?: string;
    channels?: number;
    bit_rate?: string;
  }>;
}

export async function ffprobe(filePath: string): Promise<ProbeResult> {
  const stdout = await runFFProbe([
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  const parsed: FFProbeJson = JSON.parse(stdout);
  const audioStreams = (parsed.streams ?? []).filter((s) => s.codec_type === 'audio');
  if (audioStreams.length === 0) {
    throw new Error('No audio stream found in file');
  }

  const audio = audioStreams[0];
  const format = parsed.format ?? {};

  const containerBitrate = format.bit_rate ? parseInt(format.bit_rate, 10) : 0;
  const streamBitrate = audio.bit_rate ? parseInt(audio.bit_rate, 10) : 0;
  const bestBitrateBps = containerBitrate || streamBitrate;

  return {
    format_name: format.format_name ?? 'unknown',
    duration_seconds: format.duration ? parseFloat(format.duration) : 0,
    bitrate_kbps: bestBitrateBps ? Math.round(bestBitrateBps / 1000) : 0,
    samplerate_hz: audio.sample_rate ? parseInt(audio.sample_rate, 10) : 0,
    channels: audio.channels ?? 0,
    codec: audio.codec_name ?? 'unknown',
    audio_streams: audioStreams.length,
  };
}

function runFFProbe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`ffprobe exited ${code}: ${stderr.trim()}`));
    });
  });
}
