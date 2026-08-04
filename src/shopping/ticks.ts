/**
 * Ticks are user intent about a physical act — "this is in the trolley" — so
 * they are stored apart from the derived list and keyed on itemKey alone.
 *
 * The rules that protect a half-finished shop:
 *  - changing the plan mid-shop never unticks anything,
 *  - a parse fix migrates the tick to the new key rather than dropping it,
 *  - a quantity that GREW re-opens the row rather than silently changing it,
 *  - a quantity that SHRANK says nothing, because you already have enough.
 */
import type { ClientId, HLC, Id, ISODateTime } from '@/domain/primitives';
import { stamp, tickId } from '@/domain/sync';
import {
  SCHEMA_VERSION,
  type MeasurementDialect,
  type MergedQuantity,
  type ShoppingLine,
  type ShoppingTick,
  type UnitCode,
} from '@/domain/types';
import { SPOON_UNITS, toBase } from '@/parser/units';

export interface TickContext {
  spaceId: Id;
  clientId: ClientId;
  now(): HLC;
  nowISO(): ISODateTime;
}

/** Absolute tolerances below which a change is not worth re-opening a row for. */
export const EPSILON = {
  mass: 20, // g
  volume: 20, // ml
  spoonMl: 5, // one teaspoon
  count: 1,
} as const;

function primary(line: ShoppingLine): MergedQuantity | null {
  return line.totals[0] ?? null;
}

export function toggleTick(
  existing: ShoppingTick | undefined,
  line: ShoppingLine,
  sessionId: Id,
  ctx: TickContext,
): ShoppingTick {
  const ticked = !(existing?.ticked ?? false);
  const total = primary(line);
  const base: ShoppingTick = {
    id: tickId(sessionId, line.lineKey),
    kind: 'shoppingTick',
    spaceId: ctx.spaceId,
    createdAt: existing?.createdAt ?? ctx.nowISO(),
    updatedAt: existing?.updatedAt ?? ctx.now(),
    lastWriterClientId: ctx.clientId,
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    lineKey: line.lineKey,
    ticked,
    tickedAt: ticked ? ctx.nowISO() : null,
    quantityAtTick: ticked ? (total?.value ?? null) : (existing?.quantityAtTick ?? null),
    unitAtTick: ticked ? (total?.unit ?? null) : (existing?.unitAtTick ?? null),
    displayNameAtTick: ticked ? line.displayName : (existing?.displayNameAtTick ?? line.displayName),
    displayQuantityAtTick: ticked
      ? line.displayQuantity
      : (existing?.displayQuantityAtTick ?? line.displayQuantity),
  };
  return stamp(base, ctx);
}

/**
 * Moves ticks from an old itemKey to a new one. Called when a parse fix or an
 * accepted merge suggestion changes a row's identity: fixing a typo must never
 * untick your trolley.
 */
export function migrateTicks(
  ticks: ShoppingTick[],
  sessionId: Id,
  oldKey: string,
  newKey: string,
  ctx: TickContext,
): ShoppingTick[] {
  if (oldKey === newKey) return ticks;
  const out: ShoppingTick[] = [];
  const targetId = tickId(sessionId, newKey);
  const existingTarget = ticks.find((t) => t.id === targetId && t.sessionId === sessionId);

  for (const t of ticks) {
    if (t.sessionId !== sessionId || t.lineKey !== oldKey) {
      out.push(t);
      continue;
    }
    // Tombstone the old row and write the new one, so both devices converge.
    out.push(stamp({ ...t, deletedAt: ctx.now() }, ctx));
    const merged: ShoppingTick = {
      ...t,
      id: targetId,
      lineKey: newKey,
      deletedAt: null,
      ticked: t.ticked || (existingTarget?.ticked ?? false),
    };
    out.push(stamp(merged, ctx));
  }
  if (existingTarget) {
    // The replacement above supersedes it; drop the stale copy.
    return out.filter((t) => t !== existingTarget);
  }
  return out;
}

/** The epsilon expressed in whatever unit the row is currently displayed in. */
function epsilonFor(
  unit: UnitCode | null,
  unitKind: MergedQuantity['unitKind'],
  dialect: MeasurementDialect,
): number {
  if (unitKind === 'mass') return unit === 'kg' ? EPSILON.mass / 1000 : EPSILON.mass;
  if (unitKind === 'volume') {
    if (unit && SPOON_UNITS.has(unit)) return EPSILON.spoonMl / toBase(1, unit, dialect);
    return unit === 'l' ? EPSILON.volume / 1000 : EPSILON.volume;
  }
  return EPSILON.count;
}

/**
 * True when the row's total has grown enough since it was ticked that the user
 * needs to go back for more. A decrease is deliberately silent.
 */
export function materiallyIncreased(
  tick: ShoppingTick,
  line: ShoppingLine,
  dialect: MeasurementDialect = 'metric-uk',
): boolean {
  if (!tick.ticked) return false;
  const total = primary(line);
  if (total === null) return false;
  if (tick.quantityAtTick === null) return false;
  // A change of unit family is not comparable; treat it as needing another look.
  if (tick.unitAtTick !== null && tick.unitAtTick !== total.unit) return true;
  const before = tick.quantityAtTick;
  const after = total.value;
  if (after <= before) return false;
  const eps = epsilonFor(total.unit, total.unitKind, dialect);
  const threshold = Math.max(before * 0.1, eps);
  return after - before > threshold;
}
