import { describe, expect, it } from 'vitest';
import { classifyInFlightItem, type InFlightItem } from './offAir.js';

const NOW = 1_000_000;

function item(overrides: Partial<InFlightItem>): InFlightItem {
  return { confirmed: true, startedAtMs: NOW - 10_000, endedAtMs: null, plannedDurationSeconds: 30, ...overrides };
}

describe('classifyInFlightItem', () => {
  it('treats a pushed-but-unconfirmed item as never aired', () => {
    expect(classifyInFlightItem(item({ confirmed: false }), NOW)).toBe('never_aired');
  });

  it('treats an item with no play_history row as never aired', () => {
    expect(classifyInFlightItem(item({ confirmed: null, startedAtMs: null }), NOW)).toBe('never_aired');
  });

  it('treats a confirmed item still inside its planned duration as cut', () => {
    expect(classifyInFlightItem(item({ startedAtMs: NOW - 10_000, plannedDurationSeconds: 30 }), NOW)).toBe('cut');
  });

  it('treats a confirmed item past its planned end as finished', () => {
    expect(classifyInFlightItem(item({ startedAtMs: NOW - 40_000, plannedDurationSeconds: 30 }), NOW)).toBe('finished');
  });

  it('treats an item ending exactly now as finished, not cut', () => {
    expect(classifyInFlightItem(item({ startedAtMs: NOW - 30_000, plannedDurationSeconds: 30 }), NOW)).toBe('finished');
  });

  it('treats an already-closed row as finished', () => {
    expect(classifyInFlightItem(item({ endedAtMs: NOW - 1_000 }), NOW)).toBe('finished');
  });
});
