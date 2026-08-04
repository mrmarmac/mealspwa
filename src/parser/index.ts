/**
 * The ingredient parser.
 *
 * Contract: parsing is pure, synchronous and deterministic. The same text under
 * the same PARSER_VERSION always produces the same lineKeys, because those keys
 * anchor the user's overrides and their shopping ticks — a parser that shuffled
 * its own keys would silently untick a half-finished trolley.
 */
import type {
  AltMeasure,
  IngredientOverride,
  MeasurementDialect,
  PackSize,
  ParsedIngredientLine,
  Qualifier,
  Quantity,
  UnitCode,
  UnitKind,
} from '@/domain/types';
import categoriesJson from './lexicon/categories.json';
import {
  canonicaliseItem,
  DISTINGUISHING,
  isKnownFood,
  isLexiconPhrase,
  STRIPPABLE_PREFIXES,
} from './canonical';
import { looksVerbLike, scoreParse } from './confidence';
import { lookupContainer, parsePack } from './containers';
import { isSectionHeader, type HeaderLexicon } from './headers';
import { parseQuantityPrefix } from './numbers';
import {
  extractQualifiers,
  matchNamedPattern,
  matchSeasoning,
  splitItemAndNote,
} from './notes';
import { classifyParenthetical, extractParentheticals } from './parentheticals';
import {
  analyseBlock,
  normaliseKey,
  normalizeUnicode,
  stripBullet,
  tokenizeWithGroups,
} from './tokenize';
import { detectDialect, lookupUnit } from './units';

export const PARSER_VERSION = 2;

export const PANTRY_STAPLES = new Set<string>(categoriesJson.pantryStaples);
export const HALVABLE = new Set<string>(categoriesJson.halvable);

const HEADER_LEXICON: HeaderLexicon = {
  isFood: (phrase) => isLexiconPhrase(phrase),
  isSeasoning: (phrase) => matchSeasoning(phrase) !== null,
};

export interface ParseOptions {
  /** Overrides the sniffed dialect. */
  dialect?: MeasurementDialect;
  /** ItemMeta.aliasOf, itemKey -> canonical itemKey. */
  aliases?: Record<string, string>;
}

export interface ParseContext {
  dialect: MeasurementDialect;
  /** Nearest preceding header. */
  section: string | null;
  /** Next non-blank line, needed by header rule 3. */
  next: string | null;
  /** Nth line with this exact normalised text within the block. */
  occurrenceIndex: number;
  aliases?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// lineKey
// ---------------------------------------------------------------------------

/**
 * FNV-1a, run twice for 64 bits of output. Synchronous, dependency-free and
 * stable across engines — crypto.subtle is async and cannot be used here.
 */
export function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 ^ (c + i)) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** Whitespace, case and bullet noise must not change the key. */
export function normaliseForKey(raw: string): string {
  return normaliseKey(stripBullet(normalizeUnicode(raw), true));
}

