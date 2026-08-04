/**
 * Container and pack-size parsing.
 *
 * The rule that does the work: after a leading integer, if the next token is a
 * size AND a container noun follows within two tokens (allowing 'x'), the size
 * is a PackSize and the leading integer is a COUNT of packs — not a quantity in
 * that unit. '2 450g can chickpeas' is two tins, not 450 grams.
 */
import type {
  ContainerUnit,
  MassUnit,
  MeasurementDialect,
  PackSize,
  Quantity,
  VolumeUnit,
} from '@/domain/types';
import unitsJson from './lexicon/units.json';
import packsJson from './lexicon/packs.json';
import { parseQuantityPrefix } from './numbers';
import { normaliseKey, tokenizeWithGroups } from './tokenize';
import { lookupUnit, MASS_UNITS, VOLUME_UNITS } from './units';

/** alias -> canonical container code. */
export const CONTAINER_TABLE: Record<string, ContainerUnit> = (() => {
  const out: Record<string, ContainerUnit> = {};
  for (const [code, aliases] of Object.entries(unitsJson.containerAliases)) {
    for (const a of aliases as string[]) out[a] = code as ContainerUnit;
  }
  return out;
})();

export interface SeedPack {
  itemKey: string;
  container: ContainerUnit;
  size: number;
  unit: MassUnit | VolumeUnit;
  assumed: boolean;
}

/** ~65 UK supermarket defaults. All assumed, so the UI can offer a correction. */
export const SEED_PACK_SIZES: SeedPack[] = packsJson.seeds as SeedPack[];

const seedIndex = new Map<string, SeedPack>();
for (const s of SEED_PACK_SIZES) {
  const k = `${s.itemKey}|${s.container}`;
  if (!seedIndex.has(k)) seedIndex.set(k, s);
}

export function lookupSeedPack(itemKey: string, container: ContainerUnit): SeedPack | null {
  return seedIndex.get(`${itemKey}|${container}`) ?? null;
}

export function lookupContainer(token: string): ContainerUnit | null {
  const key = normaliseKey(token).replace(/[.,;:]+$/, '');
  return CONTAINER_TABLE[key] ?? null;
}

interface SizeLit {
  size: number;
  unit: MassUnit | VolumeUnit;
  /** True when the source was a range or an 'approx' marker. */
  approx: boolean;
}

const SIZE_RE = /^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*-?\s*([A-Za-z.]+)$/;

/** '450g', '15.5 oz', '15-ounce', '14-16 ounce' => a size literal. */
function readSize(token: string): SizeLit | null {
  const t = token.trim().replace(/[,;]+$/, '');
  const m = SIZE_RE.exec(t);
  if (!m) return null;
  const def = lookupUnit(m[3]!);
  if (!def) return null;
  if (!MASS_UNITS.has(def.code) && !VOLUME_UNITS.has(def.code)) return null;
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? lo : Number(m[2]);
  return {
    size: (lo + hi) / 2,
    unit: def.code as MassUnit | VolumeUnit,
    approx: lo !== hi,
  };
}

/** Reads a size that may be split over two tokens: '15.5' 'oz'. */
function readSizePair(a: string | undefined, b: string | undefined): SizeLit | null {
  if (a === undefined) return null;
  const one = readSize(a);
  if (one) return one;
  if (b === undefined) return null;
  return readSize(`${a}${b}`);
}

/** Strips the outer parentheses of a group token, or returns null. */
function unwrap(token: string | undefined): string | null {
  if (token === undefined) return null;
  const m = /^\((.*)\)$/s.exec(token.trim());
  return m ? m[1]!.trim() : null;
}

const APPROX_WORDS = /^(about|approx\.?|approximately|around|roughly|circa|~)\s*/i;

function readSizeGroup(token: string | undefined): SizeLit | null {
  const inner = unwrap(token);
  if (inner === null) return null;
  const cleaned = inner.replace(APPROX_WORDS, '');
  const approxMarked = cleaned !== inner;
  const parts = tokenizeWithGroups(cleaned);
  const lit = readSizePair(parts[0], parts[1]);
  if (!lit) return null;
  // Only accept when the parenthetical is essentially just the measure.
  const consumed = readSize(parts[0]!) ? 1 : 2;
  const tail = parts.slice(consumed).join(' ').toLowerCase();
  if (tail && !/^(total|each|drained|drained weight|net|tin|can|jar|pack|packet)$/.test(tail)) {
    return null;
  }
  return { ...lit, approx: lit.approx || approxMarked };
}

