/**
 * Unit vocabulary and conversion. Base units are grams and millilitres; every
 * arithmetic in the app happens in base units and only formatQuantity converts
 * back for display.
 */
import type {
  ContainerUnit,
  MassUnit,
  MeasurementDialect,
  UnitCode,
  UnitKind,
  VolumeUnit,
} from '@/domain/types';
import unitsJson from './lexicon/units.json';
import { normaliseKey } from './tokenize';

export interface UnitDef {
  code: UnitCode;
  kind: UnitKind;
}

/** alias -> unit. Keyed by every spelling the user might type. */
export const UNIT_TABLE: Record<string, UnitDef> = unitsJson.aliases as Record<string, UnitDef>;

export const CONTAINER_CODES = new Set<string>(Object.keys(unitsJson.containerAliases));

const MASS_BASE = unitsJson.base.mass as Record<string, number>;
const VOLUME_BASE = unitsJson.base.volume as Record<string, number>;
const DIALECT_OVERRIDES = unitsJson.dialectOverrides as Record<string, Record<string, number>>;

/**
 * 'T' is a tablespoon and 't' is a teaspoon — the only place in the parser
 * where case is load-bearing, so it is checked before the lowercase table.
 */
const CASE_SENSITIVE: Record<string, UnitDef> = {
  T: { code: 'tbsp', kind: 'volume' },
  t: { code: 'tsp', kind: 'volume' },
};

export function lookupUnit(token: string): UnitDef | null {
  const trimmed = token.trim().replace(/[,;:]+$/, '');
  if (!trimmed) return null;
  const exact = CASE_SENSITIVE[trimmed];
  if (exact) return exact;
  const key = normaliseKey(trimmed);
  const hit = UNIT_TABLE[key];
  if (hit) return hit;
  // trailing full stop: 'tbsp.' is in the table but 'grams.' is not
  const noDot = key.replace(/\.+$/, '');
  return UNIT_TABLE[noDot] ?? null;
}

export function unitFamily(u: UnitCode): UnitKind {
  if (u in MASS_BASE) return 'mass';
  if (u in VOLUME_BASE) return 'volume';
  const def = UNIT_TABLE[u];
  return def ? def.kind : 'none';
}

export function isContainer(u: UnitCode | null): u is ContainerUnit {
  return u !== null && CONTAINER_CODES.has(u);
}

function volumeFactor(u: string, dialect: MeasurementDialect): number {
  const override = DIALECT_OVERRIDES[dialect]?.[u];
  if (override !== undefined) return override;
  return VOLUME_BASE[u] ?? 1;
}

/** Converts to grams (mass) or millilitres (volume). Other kinds pass through. */
export function toBase(v: number, u: UnitCode, dialect: MeasurementDialect): number {
  if (u in MASS_BASE) return v * MASS_BASE[u]!;
  if (u in VOLUME_BASE) return v * volumeFactor(u, dialect);
  return v;
}

export interface FromBase {
  value: number;
  unit: UnitCode;
}

const MASS_LADDER: MassUnit[] = ['g', 'kg'];
const VOLUME_LADDER: VolumeUnit[] = ['ml', 'l'];

/**
 * Picks the largest ladder unit whose value is still >= 1, so 400 g stays grams
 * and 1200 g becomes 1.2 kg.
 */
export function fromBase(v: number, kind: UnitKind, dialect: MeasurementDialect): FromBase {
  const ladder = kind === 'mass' ? MASS_LADDER : kind === 'volume' ? VOLUME_LADDER : null;
  if (!ladder) return { value: v, unit: 'each' };
  let best: FromBase = { value: v, unit: ladder[0]! };
  for (const u of ladder) {
    const converted = v / (kind === 'mass' ? MASS_BASE[u]! : volumeFactor(u, dialect));
    if (converted >= 1) best = { value: converted, unit: u };
  }
  return best;
}

/** Converts between two units of the same family. */
export function convert(
  v: number,
  from: UnitCode,
  to: UnitCode,
  dialect: MeasurementDialect,
): number | null {
  const kf = unitFamily(from);
  const kt = unitFamily(to);
  if (kf !== kt || (kf !== 'mass' && kf !== 'volume')) return null;
  const base = toBase(v, from, dialect);
  const perTo = toBase(1, to, dialect);
  if (!perTo) return null;
  return base / perTo;
}

const US_MARKERS =
  /(\b\d+\s*(oz|ounces?|lbs?|pounds?)\b)|(\bfl\.?\s*oz\b)|(\bfluid ounces?\b)|(\bsticks? of butter\b)|(°\s?F\b)|(\b\d+\s*°F\b)|(\b\d+(\.\d+)?\s*cups?\b)|(\bcups? of\b)/i;
const METRIC_MARKERS = /(\b\d+(\.\d+)?\s*(g|gr|gram(me)?s?|kg|kilo(gram(me)?)?s?|ml|mls|millilitres?|l|litres?)\b)|(°\s?C\b)/i;

/**
 * Sniffs a recipe's dialect. Returns null when the evidence is mixed or
 * absent — the caller then falls back to the space setting rather than
 * guessing, because guessing wrong is a 33% error on every spoon.
 */
export function detectDialect(text: string): MeasurementDialect | null {
  const s = normaliseKey(text);
  const us = US_MARKERS.test(s);
  const metric = METRIC_MARKERS.test(s);
  if (us && metric) return null;
  if (us) return 'us';
  if (metric) return 'metric-uk';
  return null;
}

/**
 * Display label. The UnitCode enum uses 'can', but a British or Australian
 * shopper reads 'tin'.
 */
export function unitLabel(u: UnitCode, dialect: MeasurementDialect, plural = false): string {
  const uk = dialect === 'metric-uk' || dialect === 'metric-au';
  let base: string = u;
  if (u === 'can') base = uk ? 'tin' : 'can';
  if (u === 'floz') base = 'fl oz';
  if (u === 'each') return '';
  if (!plural) return base;
  if (u in MASS_BASE || u in VOLUME_BASE) return base; // '400 g', never '400 gs'
  if (base.endsWith('h') || base.endsWith('s') || base.endsWith('x')) return `${base}es`;
  return `${base}s`;
}

export const MASS_UNITS = new Set<string>(Object.keys(MASS_BASE));
export const VOLUME_UNITS = new Set<string>(Object.keys(VOLUME_BASE));
/** Spoons and cups are approximate by nature and get fraction display. */
export const SPOON_UNITS = new Set<string>(['tsp', 'tbsp', 'cup', 'floz']);
