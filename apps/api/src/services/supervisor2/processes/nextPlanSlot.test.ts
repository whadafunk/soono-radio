import { describe, expect, it } from 'vitest';
import { judgeHeldNextPlan, type HeldNextPlan } from './nextPlanSlot.js';

const HOUR_07 = 1794294000000;
const HOUR_20_YESTERDAY = 1794254400000;

function held(overrides: Partial<HeldNextPlan> = {}): HeldNextPlan {
  return {
    segment_id: 229,
    clock_instance_started_at: HOUR_07,
    status: 'finalized',
    hasPushedItem: false,
    ...overrides,
  };
}

describe('judgeHeldNextPlan', () => {
  const expected = { segmentId: 229, clockInstanceStartedAt: HOUR_07 };

  it('keeps the plan that follows the plan going on air', () => {
    expect(judgeHeldNextPlan(held(), expected, null)).toBe('keep');
    expect(judgeHeldNextPlan(held({ status: 'Transitioning', hasPushedItem: true }), expected, 0)).toBe('keep');
  });

  it('releases a dangling pointer', () => {
    expect(judgeHeldNextPlan(null, expected, null)).toBe('release');
  });

  it('releases an unpushed plan for a different segment (2026-11-10 Align: 07:45 stop-set held while the 07:30 stop-set activated)', () => {
    expect(judgeHeldNextPlan(held({ segment_id: 230, status: 'draft' }), expected, null)).toBe('release');
  });

  it('releases an unpushed plan for the same segment of a different hour', () => {
    expect(judgeHeldNextPlan(held({ clock_instance_started_at: HOUR_20_YESTERDAY }), expected, null)).toBe('release');
  });

  it('invalidates a Transitioning leftover whose push LiquidSoap no longer holds (2026-11-10: plan 29743, last night\'s hour, LS restarted)', () => {
    const leftover = held({ segment_id: 227, clock_instance_started_at: HOUR_20_YESTERDAY, status: 'Transitioning', hasPushedItem: true });
    expect(judgeHeldNextPlan(leftover, expected, 0)).toBe('invalidate');
  });

  it('keeps a mismatched plan whose pushed item may still be in LiquidSoap\'s queue', () => {
    const pushed = held({ segment_id: 230, status: 'Transitioning', hasPushedItem: true });
    expect(judgeHeldNextPlan(pushed, expected, 1)).toBe('keep');
    // LiquidSoap unreachable — unknown is not proof the push is gone.
    expect(judgeHeldNextPlan(pushed, expected, null)).toBe('keep');
  });

  it('releases a mismatched draft that was pushed once LiquidSoap\'s queue is confirmed empty', () => {
    expect(judgeHeldNextPlan(held({ segment_id: 230, status: 'draft', hasPushedItem: true }), expected, 0)).toBe('release');
  });

  it('releases terminal plans and leaves an active one alone', () => {
    expect(judgeHeldNextPlan(held({ segment_id: 230, status: 'completed' }), expected, null)).toBe('release');
    expect(judgeHeldNextPlan(held({ segment_id: 230, status: 'Invalid' }), expected, null)).toBe('release');
    expect(judgeHeldNextPlan(held({ segment_id: 230, status: 'active' }), expected, 0)).toBe('keep');
  });
});
