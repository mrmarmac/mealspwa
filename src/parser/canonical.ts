/**
 * Canonicalisation — turning 'Fresh Cherry Tomatoes' into the merge key
 * 'cherry tomato'.
 *
 * The whole shopping list rests on exact itemKey equality, so this file has one
 * job and two failure modes. Under-normalising splits 'spring onions' from
 * 'spring onion' into two rows. Over-normalising merges 'cherry tomato' into
 * 'tomato', which silently buys the wrong thing. When in doubt this code
 * under-normalises: a duplicate row is annoying, a wrong merge is a lie.
 */
import foodsJson from './lexicon/foods.json';
import irregularsJson from './lexicon/irregulars.json';
import synonymsJson from './lexicon/synonyms.json';
import categoriesJson from './lexicon/categories.json';
import { normaliseKey } from './tokenize';

export const FOODS: Record<string, string> = foodsJson.foods as Record<string, string>;
export const IRREGULAR_PLURALS: Record<string, string> = irregularsJson.plurals;
export const UNCOUNTABLE = new Set<string>(irregularsJson.uncountable);
export const SYNONYMS: Record<string, string> = synonymsJson.synonyms;
export const DISTINGUISHING = new Set<string>(categoriesJson.distinguishing);

/**
 * Adjectives that describe how nice the ingredient is rather than what it is.
 * Everything NOT on this list — colours, varieties, processes — is kept,
 * because that is the actual product on the shelf.
 */
export const STRIPPABLE_PREFIXES = [
  'fresh',
  'freshly',
  'good quality',
  'good-quality',
  'good',
  'your favourite',
  'your favorite',
  'favourite',
  'favorite',
  'nice',
  'ripe',
  'large',
  'small',
  'medium',
  'big',
  'whole',
  'smallish',
  'regular',
  'home-cooked',
  'homecooked',
  'plenty of',
  'lots of',
  'some',
];

const SYNONYM_KEYS = Object.keys(SYNONYMS).sort((a, b) => b.length - a.length);

export interface CanonicalContext {
  /** User-confirmed aliases, itemKey -> canonical itemKey (ItemMeta.aliasOf). */
  aliases?: Record<string, string>;
}

export interface CanonicalItem {
  itemKey: string;
  displayName: string;
  aliases: string[];
}

/** Step 1: lowercase, strip trailing punctuation, collapse space, drop articles. */
function tidy(input: string): string {
  let s = normaliseKey(input);
  s = s.replace(/^[\s\-\u2013\u2014\u2022*]+/, '');
  s = s.replace(/\*/g, ' ');
  s = s.replace(/[\s.,;:!?]+$/, '');
  s = s.replace(/^(a|an|the)\s+/, '');
  s = s.replace(/\s+of\s+the\s+/g, ' ');
  s = s.replace(/^of\s+/, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** Step 2: remove only the non-distinguishing prefixes, and never all of them. */
function stripPrefixes(input: string): string {
  let s = input;
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of STRIPPABLE_PREFIXES) {
      if (s === p) return s; // 'fresh' on its own is all we have; keep it
      if (s.startsWith(`${p} `)) {
        const rest = s.slice(p.length + 1).trim();
        // 'whole grain', 'whole milk' are products, not a stray 'whole'.
        if (p === 'whole' && /^(grain|wheat|meal|milk|egg|foods?)\b/.test(rest)) continue;
        if (rest.split(' ').length >= 1 && rest.length > 0) {
          s = rest;
          changed = true;
          break;
        }
      }
    }
  }
  // Stripping can leave a dangling conjunction: 'small whole fresh or dried
  // red chilli' becomes 'or dried red chilli' without this.
  return s.replace(/^(or|and)\s+/, '').trim();
}

/** Step 3: 'cannellini/white beans' => primary + alias, sharing the tail noun. */
function expandSlashes(input: string): { primary: string; aliases: string[] } {
  const s = input.replace(/\s*\/\s*/g, '/');
  if (!s.includes('/')) return { primary: s, aliases: [] };
  const tokens = s.split(' ');
  const idx = tokens.findIndex((t) => t.includes('/'));
  if (idx < 0) return { primary: s, aliases: [] };
  const before = tokens.slice(0, idx);
  const after = tokens.slice(idx + 1);
  const alts = tokens[idx]!.split('/').filter(Boolean);
  if (alts.length < 2) return { primary: s, aliases: [] };
  const build = (a: string): string => [...before, a, ...after].join(' ').trim();
  return { primary: build(alts[0]!), aliases: alts.slice(1).map(build) };
}

/** Step 4: singularise the HEAD NOUN ONLY. */
export function singulariseHead(phrase: string): string {
  const tokens = phrase.split(' ');
  const head = tokens[tokens.length - 1];
  if (head === undefined) return phrase;
  const singular = singulariseWord(head, phrase);
  tokens[tokens.length - 1] = singular;
  return tokens.join(' ');
}

function inLexicon(word: string): boolean {
  return Object.prototype.hasOwnProperty.call(FOODS, word);
}