export function makeLineKey(raw: string, occurrenceIndex: number): string {
  return `${hashString(normaliseForKey(raw)).slice(0, 10)}:${occurrenceIndex}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PREP_ADVERB = '(?:roughly |rough |finely |coarsely |thinly |very |well )';
const PREP_PARTICIPLE =
  '(?:chopped|minced|crushed|torn|peeled|halved|quartered|cubed|seeded|pitted|deveined|trimmed|cooked|toasted|drained|rinsed|thawed|defrosted|smashed|washed|sliced|diced|grated|shredded|crumbled|stemmed)';
/** An adverb makes ANY participle preparation: 'finely shredded parmesan'. */
const LEADING_PREP = new RegExp(
  `^(?:${PREP_ADVERB}${PREP_PARTICIPLE}|${PREP_ADVERB}[a-z]+ed|${PREP_PARTICIPLE})\\s+`,
  'i',
);

/**
 * '1 handful (30g) chopped spinach' is spinach; '400g chopped tomatoes' is a
 * tin of chopped tomatoes. The lexicon decides: a leading participle is only
 * preparation when the phrase WITH it is not itself a product.
 */
function splitLeadingPrep(item: string): { item: string; prep: string | null } {
  let current = item;
  const preps: string[] = [];
  for (let guard = 0; guard < 4; guard++) {
    const m = LEADING_PREP.exec(current);
    if (!m) break;
    if (isLexiconPhrase(current)) break;
    const rest = current.slice(m[0].length).trim();
    if (!rest) break;
    preps.push(m[0].trim());
    current = rest;
  }
  return { item: current, prep: preps.length ? preps.join(' ') : null };
}

function qty(n: number, raw: string): Quantity {
  return { low: n, high: n, isRange: false, approx: false, raw };
}

function tokenCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Lookahead used by the range grammar: a range must be followed by a measure. */
function rangeFollows(rest: string): boolean {
  const t = rest.trim();
  if (!t) return false;
  const toks = tokenizeWithGroups(t);
  const first = toks[0];
  if (first === undefined) return false;
  if (lookupUnit(first)) return true;
  const f = normaliseKey(first).replace(/[.,;:]+$/, '');
  if (STRIPPABLE_PREFIXES.includes(f)) return true;
  if (DISTINGUISHING.has(f)) return true;
  if (lookupContainer(f)) return true;
  return isKnownFood(f) || isKnownFood(t.replace(/[,;].*$/, ''));
}

const WATER_KEYS =
  /^(water|tap water|boiling water|cold water|hot water|iced water|pasta water|ice|ice cube)$/;

/** 'approx. 375 grams clementines' — the hedge belongs on the number, not the item. */
const APPROX_LEAD = /^(about|approx\.?|approximately|around|roughly|circa|~)\s+/i;

function stripParens(s: string): string {
  return extractParentheticals(s).text;
}

/** A token that sits where a unit should be but is not one we know. */
function looksLikeUnknownUnit(token: string | undefined): boolean {
  if (token === undefined) return false;
  const t = normaliseKey(token).replace(/[.,;:]+$/, '');
  // Real unit abbreviations are short; 'medjool' is a variety, not a unit.
  if (!t || !/^[a-z]{2,4}$/.test(t)) return false;
  if (lookupUnit(t) || lookupContainer(t)) return false;
  if (STRIPPABLE_PREFIXES.includes(t) || DISTINGUISHING.has(t)) return false;
  return !isKnownFood(t);
}

// ---------------------------------------------------------------------------
// The line parser
// ---------------------------------------------------------------------------

export function parseIngredientLine(
  raw: string,
  ctx: ParseContext,
  opts: ParseOptions = {},
): ParsedIngredientLine {
  const dialect = opts.dialect ?? ctx.dialect;
  const aliases = opts.aliases ?? ctx.aliases;
  const lineKey = makeLineKey(raw, ctx.occurrenceIndex);
  const raw0 = stripBullet(normalizeUnicode(raw), true).replace(/\s+/g, ' ').trim();
  const leadApprox = APPROX_LEAD.test(raw0);
  const text0 = leadApprox ? raw0.replace(APPROX_LEAD, '') : raw0;

  const shell = (): ParsedIngredientLine => ({
    lineKey,
    rawText: raw,
    isHeader: false,
    section: ctx.section,
    quantity: null,
    unit: null,
    unitKind: 'none',
    packSize: null,
    item: '',
    itemKey: '',
    itemAliases: [],
    clarifier: null,
    note: null,
    qualifiers: [],
    alternates: [],
    confidence: 0,
    confidenceReasons: ['blank line'],
    parserVersion: PARSER_VERSION,
    overridden: false,
    excluded: true,
  });

  if (!text0) return shell();

  // ---- headers ----------------------------------------------------------
  const bare = extractParentheticals(text0);
  const verdict = isSectionHeader(bare.text, ctx.next, HEADER_LEXICON);
  if (verdict.isHeader) {
    return {
      ...shell(),
      isHeader: true,
      section: verdict.section,
      item: bare.text.replace(/[:：]\s*$/, '').trim(),
      confidence: verdict.confidence,
      confidenceReasons:
        verdict.rule === 3
          ? ['-0.30 ambiguous header (rule 3)']
          : [`header rule ${verdict.rule}`],
      excluded: true,
    };
  }

  // An imprecise phrase ('a big handful of basil') is recognised BEFORE the
  // number grammar, so the leading 'a' is not mistaken for a count of one.
  const preNamed = matchNamedPattern(bare.text);
  const preIsImprecise = preNamed !== null && preNamed.kind === 'imprecise-of';
  const leadingQty = preIsImprecise
    ? null
    : parseQuantityPrefix(text0, { allowWordNumbers: true, rangeFollows });

  // ---- seasoning phrases ------------------------------------------------
  if (!leadingQty) {
    const seasoning = matchSeasoning(bare.text);
    if (seasoning) {
      const q = extractQualifiers(text0);
      if (!q.includes('to-taste')) q.push('to-taste');
      q.push('pantry-staple');
      return {
        ...shell(),
        item: seasoning.display,
        itemKey: seasoning.itemKey,
        qualifiers: q,
        confidence: 0.9,
        confidenceReasons: ['+0.10 seasoning phrase'],
        excluded: false,
      };
    }
  }

  // ---- quantity, unit and pack ------------------------------------------
  let quantity: Quantity | null = null;
  let unit: UnitCode | null = null;
  let unitKind: UnitKind = 'none';
  let packSize: PackSize | null = null;
  let rest = text0;
  let namedPattern = false;
  let unrecognisedUnit = false;
  let approx = false;
  let namedNote: string | null = null;
  const qualifiers: Qualifier[] = [];
  const alternates: AltMeasure[] = [];

  if (!leadingQty && !preIsImprecise) {
    // 'large bunch fresh parsley' is one bunch. Only container and imprecise
    // nouns qualify, so 'olive oil' is never invented a quantity.
    const toks = tokenizeWithGroups(bare.text);
    let idx = 0;
    while (
      toks[idx] !== undefined &&
      STRIPPABLE_PREFIXES.includes(normaliseKey(toks[idx]!))
    ) {
      idx++;
    }
    const candidate = toks[idx];
    // 'canned tomatoes' is an adjective, not a count of tins.
    const isNoun = candidate !== undefined && !/ed$/i.test(candidate);
    const def = candidate === undefined || !isNoun ? null : lookupUnit(candidate);
    if (def && (def.kind === 'count' || def.kind === 'imprecise') && def.code !== 'each' &&
        toks.length > idx + 1) {
      quantity = qty(1, '1');
      unit = def.code;
      unitKind = def.kind;
      rest = toks.slice(idx + 1).join(' ');
    }
  }
  const pack = quantity ? null : parsePack(text0, dialect);
  if (pack && pack.matched && pack.packSize && pack.count) {
    quantity = pack.count;
    unit = pack.packSize.container;
    unitKind = 'count';
    packSize = pack.packSize;
    approx = pack.sizeApprox;
    rest = pack.rest;
  } else if (leadingQty) {
    quantity = leadingQty.qty;
    rest = leadingQty.rest.trim();
    const toks = tokenizeWithGroups(rest);
    const head = toks[0];
    if (head !== undefined && /^x$/i.test(head)) {
      rest = toks.slice(1).join(' ');
    } else {
      // '1 small clove garlic': a size adjective may sit in front of the unit.
      let at = 0;
      while (
        at < 2 &&
        toks[at] !== undefined &&
        STRIPPABLE_PREFIXES.includes(normaliseKey(toks[at]!)) &&
        toks[at + 1] !== undefined &&
        lookupUnit(toks[at + 1]!) !== null
      ) {
        at++;
      }
      const candidate = toks[at];
      const def = candidate === undefined ? null : lookupUnit(candidate);
      if (def) {
        unit = def.code;
        unitKind = def.kind;
        rest = toks.slice(at + 1).join(' ');
      } else {
        unrecognisedUnit = looksLikeUnknownUnit(head);
      }
    }
    rest = rest.replace(/^of\s+/i, '').trim();
    if (!unit) {
      unit = 'each';
      unitKind = 'count';
    }
  }

  // ---- named whole-line patterns ----------------------------------------
  const named = matchNamedPattern(stripParens(rest));
  if (named) {
    if (named.kind === 'zest-juice') {
      namedPattern = true;
      namedNote = named.note;
      rest = named.item;
      unit = 'each';
      unitKind = 'count';
      unrecognisedUnit = false;
      if (!quantity) quantity = qty(named.quantity ?? 1, String(named.quantity ?? 1));
    } else if (named.kind === 'imprecise-of' && !quantity) {
      namedPattern = true;
      rest = named.item;
      unit = named.unit;
      const def = named.unit ? lookupUnit(named.unit) : null;
      unitKind = def ? def.kind : 'none';
      quantity = qty(named.quantity ?? 1, String(named.quantity ?? 1));
    } else if (named.kind === 'bare-to-taste' && !quantity) {
      rest = named.item;
      namedNote = named.note;
      for (const q of named.qualifiers) if (!qualifiers.includes(q)) qualifiers.push(q);
    }
  }

  // ---- parentheticals ---------------------------------------------------
  const inner = extractParentheticals(rest);
  let clarifier: string | null = null;
  const clarifierNotes: string[] = [];
  for (const part of inner.parts) {
    const p = classifyParenthetical(part, { hasContainer: packSize !== null });
    switch (p.kind) {
      case 'alt-measure':
      case 'packSize':
        if (p.alt) alternates.push(p.alt);
        if (p.approx) approx = true;
        break;
      case 'drainedSize':
        if (packSize) packSize = { ...packSize, drainedSize: p.drainedSize };
        else clarifierNotes.push(p.text);
        break;
      case 'qualifier':
        if (p.qualifier && !qualifiers.includes(p.qualifier)) qualifiers.push(p.qualifier);
        break;
      case 'approx':
        approx = true;
        clarifierNotes.push(p.text);
        break;
      default:
        if (p.isPrep) clarifierNotes.push(p.text);
        else if (clarifier === null) clarifier = p.text;
        else clarifierNotes.push(p.text);
    }
  }

  // '-baby potatoes (around 500-600g)' has no primary quantity but does have a
  // real weight. Promote it rather than shipping a numberless row.
  if (!quantity && alternates.length > 0) {
    const alt =
      alternates.find((a) => a.unitKind === 'mass') ??
      alternates.find((a) => a.unitKind === 'volume');
    if (alt) {
      quantity = { low: alt.quantity, high: alt.quantity, isRange: false, approx: true, raw: String(alt.quantity) };
      unit = alt.unit;
      unitKind = alt.unitKind;
    }
  }

  // ---- item and note ----------------------------------------------------
  const split = splitItemAndNote(inner.text);
  let itemText = split.item;

  // '1 garlic clove' is one clove of garlic, not one thing called 'garlic
  // clove'. Done after the note split so the trailing token is really the head.
  if (unit === 'each' && quantity) {
    const t = itemText.split(/\s+/).filter(Boolean);
    const last = t[t.length - 1];
    if (t.length > 1 && last !== undefined) {
      const container = lookupContainer(last);
      if (container) {
        unit = container;
        unitKind = 'count';
        unrecognisedUnit = false;
        itemText = t.slice(0, -1).join(' ');
      }
    }
  }

  const prep = splitLeadingPrep(itemText);
  const note =
    [namedNote, split.note, prep.prep, ...clarifierNotes]
      .filter((n): n is string => !!n && n.length > 0)
      .join('; ') || null;

  const canonical = canonicaliseItem(prep.item, aliases ? { aliases } : {});

  // Garlic is only ever measured in cloves in this app — never grams or bare
  // counts — so coerce the unit once we know the item is garlic (but not
  // 'garlic powder', which canonicalises to its own itemKey).
  if (canonical.itemKey === 'garlic') {
    unit = 'clove';
    unitKind = 'count';
    unrecognisedUnit = false;
  }

  // ---- qualifiers -------------------------------------------------------
  for (const q of extractQualifiers(text0, note)) {
    if (!qualifiers.includes(q)) qualifiers.push(q);
  }
  if (PANTRY_STAPLES.has(canonical.itemKey) && !qualifiers.includes('pantry-staple')) {
    qualifiers.push('pantry-staple');
  }
  // An imprecise unit means 'never sum this' — unless the line also gave us a
  // real equivalent, e.g. '1 handful (30g) spinach', which we can total.
  if (unitKind === 'imprecise' && alternates.length === 0 && !qualifiers.includes('to-taste')) {
    qualifiers.push('to-taste');
  }

  // ---- scoring ----------------------------------------------------------
  const knownFood = canonical.itemKey.length > 0 && isKnownFood(canonical.itemKey);
  const unstructured = quantity === null && !namedPattern && !knownFood;
  const toTasteOrStaple =
    qualifiers.includes('to-taste') ||
    qualifiers.includes('pantry-staple') ||
    unitKind === 'imprecise' ||
    ((qualifiers.includes('to-serve') || qualifiers.includes('to-garnish')) && knownFood);

  const score = scoreParse({
    namedPattern,
    knownFood,
    hasQuantity: quantity !== null,
    toTasteOrStaple,
    unrecognisedUnit,
    unstructuredFallback: unstructured,
    itemTokenCount: tokenCount(canonical.displayName),
    itemHasDigitOrVerb: looksVerbLike(canonical.displayName),
    ambiguousHeader: false,
    unknownHeadNoun: !knownFood && canonical.itemKey.length > 0,
  });

  if ((approx || leadApprox) && quantity) quantity = { ...quantity, approx: true };

  return {
    lineKey,
    rawText: raw,
    isHeader: false,
    section: ctx.section,
    quantity,
    unit,
    unitKind: unit ? unitKind : 'none',
    packSize,
    item: canonical.displayName,
    itemKey: canonical.itemKey,
    itemAliases: canonical.aliases,
    clarifier,
    note,
    qualifiers,
    alternates,
    confidence: score.confidence,
    confidenceReasons: score.reasons,
    parserVersion: PARSER_VERSION,
    overridden: false,
    excluded: WATER_KEYS.test(canonical.itemKey) || canonical.itemKey.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export function parseIngredientBlock(
  text: string,
  opts: ParseOptions = {},
): ParsedIngredientLine[] {
  const { lines } = analyseBlock(text);
  const dialect = opts.dialect ?? detectDialect(text) ?? 'metric-uk';
  const out: ParsedIngredientLine[] = [];
  const seen = new Map<string, number>();
  let section: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.blank) continue;
    let next: string | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j]!.blank) {
        next = lines[j]!.text;
        break;
      }
    }
    const key = normaliseForKey(line.raw);
    const occurrenceIndex = seen.get(key) ?? 0;
    seen.set(key, occurrenceIndex + 1);

    const lineCtx: ParseContext = {
      dialect,
      section,
      next,
      occurrenceIndex,
      ...(opts.aliases ? { aliases: opts.aliases } : {}),
    };
    const parsed = parseIngredientLine(line.raw.trim(), lineCtx, { ...opts, dialect });
    if (parsed.isHeader) section = parsed.section;
    out.push(parsed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

/**
 * User corrections win over the parse, and they are matched on lineKey — so
 * editing the recipe text drops the stale override rather than reapplying it to
 * different content.
 */
export function applyOverrides(
  lines: ParsedIngredientLine[],
  overrides: IngredientOverride[],
): ParsedIngredientLine[] {
  if (overrides.length === 0) return lines;
  const byKey = new Map<string, IngredientOverride>();
  for (const o of overrides) byKey.set(o.lineKey, o);

  return lines.map((line) => {
    const o = byKey.get(line.lineKey);
    if (!o) return line;
    const next: ParsedIngredientLine = { ...line, overridden: true };
    if (o.quantity !== undefined) {
      next.quantity =
        o.quantity === null
          ? null
          : {
              low: o.quantity.low,
              high: o.quantity.high,
              isRange: o.quantity.low !== o.quantity.high,
              approx: false,
              raw:
                o.quantity.low === o.quantity.high
                  ? `${o.quantity.low}`
                  : `${o.quantity.low}-${o.quantity.high}`,
            };
    }
    if (o.unit !== undefined) {
      next.unit = o.unit;
      const def = o.unit ? lookupUnit(o.unit) : null;
      next.unitKind = def ? def.kind : 'none';
    }
    if (o.item !== undefined) {
      const canonical = canonicaliseItem(o.item);
      next.item = o.item;
      next.itemKey = o.itemKey ?? canonical.itemKey;
    } else if (o.itemKey !== undefined) {
      next.itemKey = o.itemKey;
    }
    if (o.note !== undefined) next.note = o.note;
    if (o.qualifiers !== undefined) next.qualifiers = o.qualifiers;
    if (o.excluded !== undefined) next.excluded = o.excluded;
    return next;
  });
}
