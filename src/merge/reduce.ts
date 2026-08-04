/**
 * Two reductions that happen before anything is summed.
 *
 * reducePack turns '2 x 400 g tins' into 800 g so it can be added to a loose
 * 400 g. preferMass swaps a cup for the gram equivalent the recipe already
 * printed next to it — which is the only way to add '⅓ cup pepitas' to '50 g
 * pepitas' without guessing a density, something this app never does.
 */
import type {
  AltMeasure,
  ContainerUnit,
  MeasurementDialect,
  PackSize,
  Quantity,
  UnitCode,
  UnitKind,
} from '@/domain/types';
import { MASS_UNITS, SPOON_UNITS, VOLUME_UNITS } from '@/parser/units';

export interface Measured {
  quantity: Quantity;
  unit: UnitCode;
  unitKind: UnitKind;
  /** Set when the number came from an assumed pack size or a conversion. */
  assumed: boolean;
}

export interface PackLookup {
  (itemKey: string, container: ContainerUnit): { size: number; unit: UnitCode; assumed: boolean } | null;
}

/**
 * count x packSize, expressed in the pack's own unit. Returns null when there
 * is no pack size to apply — the caller then keeps counting tins, which is
 * the honest answer.
 */
export function reducePack(
  quantity: Quantity | null,
  unit: UnitCode | null,
  packSize: PackSize | null,
  itemKey: string,
  lookup?: PackLookup,
): Measured | null {
  if (!quantity || !unit) return null;
  let pack: { size: number; unit: UnitCode; assumed: boolean } | null = packSize
    ? { size: packSize.size, unit: packSize.unit, assumed: packSize.assumed }
    : null;
  if (!pack && lookup) {
    const container = unit as ContainerUnit;
    pack = lookup(itemKey, container);
  }
  if (!pack) return null;
  const kind: UnitKind = MASS_UNITS.has(pack.unit) ? 'mass' : 'volume';
  return {
    quantity: {
      low: quantity.low * pack.size,
      high: quantity.high * pack.size,
      isRange: quantity.isRange,
      approx: quantity.approx || pack.assumed,
      raw: quantity.raw,
    },
    unit: pack.unit,
    unitKind: kind,
    assumed: pack.assumed,
  };
}

/**
 * Prefers a mass equivalent the recipe supplied over a volume unit. Only ever
 * uses a number the text actually contained — never a density table.
 */
export function preferMass(
  quantity: Quantity | null,
  unit: UnitCode | null,
  unitKind: UnitKind,
  alternates: AltMeasure[],
): Measured | null {
  if (!quantity || !unit) return null;
  // Counts stay counts: you buy avocados by the number, and '(500g)' beside
  // them is a nutrition note, not a shopping instruction.
  if (unitKind !== 'volume' && unitKind !== 'imprecise') return null;
  if (unitKind === 'volume' && !SPOON_UNITS.has(unit)) return null;
  const mass = alternates.find((a) => a.unitKind === 'mass' && MASS_UNITS.has(a.unit));
  const volume = alternates.find((a) => a.unitKind === 'volume' && VOLUME_UNITS.has(a.unit));
  const alt = mass ?? (unitKind === 'imprecise' ? volume : undefined);
  if (!alt) return null;
  // The parenthetical is an equivalent for the whole line, not a per-unit rate.
  return {
    quantity: {
      low: alt.quantity,
      high: alt.quantity,
      isRange: false,
      approx: quantity.approx,
      raw: quantity.raw,
    },
    unit: alt.unit,
    unitKind: alt.unitKind,
    assumed: false,
  };
}

/** True when a unit only exists in US recipes and must be converted for a UK list. */
export function isImperial(unit: UnitCode | null): boolean {
  return unit === 'oz' || unit === 'lb' || unit === 'floz' || unit === 'pint' ||
    unit === 'quart' || unit === 'gallon';
}

/** True when a conversion between dialects would change the number. */
export function needsDialectConversion(
  unit: UnitCode | null,
  from: MeasurementDialect,
  to: MeasurementDialect,
): boolean {
  if (!unit || from === to) return false;
  if (isImperial(unit)) return true;
  return unit === 'cup' || unit === 'tbsp';
}