export function singulariseWord(word: string, wholePhrase = ''): string {
  const w = word;
  if (UNCOUNTABLE.has(w) || UNCOUNTABLE.has(wholePhrase)) return w;
  const irregular = IRREGULAR_PLURALS[w];
  if (irregular !== undefined) return irregular;
  if (!w.endsWith('s') || w.length <= 2) return w;
  if (/(ss|us|is)$/.test(w)) return w;

  // Candidate singulars, most specific rule first. The lexicon acts as the
  // arbiter: 'quiches' -> 'quiche' (in the lexicon), not 'quich'.
  const candidates: string[] = [];
  if (/[^aeiou]ies$/.test(w) && w.length > 4) candidates.push(`${w.slice(0, -3)}y`);
  if (/oes$/.test(w)) candidates.push(w.slice(0, -2));
  if (/(ches|shes|xes|zes|sses)$/.test(w)) candidates.push(w.slice(0, -2));
  candidates.push(w.slice(0, -1));
  if (/(ches|shes|xes|zes)$/.test(w)) candidates.push(w.slice(0, -2));

  for (const c of candidates) {
    if (inLexicon(c)) return c;
  }
  return candidates[0]!;
}

/** Step 5: US/AU vocabulary to UK canonical, longest phrase first. */
export function applySynonyms(phrase: string): string {
  const whole = SYNONYMS[phrase];
  if (whole !== undefined) return whole;
  let s = phrase;
  for (const key of SYNONYM_KEYS) {
    if (!key.includes(' ') && key.length < 3) continue;
    const re = new RegExp(`(^|\\s)${escapeRe(key)}(\\s|$)`, 'g');
    if (re.test(s)) s = s.replace(re, `$1${SYNONYMS[key]}$2`);
  }
  s = s.replace(/\s+/g, ' ').trim();
  // A replacement can produce a new whole-phrase match ('bell pepper' -> 'pepper').
  const second = SYNONYMS[s];
  return second !== undefined && second !== s ? second : s;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Removes a duplicated word left behind by a synonym rewrite. */
function dedupeAdjacent(s: string): string {
  const t = s.split(' ');
  const out: string[] = [];
  for (const w of t) {
    if (out.length && out[out.length - 1] === w) continue;
    out.push(w);
  }
  return out.join(' ');
}

function titleish(key: string, original: string): string {
  // Prefer the user's own wording when it canonicalises to the same key.
  const cleaned = tidy(original);
  return cleaned.length ? cleaned : key;
}

/**
 * The full pipeline. `displayName` is what the user sees; `itemKey` is the only
 * thing merging ever compares.
 */
export function canonicaliseItem(item: string, ctx: CanonicalContext = {}): CanonicalItem {
  const step1 = tidy(item);
  if (!step1) return { itemKey: '', displayName: '', aliases: [] };
  const step2 = stripPrefixes(step1);
  const { primary, aliases: slashAliases } = expandSlashes(step2);

  const finish = (s: string): string => {
    const singular = singulariseHead(s);
    const synonymised = dedupeAdjacent(applySynonyms(singular));
    const userAlias = ctx.aliases?.[synonymised];
    return userAlias ?? synonymised;
  };

  const itemKey = finish(primary);
  const aliases = slashAliases.map(finish).filter((a) => a && a !== itemKey);
  return {
    itemKey,
    displayName: titleish(itemKey, primary || step1),
    aliases: [...new Set(aliases)],
  };
}

/**
 * True when the phrase names a food we recognise. The head-noun fallback is
 * capped at three words on purpose: 'canned tomatoes, onions, garlic, eggs,
 * jarred peppers' ends in a known noun but is not a thing you can buy, and
 * letting it claim recognition would hide it from review.
 */
export function isKnownFood(phrase: string): boolean {
  const p = normaliseKey(phrase);
  if (!p || /[,;]/.test(p)) return false;
  if (inLexicon(p)) return true;
  const singular = singulariseHead(p);
  if (inLexicon(singular)) return true;
  const syn = applySynonyms(singular);
  if (inLexicon(syn)) return true;
  const tokens = syn.split(' ');
  if (tokens.length > 3) return false;
  const head = tokens[tokens.length - 1];
  return head !== undefined && inLexicon(head);
}

/** True when the ENTIRE phrase is a lexicon entry — used by the header rules. */
export function isLexiconPhrase(phrase: string): boolean {
  const p = normaliseKey(phrase).replace(/[.,;:]+$/, '');
  if (!p) return false;
  if (inLexicon(p)) return true;
  const singular = singulariseHead(p);
  if (inLexicon(singular)) return true;
  return inLexicon(applySynonyms(singular));
}

export function foodCategory(itemKey: string): string | null {
  return FOODS[itemKey] ?? null;
}

// ---------------------------------------------------------------------------
// Similarity — SUGGESTIONS ONLY. This never merges anything by itself.
// ---------------------------------------------------------------------------

function trigrams(s: string): Set<string> {
  const padded = `  ${s.replace(/\s+/g, ' ').trim()} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Dice coefficient over character trigrams. 1 = identical, 0 = nothing shared. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/**
 * True when two keys differ by a word that changes what you buy. Used to veto
 * merge suggestions: 'cherry tomato' must never be proposed against 'tomato'.
 */
export function differsByDistinguishingToken(a: string, b: string): boolean {
  const sa = new Set(a.split(' '));
  const sb = new Set(b.split(' '));
  for (const t of sa) if (!sb.has(t) && DISTINGUISHING.has(t)) return true;
  for (const t of sb) if (!sa.has(t) && DISTINGUISHING.has(t)) return true;
  return false;
}
