/**
 * Splitting an ingredient from its note, and the named whole-line shapes.
 *
 * The comma rule is deliberately conservative: a comma only splits when what
 * follows looks like a preparation instruction. 'salt, pepper and oil' has a
 * comma and must survive intact, because mangling it invents ingredients the
 * user never wrote.
 */
import type { Qualifier } from '@/domain/types';
import categoriesJson from './lexicon/categories.json';
import { normaliseKey } from './tokenize';

/** Words that describe the product, not the preparation. */
const DISTINGUISHING = new Set<string>(categoriesJson.distinguishing);

export const PREP_WORDS: string[] = [
  'drained',
  'rinsed',
  'washed',
  'chopped',
  'rough chopped',
  'roughly chopped',
  'finely chopped',
  'coarsely chopped',
  'minced',
  'diced',
  'finely diced',
  'sliced',
  'thinly sliced',
  'finely sliced',
  'crushed',
  'grated',
  'coarsely grated',
  'finely grated',
  'zested',
  'juiced',
  'deveined',
  'peeled',
  'halved',
  'quartered',
  'torn',
  'toasted',
  'divided',
  'plus more',
  'plus extra',
  'plus 1',
  'to taste',
  'to serve',
  'to garnish',
  'for serving',
  'for garnish',
  'softened',
  'melted',
  'cooked',
  'cut into',
  'seeded',
  'stemmed',
  'trimmed',
  'optional',
  'or',
  'shredded',
  'cubed',
  'julienned',
  'smashed',
  'pitted',
  'stoned',
  'uncooked',
  'cold',
  'warm',
  'hot',
  'raw',
  'fresh',
  'at room temperature',
  'room temperature',
  'see note',
  'can use',
  'i used',
  'i prefer',
  'sub with',
  'more or less',
  'end trimmed',
  'top chopped',
  'stalks removed',
  'seed removed',
  'skin on',
  'skin off',
  'bone in',
  'boneless',
  'thawed',
  'defrosted',
  'drizzled',
  'reserved',
  'plus',
];

const PREP_RE = new RegExp(
  `^\\s*(?:and\\s+|then\\s+|very\\s+|well\\s+)?(?:${PREP_WORDS.map(escapeRe)
    .sort((a, b) => b.length - a.length)
    .join('|')})\\b`,
  'i',
);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ItemAndNote {
  item: string;
  note: string | null;
}

const DASH_SPLIT = /\s+[-\u2013\u2014]\s+|\s+\+\s+/;

/** A participle at the very end, with no comma: '2 cloves of garlic minced'. */
const TRAILING_PREP =
  /\s+((?:finely |roughly |thinly |coarsely |very )?(?:minced|crushed|chopped|diced|sliced|grated|drained|rinsed|peeled|halved|quartered|deveined|trimmed|toasted|torn|shredded|cubed|softened|melted|divided|smashed|seeded))$/i;

/** 'to thin out', 'to coat it all' — a purpose, never part of the thing you buy. */
const PURPOSE_RE =
  /\s+(to\s+(?:thin|coat|serve|garnish|taste|top|finish|drizzle|fry|cook|season|dress|dust|brush|line|grease|thicken)\b.*)$/i;

/**
 * Splits an ingredient line into the thing you buy and the note about it.
 * The comma only splits when the right-hand side starts with a prep participle
 * or a known note pattern.
 */
export function splitItemAndNote(input: string): ItemAndNote {
  let s = input.trim();
  const notes: string[] = [];

  // ' - ', ' – ', ' + ' always separate a note.
  const dashIdx = s.search(DASH_SPLIT);
  if (dashIdx > 0) {
    const m = DASH_SPLIT.exec(s)!;
    notes.push(s.slice(dashIdx + m[0].length).trim());
    s = s.slice(0, dashIdx).trim();
  }

  // ' -cooked' (no trailing space) only when a prep word follows.
  const tight = /\s-\s*(?=[A-Za-z])/.exec(s);
  if (tight && PREP_RE.test(s.slice(tight.index + tight[0].length))) {
    notes.unshift(s.slice(tight.index + tight[0].length).trim());
    s = s.slice(0, tight.index).trim();
  }

  // first comma whose right-hand side is a prep/note phrase
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ',') continue;
    const rhs = s.slice(i + 1);
    // A four-letter-or-longer '-ed' word is a participle even when it is
    // misspelt ('choped'), which a fixed PREP_WORDS list cannot cover. Words
    // that describe the product ('jarred peppers') are excluded.
    const ed = /^\s*([a-z]{4,}ed)\b/i.exec(rhs);
    if (PREP_RE.test(rhs) || (ed && !DISTINGUISHING.has(ed[1]!.toLowerCase()))) {
      notes.unshift(rhs.trim());
      s = s.slice(0, i).trim();
      break;
    }
  }

  // '*optional*' and a bare trailing 'optional' are notes, not part of the name.
  const opt = /\s*[,(*]*\s*\b(optional|if desired|if using)\b[*)]*\.?$/i.exec(s);
  if (opt && opt.index > 0) {
    notes.push(opt[1]!.trim());
    s = s.slice(0, opt.index).trim();
  }

  // A trailing participle with no comma: '2 cloves of garlic minced'.
  const trailing = TRAILING_PREP.exec(s);
  if (trailing && trailing.index > 0 && s.slice(0, trailing.index).trim().split(/\s+/).length >= 1) {
    notes.push(trailing[1]!.trim());
    s = s.slice(0, trailing.index).trim();
  }

  const per = /\s*,?\s*\b(per person|per head)\b\.?$/i.exec(s);
  if (per && per.index > 0) {
    notes.push(per[1]!.trim());
    s = s.slice(0, per.index).trim();
  }

  const purpose = PURPOSE_RE.exec(s);
  if (purpose && purpose.index > 0) {
    notes.push(purpose[1]!.trim());
    s = s.slice(0, purpose.index).trim();
  }

  const note = notes.filter(Boolean).join('; ').replace(/\s+/g, ' ').trim();
  return { item: s.replace(/[\s,;.]+$/, '').trim(), note: note || null };
}

