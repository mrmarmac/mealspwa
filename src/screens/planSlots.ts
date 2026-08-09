/**
 * Pure eligibility rule for placing leftovers by tapping a slot on the board.
 * Extracted from PlanScreen so it can be unit-tested without rendering.
 */
import { addDays, type ISODate } from '@/domain/primitives';
import type { MealType, Placement } from '@/domain/types';

/** Leftovers stay good for about two days, so the board only offers that far. */
const LEFTOVER_MAX_DAYS_AHEAD = 2;

/**
 * Whether `date`/`mealType` is a valid target for leftovers from `source`.
 * A leftover cannot land before its source's day, nor in the source's own
 * slot, nor more than `LEFTOVER_MAX_DAYS_AHEAD` days after its source's day —
 * past that, the food is no longer safe to eat.
 */
export function isEligibleLeftoverSlot(
  source: Pick<Placement, 'date' | 'mealType'>,
  date: ISODate,
  mealType: MealType,
): boolean {
  if (date < source.date) return false;
  if (date === source.date && mealType === source.mealType) return false;
  if (date > addDays(source.date, LEFTOVER_MAX_DAYS_AHEAD)) return false;
  return true;
}
