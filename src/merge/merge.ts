/**
 * Collation: many recipe lines, one shopping row.
 *
 * The design commitments here are what make the number on the row trustworthy:
 *
 *  - Rows are grouped by EXACT itemKey equality. Fuzzy matching only ever
 *    produces a suggestion the user can accept; it never merges by itself.
 *  - Volume is never converted to mass by guessing a density. If a recipe gave
 *    us an equivalent we use it; otherwise the two stay apart.
 *  - When units genuinely cannot be combined the row shows BOTH ('2 tins +
 *    400 g') and asks for review. It never silently sums them, and it never
 *    drops one of them — a dropped component is food you get home without.
 *  - Every input component is retained on the row, including the zero-scale
 *    ones from leftovers, so the provenance panel can always explain the total.
 */
import type {
  ContainerUnit,
  ItemMeta,
  MergedQuantity,
  PackSizeMemory,
  Qualifier,
  ShoppingLine,
  SpaceSettings,
  UnitCode,
  UnitKind,
} from '@/domain/types';
import { differsByDistinguishingToken, similarity } from '@/parser/canonical';
import { SEED_PACK_SIZES } from '@/parser/containers';
import categoriesJson from '@/parser/lexicon/categories.json';
import { MASS_UNITS, SPOON_UNITS, toBase, unitLabel } from '@/parser/units';
import { categoriseItem } from './categorise';
import type { ResolvedComponent } from './collect';
import { formatCompound } from './format';
import { isImperial, preferMass } from './reduce';

const HALVABLE = new Set<string>(categoriesJson.halvable);

export interface MergeContext {
  settings: SpaceSettings;
  itemMeta?: Map<string, ItemMeta>;
  /** Keyed `${itemKey}|${container}`. Use seedPackMap() for the defaults. */
  packSizes?: Map<string, { size: number; unit: UnitCode; assumed: boolean }>;
}

/** The seeded UK pack sizes as a lookup, all flagged assumed. */
export function seedPackMap(): Map<string, { size: number; unit: UnitCode; assumed: boolean }> {
  const m = new Map<string, { size: number; unit: UnitCode; assumed: boolean }>();
  for (const s of SEED_PACK_SIZES) {
    m.set(`${s.itemKey}|${s.container}`, { size: s.size, unit: s.unit, assumed: true });
  }
  return m;
}

export function packMemoryMap(
  memories: PackSizeMemory[],
): Map<string, { size: number; unit: UnitCode; assumed: boolean }> {
  const m = seedPackMap();
  for (const p of memories) {
    if (p.deletedAt !== null) continue;
    m.set(`${p.itemKey}|${p.container}`, { size: p.size, unit: p.unit, assumed: p.assumed });
  }
  return m;
}

// ---------------------------------------------------------------------------

interface Bucket {
  key: string;
  unitKind: UnitKind;
  /** For mass/volume this is base units (g / ml); for counts it is the count. */
  low: number;
  high: number;
  isRange: boolean;
  approx: boolean;
  assumed: boolean;
  /** Every source unit seen, so display can stay in tsp when everything was tsp. */
  sourceUnits: Set<string>;
  /** Only set for count buckets. */
  container: ContainerUnit | null;
}

interface LooseContribution {
  label: string;
  qualifiers: Qualifier[];
}

const MEASURE_KINDS: UnitKind[] = ['mass', 'volume'];

function bucketKeyFor(unitKind: UnitKind, unit: UnitCode): string {
  if (unitKind === 'mass') return 'mass';
  if (unitKind === 'volume') return 'volume';
  return `count:${unit}`;
}

function newBucket(key: string, unitKind: UnitKind, container: ContainerUnit | null): Bucket {
  return {
    key,
    unitKind,
    low: 0,
    high: 0,
    isRange: false,
    approx: false,
    assumed: false,
    sourceUnits: new Set<string>(),
    container,
  };
}

/** Deterministic ordering, so a shuffled input produces an identical output. */
function componentOrder(a: ResolvedComponent, b: ResolvedComponent): number {
  return (
    a.date.localeCompare(b.date) ||
    a.mealType.localeCompare(b.mealType) ||
    a.placementId.localeCompare(b.placementId) ||
    a.lineKey.localeCompare(b.lineKey) ||
    a.rawText.localeCompare(b.rawText)
  );
}

export function mergeComponents(
  components: ResolvedComponent[],
  ctx: MergeContext,
): ShoppingLine[] {
  const groups = new Map<string, ResolvedComponent[]>();
  for (const c of components) {
    if (c.excluded) continue;
    if (!c.itemKey) continue;
    const arr = groups.get(c.itemKey);
    if (arr) arr.push(c);
    else groups.set(c.itemKey, [c]);
  }

  const keys = [...groups.keys()]
    // A group made only of leftovers needs nothing bought; its provenance still
    // rides along on any row the same item contributes to elsewhere.
    .filter((k) => groups.get(k)!.some((c) => c.scale !== 0))
    .sort();
  return keys.map((itemKey) => buildLine(itemKey, groups.get(itemKey)!.slice().sort(componentOrder), ctx));
}