// ---------------------------------------------------------------------------
// Qualifiers
// ---------------------------------------------------------------------------

const QUALIFIER_PATTERNS: { re: RegExp; q: Qualifier }[] = [
  { re: /\boptional\b|\bif desired\b|\bif using\b|\bif you like\b/i, q: 'optional' },
  { re: /\bto taste\b|\bmore or less to taste\b|\bseason to taste\b/i, q: 'to-taste' },
  { re: /\bto serve\b|\bfor serving\b|\bfor the table\b/i, q: 'to-serve' },
  { re: /\bto garnish\b|\bfor garnish\b|\bto decorate\b/i, q: 'to-garnish' },
  { re: /\bdivided\b/i, q: 'divided' },
  { re: /\bper person\b|\bper head\b|\bpp\b/i, q: 'per-person' },
  { re: /\bplus more\b|\bplus extra\b|\bplus 1\b|\band extra\b|\b& extra\b/i, q: 'plus-more' },
];

/** Reads qualifiers out of the whole line — item, note and parentheticals. */
export function extractQualifiers(...texts: (string | null)[]): Qualifier[] {
  const hay = texts.filter((t): t is string => !!t).join(' ; ');
  const out: Qualifier[] = [];
  for (const { re, q } of QUALIFIER_PATTERNS) {
    if (re.test(hay) && !out.includes(q)) out.push(q);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seasoning phrases
// ---------------------------------------------------------------------------

/**
 * Exact phrases that collapse to one pantry row. These must never be split into
 * two ingredients: nobody wants 'salt' and 'pepper' as separate trolley lines
 * six times over.
 */
export const SEASONING_PHRASES: Record<string, string> = {
  'salt and pepper': 'salt and pepper',
  'salt & pepper': 'salt and pepper',
  'salt n pepper': 'salt and pepper',
  'salt, pepper': 'salt and pepper',
  'pepper and salt': 'salt and pepper',
  'salt and black pepper': 'salt and pepper',
  'salt and freshly ground black pepper': 'salt and pepper',
  'salt and freshly cracked black pepper': 'salt and pepper',
  'salt and ground black pepper': 'salt and pepper',
  'salt and cracked black pepper': 'salt and pepper',
  'sea salt and black pepper': 'salt and pepper',
  'sea salt and cracked black pepper': 'salt and pepper',
  'sea salt and freshly ground black pepper': 'salt and pepper',
  'sea salt and pepper': 'salt and pepper',
  'kosher salt and black pepper': 'salt and pepper',
  'kosher salt and freshly ground black pepper': 'salt and pepper',
  'kosher salt and pepper': 'salt and pepper',
  'freshly ground salt and black pepper': 'salt and pepper',
  'freshly ground salt and pepper': 'salt and pepper',
  'flaky sea salt and black pepper': 'salt and pepper',
  'salt and pepper to taste': 'salt and pepper',
  'salt and black pepper to taste': 'salt and pepper',
  'pinch salt': 'salt',
  'pinch of salt and pepper': 'salt and pepper',
  'pinch salt and pepper': 'salt and pepper',
  'salt and pepper for seasoning': 'salt and pepper',
  'pinch of salt': 'salt',
  'pinch pepper': 'black pepper',
  'pinch of pepper': 'black pepper',
  'salt and pepper to season': 'salt and pepper',
  'salt, pepper and olive oil': 'salt and pepper',
  'salt to taste': 'salt',
  'pepper to taste': 'black pepper',
  'salt n pepper to taste': 'salt and pepper',
  'olive oil, salt and pepper': 'salt and pepper',
  'plenty of olive oil, salt n pepper': 'salt and pepper',
};

const SEASONING_NORMALISERS: [RegExp, string][] = [
  [/\s*&\s*/g, ' and '],
  [/\bfreshly\b/g, ''],
  [/\bfresh\b/g, ''],
  [/\bgood\b/g, ''],
  [/\bgenerous\b/g, ''],
  [/\bbig\b/g, ''],
  [/\ba\b/g, ''],
  [/\bkosher\b|\btable\b|\bcooking\b|\brock\b|\bflaky\b/g, ''],
  [/\bground\b|\bcracked\b/g, ''],
  [/\s+/g, ' '],
];

export interface SeasoningMatch {
  itemKey: string;
  display: string;
}

/**
 * Recognises a whole line as a seasoning phrase. Returns null when the line is
 * anything else — including '1 tsp salt', which is a real measured quantity.
 */
export function matchSeasoning(line: string): SeasoningMatch | null {
  let s = normaliseKey(line).replace(/[.]+$/, '').trim();
  if (!s) return null;
  s = s.replace(/,?\s*(to taste|to season|for seasoning)$/, '').trim();
  const direct = SEASONING_PHRASES[s];
  if (direct) return { itemKey: direct, display: displayFor(direct) };

  let n = s;
  for (const [re, rep] of SEASONING_NORMALISERS) n = n.replace(re, rep);
  n = n.replace(/\s+/g, ' ').trim();
  const hit = SEASONING_PHRASES[n];
  if (hit) return { itemKey: hit, display: displayFor(hit) };

  // 'salt and black pepper' with any ordering of the usual modifiers
  if (/^(kosher |sea |table |cooking |flaky |rock )?salt (and|,) (ground |cracked |black |white )*pepper$/.test(n)) {
    return { itemKey: 'salt and pepper', display: 'salt and pepper' };
  }
  return null;
}

function displayFor(key: string): string {
  return key;
}

// ---------------------------------------------------------------------------
// Named whole-line patterns
// ---------------------------------------------------------------------------

export interface NamedPattern {
  kind: 'zest-juice' | 'imprecise-of' | 'bare-to-taste';
  /** Text remaining as the item. */
  item: string;
  note: string | null;
  unit: 'each' | 'pinch' | 'dash' | 'splash' | 'handful' | 'glug' | 'knob' | 'drizzle' | null;
  quantity: number | null;
  qualifiers: Qualifier[];
}

const ZEST_RE =
  /^(zest|juice|rind|peel)(?:\s+(?:and|&|\+)\s+(zest|juice|rind|peel))?\s+(?:of|from)\s+(.*)$/i;
const IMPRECISE_RE =
  /^(?:a\s+|an\s+|one\s+)?(?:big\s+|good\s+|generous\s+|large\s+|small\s+|few\s+|couple\s+of\s+)?(pinch|dash|splash|handful|glug|knob|drizzle|squeeze|grating)\s+(?:of\s+)?(.+)$/i;
const BARE_TASTE_RE = /^(.+?),\s*(to taste|to serve|to garnish|for serving|optional)\.?$/i;

const LEADING_QTY_RE = /^(\d+(?:\s+\d+\/\d+)?(?:\/\d+)?(?:\.\d+)?|half|a half|one|two|three|four|five|six|a|an)\s+/i;

/** Recognises the shapes that do not start with a quantity but still parse well. */
export function matchNamedPattern(line: string): NamedPattern | null {
  const s = line.trim().replace(/\.$/, '');

  const zest = ZEST_RE.exec(s);
  if (zest) {
    const parts = [zest[1]!.toLowerCase()];
    if (zest[2]) parts.push(zest[2].toLowerCase());
    let rest = zest[3]!.trim();
    let quantity = 1;
    const q = LEADING_QTY_RE.exec(rest);
    if (q) {
      const word = q[1]!.toLowerCase();
      const asNum = wordQty(word);
      if (asNum !== null) {
        quantity = asNum;
        rest = rest.slice(q[0].length).trim();
      }
    }
    return {
      kind: 'zest-juice',
      item: rest,
      note: parts.join(' and '),
      unit: 'each',
      quantity,
      qualifiers: [],
    };
  }

  const imp = IMPRECISE_RE.exec(s);
  if (imp) {
    const word = imp[1]!.toLowerCase();
    const unit =
      word === 'squeeze' || word === 'grating'
        ? 'splash'
        : (word as NamedPattern['unit']);
    return {
      kind: 'imprecise-of',
      item: imp[2]!.trim(),
      note: null,
      unit,
      quantity: 1,
      qualifiers: [],
    };
  }

  const bare = BARE_TASTE_RE.exec(s);
  if (bare && !LEADING_QTY_RE.test(bare[1]!)) {
    const tail = bare[2]!.toLowerCase();
    const qualifiers = extractQualifiers(tail);
    return {
      kind: 'bare-to-taste',
      item: bare[1]!.trim(),
      note: tail,
      unit: null,
      quantity: null,
      qualifiers,
    };
  }

  return null;
}

function wordQty(w: string): number | null {
  const table: Record<string, number> = {
    half: 0.5,
    'a half': 0.5,
    a: 1,
    an: 1,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
  };
  if (w in table) return table[w]!;
  if (/^\d+\s+\d+\/\d+$/.test(w)) {
    const [i, f] = w.split(/\s+/);
    const [n, d] = f!.split('/');
    return Number(i) + Number(n) / Number(d);
  }
  if (/^\d+\/\d+$/.test(w)) {
    const [n, d] = w.split('/');
    return Number(n) / Number(d);
  }
  if (/^\d+(\.\d+)?$/.test(w)) return Number(w);
  return null;
}
