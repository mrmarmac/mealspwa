/**
 * Pure eligibility rule for placing leftovers by tapping a slot on the board.
 * Extracted from PlanScreen so it can be unit-tested without rendering.
 */
import type { ISODate } from '@/domain/primitives';
import type { MealType, Placement } from '@/domain/types';

/**
 * Whether `date`/`mealType` is a valid target for leftovers from `source`.
 * A leftover cannot land before its source's day, nor in the source's own
 * slot. (Mirrors the previous list-based picker's filter exactly.)
 */
export function isEligibleLeftoverSlot(
  source: Pick<Placement, 'date' | 'mealType'>,
  date: ISODate,
  mealType: MealType,
): boolean {
  if (date < source.date) return false;
  if (date === source.date && mealType === source.mealType) return false;
  return true;
}
