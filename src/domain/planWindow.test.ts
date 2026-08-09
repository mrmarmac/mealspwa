import { describe, expect, it } from 'vitest';
import { clampWeekStart, coversRange, planWeekBounds, retentionCutoff } from './planWindow';

// Monday 2026-08-03 is a week start for weekStartsOn=1.
const MONDAY = '2026-08-03';

describe('planWeekBounds', () => {
  it('is 2 weeks either side of the current week (Monday-anchored)', () => {
    const { min, max } = planWeekBounds(MONDAY, 1);
    expect(min).toBe('2026-07-20'); // 2 weeks before
    expect(max).toBe('2026-08-17'); // 2 weeks after
  });

  it('anchors on the week start for a mid-week date', () => {
    const { min, max } = planWeekBounds('2026-08-06', 1); // Thursday
    expect(min).toBe('2026-07-20');
    expect(max).toBe('2026-08-17');
  });

  it('honours a Sunday-anchored week', () => {
    const { min, max } = planWeekBounds('2026-08-06', 0); // week start Sun 2026-08-02
    expect(min).toBe('2026-07-19');
    expect(max).toBe('2026-08-16');
  });
});

describe('clampWeekStart', () => {
  it('passes an in-range week-start through unchanged', () => {
    expect(clampWeekStart(MONDAY, MONDAY, 1)).toBe(MONDAY);
    expect(clampWeekStart('2026-07-27', MONDAY, 1)).toBe('2026-07-27');
  });

  it('clamps below the minimum', () => {
    expect(clampWeekStart('2026-01-01', MONDAY, 1)).toBe('2026-07-20');
  });

  it('clamps above the maximum', () => {
    expect(clampWeekStart('2027-01-01', MONDAY, 1)).toBe('2026-08-17');
  });
});

describe('retentionCutoff', () => {
  it('equals the window minimum', () => {
    expect(retentionCutoff(MONDAY, 1)).toBe(planWeekBounds(MONDAY, 1).min);
  });
});

describe('coversRange', () => {
  const SUNDAY = '2026-08-09';
  const open = { fromDate: MONDAY, toDate: SUNDAY };

  it('matches the exact window the list was built from', () => {
    expect(coversRange(open, MONDAY, SUNDAY)).toBe(true);
  });

  it('rejects a different week', () => {
    expect(coversRange(open, '2026-08-10', '2026-08-16')).toBe(false);
  });

  it('rejects the same start with a different length', () => {
    // A fortnight view starts on the same Monday but is not the same list.
    expect(coversRange(open, MONDAY, '2026-08-16')).toBe(false);
  });

  it('treats no open list as no match', () => {
    // Guards the clear-week path: with no list there is nothing to clear.
    expect(coversRange(null, MONDAY, SUNDAY)).toBe(false);
  });
});
