import { spawn } from 'child_process';
import type { ProbeResult } from './ffprobe.js';

const MP3_BITRATE_KBPS = 256;
const MP3_SAMPLERATE_HZ = 44100;
// Container format names produced by ffprobe for MP3 inputs.
const MP3_FORMAT_NAMES = new Set(['mp3', 'mp3float']);

export interface TranscodeDecision {
  needs_transcode: boolean;
  reason: string;
}

/**
 * Implements the storage-format rule from plan §"Locked decisions":
 * - Always store as MP3 256 kbps CBR
 * - Re-encode if input is non-MP3, or MP3 with bitrate > 256 kbps
 * - MP3 ≤ 256 kbps is moved through unmodified
 */
export function decideTranscode(probe: ProbeResult): TranscodeDecision {
  const isMp3 = MP3_FORMAT_NAMES.has(probe.format_name) || probe.codec === 'mp3';
  if (!isMp3) {
    return { needs_transcode: true, reason: `Input format is ${probe.format_name} (codec ${probe.codec}); transcoding to MP3 ${MP3_BITRATE_KBPS}k` };
  }
  if (probe.bitrate_kbps > MP3_BITRATE_KBPS) {
    return { needs_transcode: true, reason: `Input is MP3 ${probe.bitrate_kbps}k > ${MP3_BITRATE_KBPS}k cap; re-encoding` };
  }
  return { needs_transcode: false, reason: `Input is MP3 ${probe.bitrate_kbps}k ≤ ${MP3_BITRATE_KBPS}k; passing through unmodified` };
}

export async function transcodeToMp3(input: string, output: string): Promise<void> {
  const args = [
    '-hide_banner',
    '-nostats',
    '-y',                                // overwrite output if exists (we control the path)
    '-i', input,
    '-c:a', 'libmp3lame',
    '-b:a', `${MP3_BITRATE_KBPS}k`,
    '-ar', String(MP3_SAMPLERATE_HZ),
    '-ac', '2',                          // force stereo for predictability
    '-map_metadata', '0',                // preserve tags from input where possible
    output,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg transcode exited ${code}: ${stderr.split('\n').slice(-5).join('\n')}`));
    });
  });
}

export const TRANSCODE_DEFAULTS = {
  bitrate_kbps: MP3_BITRATE_KBPS,
  samplerate_hz: MP3_SAMPLERATE_HZ,
  channels: 2,
};

export interface ReTranscodeOptions {
  mode: 'cbr' | 'vbr';
  channels: 'preserve' | 'stereo' | 'mono';
  trim_silence: boolean;
}

/**
 * Re-encode an existing MP3 with operator-chosen options. Source is the
 * already-stored MP3 in the media pool; output is a temp file. Quality
 * degrades slightly per pass — this is exposed as a deliberate operator
 * action, not an automatic one.
 */
export async function reTranscodeMp3(
  input: string,
  output: string,
  options: ReTranscodeOptions,
): Promise<void> {
  const args: string[] = ['-hide_banner', '-nostats', '-y', '-i', input];

  if (options.trim_silence) {
    // Strip leading and trailing silence below -50 dBFS. The two-step
    // (trim head, reverse, trim head, reverse) is the canonical idiom.
    const filter =
      'silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB:detection=peak,' +
      'areverse,silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB:detection=peak,areverse';
    args.push('-af', filter);
  }

  args.push('-c:a', 'libmp3lame');
  if (options.mode === 'vbr') {
    // -V 2 ≈ 190 kbps avg — good quality / size tradeoff. Lower is
    // higher quality (V0 ≈ 245).
    args.push('-q:a', '2');
  } else {
    args.push('-b:a', `${MP3_BITRATE_KBPS}k`);
  }

  args.push('-ar', String(MP3_SAMPLERATE_HZ));
  if (options.channels === 'stereo') args.push('-ac', '2');
  else if (options.channels === 'mono') args.push('-ac', '1');
  // 'preserve': don't pass -ac, ffmpeg keeps input layout.

  args.push('-map_metadata', '0', output);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg re-transcode exited ${code}: ${stderr.split('\n').slice(-5).join('\n')}`));
    });
  });
}