function buildLine(
  itemKey: string,
  comps: ResolvedComponent[],
  ctx: MergeContext,
): ShoppingLine {
  const meta = ctx.itemMeta?.get(itemKey) ?? null;
  const packs = ctx.packSizes;
  const dialect = ctx.settings.dialect;

  const buckets = new Map<string, Bucket>();
  const loose: LooseContribution[] = [];
  let anyOptional = false;
  let allOptional = true;
  let toTaste = false;
  let pantryStaple = false;
  let manual = false;
  let minConfidence = 1;

  for (const c of comps) {
    const optional = c.qualifiers.includes('optional');
    if (optional) anyOptional = true;
    else allOptional = false;
    if (c.qualifiers.includes('to-taste')) toTaste = true;
    if (c.qualifiers.includes('pantry-staple')) pantryStaple = true;
    if (c.source === 'manual') manual = true;
    minConfidence = Math.min(minConfidence, c.confidence);

    if (c.scale === 0) continue; // leftover: provenance only

    const imprecise = c.unitKind === 'imprecise';
    const isToTasteLine = c.qualifiers.includes('to-taste');

    // A recipe-supplied equivalent lets us total spoons and handfuls honestly.
    const alt = preferMass(c.quantity, c.unit, c.unitKind, c.alternates);
    if (alt) {
      addToBucket(buckets, alt.unitKind, alt.unit, alt.quantity.low * c.scale, alt.quantity.high * c.scale, {
        approx: alt.quantity.approx || alt.assumed,
        assumed: alt.assumed,
        dialect: c.dialect,
      });
      continue;
    }

    if (!c.quantity || !c.unit || imprecise || isToTasteLine) {
      loose.push({
        label: c.unit && c.quantity ? `${c.quantity.low} ${unitLabel(c.unit, dialect, c.quantity.low !== 1)}` : '',
        qualifiers: c.qualifiers,
      });
      continue;
    }

    addToBucket(buckets, c.unitKind, c.unit, c.quantity.low * c.scale, c.quantity.high * c.scale, {
      approx: c.quantity.approx || isImperial(c.unit),
      assumed: false,
      dialect: c.dialect,
    });
    if (c.unitKind === 'count' && c.packSize) {
      const b = buckets.get(bucketKeyFor('count', c.unit))!;
      b.sourceUnits.add(`pack:${c.packSize.size}:${c.packSize.unit}`);
    }
  }

  // --- incompatible units --------------------------------------------------
  let hasAssumption = false;
  let needsReview = false;
  const countBuckets = [...buckets.values()].filter((b) => b.unitKind === 'count');
  const measureBuckets = [...buckets.values()].filter((b) => MEASURE_KINDS.includes(b.unitKind));

  if (countBuckets.length > 0 && measureBuckets.length > 0) {
    const reduced: { bucket: Bucket; into: Bucket }[] = [];
    let allReducible = true;
    for (const cb of countBuckets) {
      const pack = resolvePack(itemKey, cb, comps, packs);
      if (!pack) {
        allReducible = false;
        break;
      }
      const kind: UnitKind = MASS_UNITS.has(pack.unit) ? 'mass' : 'volume';
      const target = measureBuckets.find((m) => m.unitKind === kind);
      if (!target) {
        allReducible = false;
        break;
      }
      reduced.push({ bucket: cb, into: target });
    }
    if (allReducible) {
      for (const { bucket, into } of reduced) {
        const pack = resolvePack(itemKey, bucket, comps, packs)!;
        const factor = toBase(pack.size, pack.unit, dialect);
        into.low += bucket.low * factor;
        into.high += bucket.high * factor;
        into.isRange = into.isRange || bucket.isRange;
        into.approx = into.approx || bucket.approx || pack.assumed;
        if (pack.assumed) hasAssumption = true;
        buckets.delete(bucket.key);
      }
    } else {
      needsReview = true;
    }
  } else if (countBuckets.length > 1) {
    needsReview = true;
  }

  // --- totals --------------------------------------------------------------
  const totals: MergedQuantity[] = [...buckets.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((b) => toMergedQuantity(b, dialect));

  for (const b of buckets.values()) if (b.assumed) hasAssumption = true;

  // --- presentation --------------------------------------------------------
  const halvable = meta?.halvable ?? isHalvable(itemKey);
  const fmtCtx = { dialect, halvable };
  const displayName = meta?.displayName ?? pickDisplayName(comps, itemKey);

  let displayQuantity = totals.length ? formatCompound(totals, fmtCtx) : '';
  const looseSuffix = loose.length ? (toTaste ? 'to taste' : 'some') : '';
  if (!displayQuantity && looseSuffix) displayQuantity = looseSuffix;
  else if (displayQuantity && loose.length && toTaste) displayQuantity += ' + to taste';

  const numberless = totals.length === 0;
  const category =
    numberless && (pantryStaple || toTaste)
      ? 'staples'
      : categoriseItem(itemKey, meta);

  if (minConfidence < 0.55) needsReview = true;

  return {
    lineKey: itemKey,
    displayName,
    category,
    totals,
    displayQuantity,
    components: comps,
    confidence: minConfidence,
    needsReview,
    hasAssumption,
    isToTaste: toTaste || (numberless && loose.length > 0),
    isPantryStaple: pantryStaple,
    isOptional: comps.length > 0 && allOptional && anyOptional,
    manual,
    ticked: false,
    reopened: false,
    addedSinceStart: false,
  };
}

function addToBucket(
  buckets: Map<string, Bucket>,
  unitKind: UnitKind,
  unit: UnitCode,
  low: number,
  high: number,
  opts: { approx: boolean; assumed: boolean; dialect: MergeContext['settings']['dialect'] },
): void {
  const key = bucketKeyFor(unitKind, unit);
  let b = buckets.get(key);
  if (!b) {
    b = newBucket(key, unitKind, unitKind === 'count' ? (unit as ContainerUnit) : null);
    buckets.set(key, b);
  }
  const toBaseValue = (v: number): number =>
    unitKind === 'mass' || unitKind === 'volume' ? toBase(v, unit, opts.dialect) : v;
  b.low += toBaseValue(low);
  b.high += toBaseValue(high);
  if (low !== high) b.isRange = true;
  b.approx = b.approx || opts.approx;
  b.assumed = b.assumed || opts.assumed;
  b.sourceUnits.add(unit);
}

function resolvePack(
  itemKey: string,
  bucket: Bucket,
  comps: ResolvedComponent[],
  packs: MergeContext['packSizes'],
): { size: number; unit: UnitCode; assumed: boolean } | null {
  const container = bucket.container;
  if (!container) return null;
  // A pack size printed on the line beats anything remembered.
  const fromText = comps.find(
    (c) => c.packSize !== null && c.packSize.container === container && c.scale !== 0,
  );
  if (fromText?.packSize) {
    return {
      size: fromText.packSize.size,
      unit: fromText.packSize.unit,
      assumed: fromText.packSize.assumed,
    };
  }
  const hit = packs?.get(`${itemKey}|${container}`);
  return hit ?? null;
}

function toMergedQuantity(b: Bucket, dialect: MergeContext['settings']['dialect']): MergedQuantity {
  if (b.unitKind === 'count') {
    return {
      unitKind: 'count',
      unit: (b.container ?? 'each') as UnitCode,
      value: b.high,
      isRange: b.isRange,
      rangeLow: b.low,
      approx: b.approx,
    };
  }
  // Everything came from one spoon-sized unit: keep it, because '3 1/3 tsp' is
  // far more use in a kitchen than '16.7 ml'.
  const units = [...b.sourceUnits].sort();
  const single = units.length === 1 ? units[0]! : null;
  if (single && SPOON_UNITS.has(single)) {
    const per = toBase(1, single as UnitCode, dialect);
    return {
      unitKind: b.unitKind,
      unit: single as UnitCode,
      value: b.high / per,
      isRange: b.isRange,
      rangeLow: b.low / per,
      approx: b.approx,
    };
  }
  const base: UnitCode = b.unitKind === 'mass' ? 'g' : 'ml';
  return {
    unitKind: b.unitKind,
    unit: base,
    value: b.high,
    isRange: b.isRange,
    rangeLow: b.low,
    approx: b.approx,
  };
}

function pickDisplayName(comps: ResolvedComponent[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const c of comps) {
    if (!c.item) continue;
    counts.set(c.item, (counts.get(c.item) ?? 0) + 1);
  }
  if (counts.size === 0) return fallback;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}

function isHalvable(itemKey: string): boolean {
  if (HALVABLE.has(itemKey)) return true;
  const head = itemKey.split(' ').pop();
  return head !== undefined && HALVABLE.has(head);
}

// ---------------------------------------------------------------------------
// Suggestions — never applied automatically
// ---------------------------------------------------------------------------

export interface MergeSuggestion {
  a: string;
  b: string;
  score: number;
}

/**
 * Proposes rows the user might want to combine. Blocked whenever the two keys
 * differ by a distinguishing token, so 'cherry tomato' is never offered against
 * 'tomato' however similar the strings look.
 */
export function suggestMerges(lines: ShoppingLine[], threshold = 0.82): MergeSuggestion[] {
  const out: MergeSuggestion[] = [];
  const keys = lines.map((l) => l.lineKey).sort();
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i]!;
      const b = keys[j]!;
      if (differsByDistinguishingToken(a, b)) continue;
      const score = similarity(a, b);
      if (score >= threshold) out.push({ a, b, score });
    }
  }
  return out.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}
