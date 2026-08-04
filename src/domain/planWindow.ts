/**
 * The 2-week retention window. The plan only keeps (and only lets you navigate
 * to) the 2 weeks either side of the current week; anything older is pruned
 * from local storage (see `deletePlacementsBefore` in `db/repo`).
 *
 * All bounds are anchored on the START of the current week, so the window moves
 * in whole-week steps and lines up with the board's week navigation.
 */
import { addDays, startOfWeek, type ISODate } from './primitives';

export const PLAN_WEEKS_EACH_WAY = 2;

export interface PlanWeekBounds {
  /** Earliest week-start you may navigate to. */
  min: ISODate;
  /** Latest week-start you may navigate to. */
  max: ISODate;
}

export function planWeekBounds(today: ISODate, weekStartsOn: 0 | 1): PlanWeekBounds {
  const thisWeek = startOfWeek(today, weekStartsOn);
  return {
    min: addDays(thisWeek, -7 * PLAN_WEEKS_EACH_WAY),
    max: addDays(thisWeek, 7 * PLAN_WEEKS_EACH_WAY),
  };
}

/** Clamp a week-start into the allowed window. */
export function clampWeekStart(weekStart: ISODate, today: ISODate, weekStartsOn: 0 | 1): ISODate {
  const { min, max } = planWeekBounds(today, weekStartsOn);
  if (weekStart < min) return min;
  if (weekStart > max) return max;
  return weekStart;
}

/**
 * The cutoff before which plan data can be deleted: the start of the earliest
 * week still in the 2-week window. Anything dated strictly earlier is prunable.
 */
export function retentionCutoff(today: ISODate, weekStartsOn: 0 | 1): ISODate {
  return planWeekBounds(today, weekStartsOn).min;
}
