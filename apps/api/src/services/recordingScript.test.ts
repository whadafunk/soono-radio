import { describe, expect, it } from 'vitest';
import { LiquidsoapConfigSchema, isValidRecordingQuality } from '@soono/shared';
import { recordingEncoder, recordingReopenPredicate, recordingSource } from './recordingScript.js';

const base = { enabled: true, bitrate_kbps: 64, samplerate_hz: 22050, channels: 'mono', segment_minutes: 60 } as const;

// A mix-engine config as stored before recording existed (no `recording` block).
const existingConfigWithoutRecording = {
  output: { icecast_port: 8000, icecast_mount: '/stream', codec: 'mp3', bitrate_kbps: 256 },
  harbor: { enabled: true, port: 8005, mount_name: 'live', password: 'secret', tls: { enabled: false, certificate_path: null }, live_mode: 'takeover' },
  crossfade: { duration_seconds: 3, smart: false, fade_shape: 'linear' },
};

describe('recording script fragments', () => {
  it('builds the default encoder', () => {
    expect(recordingEncoder(base)).toBe('%mp3(bitrate=64, samplerate=22050, stereo=false)');
  });
  it('builds a stereo encoder', () => {
    expect(recordingEncoder({ ...base, bitrate_kbps: 128, samplerate_hz: 44100, channels: 'stereo' }))
      .toBe('%mp3(bitrate=128, samplerate=44100, stereo=true)');
  });
  it('feeds mono from the mean of both channels', () => {
    expect(recordingSource(base)).toBe('mean(radio)');
    expect(recordingSource({ ...base, channels: 'stereo' })).toBe('radio');
  });
  it('rotates on clock boundaries', () => {
    expect(recordingReopenPredicate(60)).toBe('{0m0s}');
    expect(recordingReopenPredicate(30)).toBe('{0m0s or 30m0s}');
    expect(recordingReopenPredicate(15)).toBe('{0m0s or 15m0s or 30m0s or 45m0s}');
  });
});

describe('isValidRecordingQuality', () => {
  it.each([[64, 22050], [128, 22050], [32, 44100], [192, 44100], [128, 32000]])('accepts %i kbps at %i Hz', (b, s) => {
    expect(isValidRecordingQuality(b, s)).toBe(true);
  });
  it.each([[192, 22050], [16, 44100], [64, 48000], [0, 22050]])('rejects %i kbps at %i Hz', (b, s) => {
    expect(isValidRecordingQuality(b, s)).toBe(false);
  });
});

describe('recording config', () => {
  it('defaults the recording block when the stored config has none', () => {
    const parsed = LiquidsoapConfigSchema.parse(existingConfigWithoutRecording);
    expect(parsed.recording).toEqual(base);
  });
  it('refuses a quality MP3 cannot encode', () => {
    const bad = { ...existingConfigWithoutRecording, recording: { ...base, bitrate_kbps: 192 } };
    expect(LiquidsoapConfigSchema.safeParse(bad).success).toBe(false);
  });
});
