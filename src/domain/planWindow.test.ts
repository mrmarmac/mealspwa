import { describe, expect, it } from 'vitest';
import { clampWeekStart, planWeekBounds, retentionCutoff } from './planWindow';

// Monday 2026-08-03 is a week start for weekStartsOn=1.
const MONDAY = '2026-08-03';

describe('planWeekBounds', () => {
  it('is 4 weeks either side of the current week (Monday-anchored)', () => {
    const { min, max } = planWeekBounds(MONDAY, 1);
    expect(min).toBe('2026-07-06'); // 4 weeks before
    expect(max).toBe('2026-08-31'); // 4 weeks after
  });

  it('anchors on the week start for a mid-week date', () => {
    const { min, max } = planWeekBounds('2026-08-06', 1); // Thursday
    expect(min).toBe('2026-07-06');
    expect(max).toBe('2026-08-31');
  });

  it('honours a Sunday-anchored week', () => {
    const { min, max } = planWeekBounds('2026-08-06', 0); // week start Sun 2026-08-02
    expect(min).toBe('2026-07-05');
    expect(max).toBe('2026-08-30');
  });
});

describe('clampWeekStart', () => {
  it('passes an in-range week-start through unchanged', () => {
    expect(clampWeekStart(MONDAY, MONDAY, 1)).toBe(MONDAY);
    expect(clampWeekStart('2026-07-13', MONDAY, 1)).toBe('2026-07-13');
  });

  it('clamps below the minimum', () => {
    expect(clampWeekStart('2026-01-01', MONDAY, 1)).toBe('2026-07-06');
  });

  it('clamps above the maximum', () => {
    expect(clampWeekStart('2027-01-01', MONDAY, 1)).toBe('2026-08-31');
  });
});

describe('retentionCutoff', () => {
  it('equals the window minimum', () => {
    expect(retentionCutoff(MONDAY, 1)).toBe(planWeekBounds(MONDAY, 1).min);
  });
});
