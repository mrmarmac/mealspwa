/**
 * How many times a recipe line's quantity should be counted.
 *
 * Two rules, both of which are wrong to inline at call sites:
 *   - a leftover placement contributes nothing (effectiveScale),
 *   - a 'per person' line is multiplied by the household.
 * And one rule about what the multiplier must NOT touch: cooking three times
 * the stew does not mean three pinches of salt, so imprecise units, to-taste
 * lines and pantry staples are never scaled.
 */
import { effectiveScale } from '@/domain/sync';
import type { ParsedIngredientLine, Placement, SpaceSettings } from '@/domain/types';

/** The subset of a parsed line that scaling depends on. */
export interface ScalableLine {
  qualifiers: ParsedIngredientLine['qualifiers'];
  unitKind: ParsedIngredientLine['unitKind'];
}

export function isUnscalable(line: ScalableLine): boolean {
  return (
    line.unitKind === 'imprecise' ||
    line.qualifiers.includes('to-taste') ||
    line.qualifiers.includes('pantry-staple')
  );
}

export function componentScale(
  placement: Placement,
  line: ScalableLine,
  settings: SpaceSettings,
): number {
  const base = effectiveScale(placement);
  if (base === 0) return 0;
  if (isUnscalable(line)) return 1;
  const perPerson = line.qualifiers.includes('per-person') ? Math.max(1, settings.householdSize) : 1;
  return base * perPerson;
}
