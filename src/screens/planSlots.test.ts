import { describe, expect, it } from 'vitest';
import { isEligibleLeftoverSlot } from './planSlots';

const source = { date: '2026-08-05', mealType: 'dinner' as const };

describe('isEligibleLeftoverSlot', () => {
  it('rejects days before the source day', () => {
    expect(isEligibleLeftoverSlot(source, '2026-08-04', 'dinner')).toBe(false);
    expect(isEligibleLeftoverSlot(source, '2026-08-04', 'lunch')).toBe(false);
  });

  it('rejects the source slot itself', () => {
    expect(isEligibleLeftoverSlot(source, '2026-08-05', 'dinner')).toBe(false);
  });

  it('allows another meal on the source day', () => {
    expect(isEligibleLeftoverSlot(source, '2026-08-05', 'lunch')).toBe(true);
  });

  it('allows future days in any meal, up to two days ahead', () => {
    expect(isEligibleLeftoverSlot(source, '2026-08-06', 'lunch')).toBe(true);
    expect(isEligibleLeftoverSlot(source, '2026-08-07', 'lunch')).toBe(true);
    expect(isEligibleLeftoverSlot(source, '2026-08-07', 'dinner')).toBe(true);
  });

  it('rejects days more than two days after the source day', () => {
    expect(isEligibleLeftoverSlot(source, '2026-08-08', 'lunch')).toBe(false);
    expect(isEligibleLeftoverSlot(source, '2026-08-08', 'dinner')).toBe(false);
    expect(isEligibleLeftoverSlot(source, '2026-08-12', 'dinner')).toBe(false);
  });

  it('applies the two-day bound across a month boundary', () => {
    const endOfMonth = { date: '2026-08-30', mealType: 'dinner' as const };
    expect(isEligibleLeftoverSlot(endOfMonth, '2026-09-01', 'dinner')).toBe(true);
    expect(isEligibleLeftoverSlot(endOfMonth, '2026-09-02', 'dinner')).toBe(false);
  });
});
