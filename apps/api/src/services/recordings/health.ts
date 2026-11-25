// Is the broadcast being recorded right now? A station that believes it has
// two months of proof and has none is worse off than one that knows — so
// "recording should be happening and no file is growing" is a visible
// problem (Dashboard banner, Recordings tab). Pure; see health.test.ts.

// A file that has not grown for this long is not being written.
const STALLED_AFTER_MS = 60_000;

export type RecordingHealthReason = 'ok' | 'disabled' | 'off_air' | 'mix_engine_down' | 'not_recording';

export function recordingHealth(input: {
  enabled: boolean;
  onAir: boolean;
  mixEngineRunning: boolean;
  newestFileMtimeMs: number | null;
  nowMs: number;
}): { healthy: boolean; reason: RecordingHealthReason } {
  // Not expected to be recording — nothing to warn about here; the existing
  // Dashboard cards already show an off-air station or a stopped mix engine.
  if (!input.enabled) return { healthy: true, reason: 'disabled' };
  if (!input.onAir) return { healthy: true, reason: 'off_air' };
  if (!input.mixEngineRunning) return { healthy: true, reason: 'mix_engine_down' };

  const growing = input.newestFileMtimeMs != null && input.nowMs - input.newestFileMtimeMs < STALLED_AFTER_MS;
  return growing ? { healthy: true, reason: 'ok' } : { healthy: false, reason: 'not_recording' };
}
