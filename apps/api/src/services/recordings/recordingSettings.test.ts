import { describe, expect, it } from 'vitest';
import { interpretStoredConfig } from './recordingSettings.js';

describe('interpretStoredConfig', () => {
  it('uses the defaults when there is no file yet', () => {
    expect(interpretStoredConfig(null)).toEqual({
      ok: true, settings: { retention_days: 60, min_free_gb: 10, protected_days: 30 }, lastSweep: null,
    });
  });
  it('reads stored settings and the last sweep', () => {
    const text = JSON.stringify({ settings: { retention_days: 365, min_free_gb: 5, protected_days: 180 }, last_sweep: { at_ms: 1, deleted_retention: 0, deleted_disk_floor: 0, floor_unmet: false } });
    const r = interpretStoredConfig(text);
    expect(r.ok && r.settings).toEqual({ retention_days: 365, min_free_gb: 5, protected_days: 180 });
    expect(r.ok && r.lastSweep?.at_ms).toBe(1);
  });
  it.each(['', '{"settings": {"retention_days": 365', 'not json', '{"settings": {"retention_days": -1}}', '[]'])
    ('refuses to guess when the file is damaged: %j', (text) => {
      expect(interpretStoredConfig(text)).toEqual({ ok: false });
    });
});
