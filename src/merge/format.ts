/**
 * The ONLY float-to-screen path in the app.
 *
 * Every total is carried around unrounded so that arithmetic stays exact; this
 * file is where it becomes a number a human reads in a supermarket. Two rules
 * matter more than the rest: never show more precision than we actually have
 * (no '116.66666 g'), and never invent precision we do not have (1.29 tsp is
 * NOT '1 1/3 tsp' — showing a fraction there would be a lie).
 */
import type { MeasurementDialect, MergedQuantity, UnitCode } from '@/domain/types';
import { toFraction } from '@/parser/numbers';
import { fromBase, SPOON_UNITS, unitLabel } from '@/parser/units';

export interface FormatContext {
  dialect: MeasurementDialect;
  /** Lemons and onions can be bought by the half; tins cannot. */
  halvable?: boolean;
}

const EN_DASH = '–';

/** Caps at three significant figures and strips a trailing '.0'. */
export function toThreeSigFigs(v: number): string {
  if (!Number.isFinite(v)) return '0';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  const digits = Math.max(0, 3 - Math.ceil(Math.log10(abs)));
  const rounded = Number(v.toFixed(Math.min(digits, 20)));
  return String(rounded);
}

/**
 * Mass and volume ladder:
 *   < 100   nearest 5
 *   100-1000 nearest 10, unless the number is already a clean multiple of 5
 *   > 1000  kg / l at the nearest 0.05
 * The 'already clean' exception exists because rounding 115 g up to 120 g is
 * noise, not helpfulness — the number came from real quantities that added up.
 */
export function roundMeasure(value: number): number {
  const abs = Math.abs(value);
  if (abs < 100) return round(value, 5);
  if (abs <= 1000) return abs % 5 === 0 ? value : round(value, 10);
  return value;
}

function round(v: number, step: number): number {
  return Math.round(v / step) * step;
}

function formatMassVolume(value: number, unit: UnitCode, dialect: MeasurementDialect): string {
  const kind = unit === 'g' || unit === 'kg' || unit === 'mg' || unit === 'oz' || unit === 'lb'
    ? 'mass'
    : 'volume';
  if (SPOON_UNITS.has(unit)) return formatSpoon(value, unit, dialect);

  // Re-pick the ladder unit from the base value so 1200 g reads as 1.2 kg.
  const base = unit === 'kg' || unit === 'l' ? value * 1000 : value;
  const picked = fromBase(base, kind, dialect);
  if (picked.unit === 'kg' || picked.unit === 'l') {
    const v = round(picked.value, 0.05);
    return `${toThreeSigFigs(v)} ${unitLabel(picked.unit, dialect)}`;
  }
  const v = roundMeasure(picked.value);
  return `${toThreeSigFigs(v)} ${unitLabel(picked.unit, dialect)}`;
}

/**
 * Spoons and cups snap to a fraction when one is honest within 0.02, and fall
 * back to one decimal place when it is not.
 */
function formatSpoon(value: number, unit: UnitCode, dialect: MeasurementDialect): string {
  const frac = toFraction(value, [2, 3, 4, 8], 0.02);
  const label = unitLabel(unit, dialect, false);
  if (frac !== null) return `${frac} ${label}`;
  return `${toThreeSigFigs(Number(value.toFixed(1)))} ${label}`;
}

function formatCount(value: number, unit: UnitCode, ctx: FormatContext): string {
  const halvable = ctx.halvable === true;
  let v: number;
  if (halvable) {
    // Halves are real; anything finer is rounded up, because you cannot buy
    // 0.3 of a lemon.
    v = Math.ceil(value * 2) / 2;
  } else {
    v = Math.ceil(value - 1e-9);
  }
  if (v <= 0) v = halvable ? 0.5 : 1;
  const label = unitLabel(unit, ctx.dialect, v !== 1);
  const num = halvable ? (toFraction(v, [2], 0.001) ?? toThreeSigFigs(v)) : toThreeSigFigs(v);
  return label ? `${num} ${label}` : num;
}

/** The single entry point. Everything on screen goes through here. */
export function formatQuantity(m: MergedQuantity, ctx: FormatContext): string {
  const render = (v: number): string => {
    if (m.unitKind === 'count') return formatCount(v, m.unit, ctx);
    if (m.unitKind === 'mass' || m.unitKind === 'volume') {
      return formatMassVolume(v, m.unit, ctx.dialect);
    }
    const label = unitLabel(m.unit, ctx.dialect, v !== 1);
    const num = toThreeSigFigs(v);
    return label ? `${num} ${label}` : num;
  };

  let body: string;
  if (m.isRange && m.rangeLow !== m.value) {
    const lo = render(m.rangeLow);
    const hi = render(m.value);
    // '1-2 tsp', not '1 tsp-2 tsp'
    const loNum = lo.replace(/\s\S+$/, '');
    body = lo.endsWith(hi.replace(/^\S+\s/, '')) ? `${loNum}${EN_DASH}${hi}` : `${lo}${EN_DASH}${hi}`;
  } else {
    body = render(m.value);
  }
  return m.approx ? `≈ ${body}` : body;
}

/** 'A + B' for a line whose units could not honestly be combined. */
export function formatCompound(totals: MergedQuantity[], ctx: FormatContext): string {
  return totals.map((t) => formatQuantity(t, ctx)).join(' + ');
}
