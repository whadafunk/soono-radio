// How the parts of a range download can be joined. Parts recorded with the
// same settings are joined by stream copy (exact, fast). If the recording
// quality was changed between them, a stream copy still "succeeds" but the
// result carries the first part's header over audio in another format — a
// file that plays wrong, with no error. Those are re-encoded once, to the
// best format present, so nothing is lost. Pure; see joinMode.test.ts.

export interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitrateKbps: number;
}

export type JoinMode = { mode: 'copy' } | ({ mode: 'reencode' } & AudioFormat);

export function joinMode(formats: AudioFormat[]): JoinMode {
  const first = formats[0];
  const same = formats.every(
    (f) => f.sampleRate === first.sampleRate && f.channels === first.channels && f.bitrateKbps === first.bitrateKbps,
  );
  if (same) return { mode: 'copy' };

  const sampleRate = Math.max(...formats.map((f) => f.sampleRate));
  const channels = Math.max(...formats.map((f) => f.channels));
  let bitrateKbps = Math.max(...formats.map((f) => f.bitrateKbps));
  // Keep the pair encodable as MP3 (see isValidRecordingQuality).
  if (sampleRate <= 24000) bitrateKbps = Math.min(bitrateKbps, 160);
  else bitrateKbps = Math.max(bitrateKbps, 32);
  return { mode: 'reencode', sampleRate, channels, bitrateKbps };
}
