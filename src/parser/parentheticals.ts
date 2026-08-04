/**
 * Parentheticals carry four different kinds of information and getting them
 * confused is expensive: '(65g)' is a merge-saving equivalent, '(400g drained
 * weight)' is a different number for the same tin, '(optional)' changes whether
 * you buy it at all, and '(pumpkin seed kernels)' is just help — and must be
 * kept OUT of the itemKey so it still merges with a bare 'pepitas'.
 */
import type { AltMeasure, Qualifier, UnitKind } from '@/domain/types';
import { normaliseKey, tokenizeWithGroups } from './tokenize';
import { lookupUnit, MASS_UNITS, VOLUME_UNITS } from './units';

export type ParentheticalKind =
  | 'alt-measure'
  | 'packSize'
  | 'drainedSize'
  | 'qualifier'
  | 'approx'
  | 'clarifier';

export interface Parenthetical {
  /** Inner text, without the brackets. */
  text: string;
  kind: ParentheticalKind;
  alt: AltMeasure | null;
  drainedSize: number | null;
  qualifier: Qualifier | null;
  approx: boolean;
  /** '(sliced)', '(finely diced)' — really a note, not a clarifier. */
  isPrep: boolean;
}

export interface ExtractedParentheticals {
  /** The line with every parenthetical removed and whitespace tidied. */
  text: string;
  parts: string[];
}

/** Pulls out every bracketed group, including nested ones, in order. */
export function extractParentheticals(s: string): ExtractedParentheticals {
  const parts: string[] = [];
  let out = '';
  let depth = 0;
  let buf = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') {
      if (depth === 0) buf = '';
      else buf += ch;
      depth++;
      continue;
    }
    if ((ch === ')' || ch === ']') && depth > 0) {
      depth--;
      if (depth === 0) {
        const t = buf.trim();
        if (t) parts.push(t);
        buf = '';
      } else {
        buf += ch;
      }
      continue;
    }
    if (depth > 0) buf += ch;
    else out += ch;
  }
  if (depth > 0 && buf.trim()) parts.push(buf.trim()); // unbalanced '(' at EOL
  return {
    text: out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').trim(),
    parts,
  };
}

const APPROX_LEAD = /^(about|approx\.?|approximately|around|roughly|circa|~|=|≈)\s*/i;
const OPTIONAL_RE = /\b(optional|if desired|if using|if you like|to taste|or to taste)\b/i;
const APPROX_RE = /\b(about|approx\.?|approximately|around|roughly|circa)\b/i;
const PREP_ONLY_RE =
  /^(finely |roughly |rough |thinly |coarsely |very )*(sliced|diced|chopped|minced|grated|crushed|drained|rinsed|peeled|halved|quartered|seeded|deveined|trimmed|toasted|torn|shredded|cooked|melted|softened|zested|juiced|cubed|julienned|smashed|stemmed)$/i;

/** A measure at the very start of the parenthetical, e.g. '65g', 'approx. 10g'. */
const MEASURE_RE =
  /^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*(g|gr|gram|grams|gramme|grammes|kg|kilo|kilos|kilogram|kilograms|ml|mls|millilitre|millilitres|milliliter|milliliters|l|litre|litres|liter|liters|oz|ounce|ounces|lb|lbs|pound|pounds|floz|fl\.?\s?oz)\b/i;

/** Text that may legitimately follow the measure and still leave it an equivalent. */
const MEASURE_TAIL_OK = /^(total|net|each|drained|drained weight|dry|cooked|approx\.?|roughly|or .*|\/.*)?$/i;

export interface ClassifyContext {
  /** True when the line already has a container noun — makes a size a packSize. */
  hasContainer: boolean;
}

export function classifyParenthetical(
  inner: string,
  ctx: ClassifyContext = { hasContainer: false },
): Parenthetical {
  const raw = inner.trim();
  const base: Parenthetical = {
    text: raw,
    kind: 'clarifier',
    alt: null,
    drainedSize: null,
    qualifier: null,
    approx: false,
    isPrep: false,
  };
  if (!raw) return base;

  const lower = normaliseKey(raw);
  const hasDrained = /\bdrained\b/.test(lower);
  const stripped = raw.replace(APPROX_LEAD, '');
  const approxMarked = stripped !== raw || APPROX_RE.test(lower);

  const m = MEASURE_RE.exec(stripped);
  const tail = m ? stripped.slice(m[0].length).trim().replace(/^[,;]\s*/, '') : '';

  // (b) drained weight wins over the plain-measure reading: it describes the
  //     same tin, not an equivalent for the whole line.
  if (m && hasDrained && /weight|drained/i.test(tail || lower)) {
    const kind = unitKindOf(m[3]!);
    if (kind === 'mass' || kind === 'volume') {
      return { ...base, kind: 'drainedSize', drainedSize: numberOf(m), approx: approxMarked };
    }
  }

  // (a) a bare equivalent measure
  if (m && MEASURE_TAIL_OK.test(tail)) {
    const def = lookupUnit(m[3]!);
    if (def && (MASS_UNITS.has(def.code) || VOLUME_UNITS.has(def.code))) {
      const isRange = m[2] !== undefined;
      return {
        ...base,
        kind: ctx.hasContainer ? 'packSize' : 'alt-measure',
        alt: {
          quantity: numberOf(m),
          unit: def.code,
          unitKind: def.kind,
        },
        approx: approxMarked || isRange,
      };
    }
  }

  // (c) optional / if desired / if using
  if (OPTIONAL_RE.test(lower)) {
    const q: Qualifier = /to taste/.test(lower) ? 'to-taste' : 'optional';
    return { ...base, kind: 'qualifier', qualifier: q };
  }

  // (d) about|approx|roughly + a number
  if (APPROX_RE.test(lower) && /\d/.test(lower)) {
    return { ...base, kind: 'approx', approx: true };
  }

  // (e) everything else is help for the cook, excluded from the itemKey
  return { ...base, kind: 'clarifier', isPrep: PREP_ONLY_RE.test(raw.trim()) };
}

function numberOf(m: RegExpExecArray): number {
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? lo : Number(m[2]);
  return (lo + hi) / 2;
}

function unitKindOf(token: string): UnitKind {
  const def = lookupUnit(token);
  return def ? def.kind : 'none';
}

/** Convenience: classify every extracted part of a line. */
export function classifyAll(parts: string[], ctx: ClassifyContext): Parenthetical[] {
  return parts.map((p) => classifyParenthetical(p, ctx));
}

/** True when a parenthetical is nothing but a measure, e.g. '(8oz)'. */
export function isBareMeasure(inner: string): boolean {
  const parts = tokenizeWithGroups(inner);
  if (parts.length > 2) return false;
  return MEASURE_RE.test(inner.trim());
}