export interface ParsedPack {
  /** Number of packs. Null when no count could be read (caller implies 1). */
  count: Quantity | null;
  packSize: PackSize | null;
  container: ContainerUnit | null;
  /** Everything after the pack expression — the item text. */
  rest: string;
  /** True when a pack expression was actually recognised. */
  matched: boolean;
  /** The size came from a range or an 'approx' marker. */
  sizeApprox: boolean;
}

const NO_PACK = (s: string): ParsedPack => ({
  count: null,
  packSize: null,
  container: null,
  rest: s,
  matched: false,
  sizeApprox: false,
});

function qtyOf(n: number, raw: string): Quantity {
  return { low: n, high: n, isRange: false, approx: false, raw };
}

/**
 * Handles, in one pass:
 *   '2 450g can X'        count 2, pack 450 g / can
 *   '1 x 400ml can X'     count 1, pack 400 ml / can
 *   '1 (15.5 oz) can X'   count 1, pack 15.5 oz / can
 *   '1 jar (570g) X'      count 1, pack 570 g / jar
 *   '570g can X'          count 1 implied, pack 570 g / can
 *   '2 x 250g (8oz) packets X'
 */
export function parsePack(s: string, _dialect: MeasurementDialect = 'metric-uk'): ParsedPack {
  const text = s.trim();
  if (!text) return NO_PACK(s);
  const tokens = tokenizeWithGroups(text);
  if (tokens.length < 2) return NO_PACK(s);

  const joinFrom = (i: number): string => tokens.slice(i).join(' ');

  // --- leading count -------------------------------------------------------
  let cursor = 0;
  let count: Quantity | null = null;
  const lead = parseQuantityPrefix(tokens[0]!, { allowWordNumbers: false });
  if (lead && lead.rest.trim() === '') {
    count = lead.qty;
    cursor = 1;
  }

  // optional multiplication sign
  if (tokens[cursor] !== undefined && /^x$/i.test(tokens[cursor]!)) cursor++;

  // --- 'jar (570g)' : container first, size in a parenthetical -------------
  const asContainer = tokens[cursor] === undefined ? null : lookupContainer(tokens[cursor]!);
  if (asContainer) {
    const sized = readSizeGroup(tokens[cursor + 1]);
    if (sized) {
      return {
        count: count ?? qtyOf(1, '1'),
        packSize: {
          size: sized.size,
          unit: sized.unit,
          container: asContainer,
          assumed: false,
          drainedSize: null,
        },
        container: asContainer,
        rest: joinFrom(cursor + 2),
        matched: true,
        sizeApprox: sized.approx,
      };
    }
  }

  // --- size then container within two tokens -------------------------------
  const direct = tokens[cursor] === undefined ? null : readSize(tokens[cursor]!);
  const pair = direct ? null : readSizePair(tokens[cursor], tokens[cursor + 1]);
  const group = direct || pair ? null : readSizeGroup(tokens[cursor]);
  const size = direct ?? pair ?? group;
  if (!size) return NO_PACK(s);
  const afterSize = cursor + (direct || group ? 1 : 2);

  for (let look = afterSize; look < Math.min(afterSize + 3, tokens.length); look++) {
    const tok = tokens[look]!;
    if (/^x$/i.test(tok)) continue;
    if (unwrap(tok) !== null) continue; // '(8oz)' between size and container
    const container = lookupContainer(tok);
    if (!container) break;
    return {
      count: count ?? qtyOf(1, '1'),
      packSize: {
        size: size.size,
        unit: size.unit,
        container,
        assumed: false,
        drainedSize: null,
      },
      container,
      rest: joinFrom(look + 1),
      matched: true,
      sizeApprox: size.approx,
    };
  }

  return NO_PACK(s);
}

/** count x packSize expressed in the pack's own unit. */
export function packTotal(count: Quantity, pack: PackSize): { low: number; high: number } {
  return { low: count.low * pack.size, high: count.high * pack.size };
}
