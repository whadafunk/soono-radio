// LiquidSoap fragments for the recording output — pure string builders, so
// the exact text that reaches the generated script is unit-tested
// (recordingScript.test.ts). The surrounding guarded block lives in
// liquidsoap/mix-engine.liq.hbs; see docs/reports-recordings-design.md.
import type { RecordingConfig } from '@soono/shared';

export function recordingEncoder(r: RecordingConfig): string {
  return `%mp3(bitrate=${r.bitrate_kbps}, samplerate=${r.samplerate_hz}, stereo=${r.channels === 'stereo'})`;
}

// The source the recording output reads. Mono is the mean of both channels,
// not the left one alone.
export function recordingSource(r: RecordingConfig): string {
  return r.channels === 'stereo' ? 'radio' : 'mean(radio)';
}

// When LiquidSoap closes the current file and opens the next: on clock
// boundaries, so every file but the first after a restart starts on the
// quarter, half or full hour.
export function recordingReopenPredicate(segmentMinutes: RecordingConfig['segment_minutes']): string {
  const marks: string[] = [];
  for (let m = 0; m < 60; m += segmentMinutes) marks.push(`${m}m0s`);
  return `{${marks.join(' or ')}}`;
}
