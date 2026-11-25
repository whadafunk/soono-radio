import { expect, it } from 'vitest';
import { recordingHealth } from './health.js';

const now = 1_000_000_000;
const base = { enabled: true, onAir: true, mixEngineRunning: true, newestFileMtimeMs: now - 5_000, nowMs: now };
it('is healthy while a file is growing', () => expect(recordingHealth(base)).toEqual({ healthy: true, reason: 'ok' }));
it('flags a file that stopped growing a minute ago', () =>
  expect(recordingHealth({ ...base, newestFileMtimeMs: now - 60_000 })).toEqual({ healthy: false, reason: 'not_recording' }));
it('flags no files at all', () =>
  expect(recordingHealth({ ...base, newestFileMtimeMs: null })).toEqual({ healthy: false, reason: 'not_recording' }));
it('is not a problem when the station is off air', () =>
  expect(recordingHealth({ ...base, onAir: false, newestFileMtimeMs: null })).toEqual({ healthy: true, reason: 'off_air' }));
it('is not a recording problem when the mix engine is down', () =>
  expect(recordingHealth({ ...base, mixEngineRunning: false, newestFileMtimeMs: null })).toEqual({ healthy: true, reason: 'mix_engine_down' }));
it('says so when recording is switched off', () =>
  expect(recordingHealth({ ...base, enabled: false, newestFileMtimeMs: null })).toEqual({ healthy: true, reason: 'disabled' }));
