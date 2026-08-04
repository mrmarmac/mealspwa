/**
 * Section headers. Getting this wrong in either direction is visible: a missed
 * header puts 'Dressing' on the shopping list, and an over-eager rule deletes
 * 'Salt' and 'Parmesan' from the recipe entirely. The lexicon check is what
 * stops the second failure, so rule 3 always defers to it.
 */
import { parseQuantityPrefix } from './numbers';
import { normaliseKey } from './tokenize';

export interface HeaderLexicon {
  /** True when the whole phrase is a known food. */
  isFood(phrase: string): boolean;
  /** True when the whole phrase is a seasoning phrase ('salt and pepper'). */
  isSeasoning(phrase: string): boolean;
}

export interface HeaderVerdict {
  isHeader: boolean;
  /** 0.95 for rules 1-2, 0.6 for the ambiguous rule 3. */
  confidence: number;
  rule: 1 | 2 | 3 | null;
  /** Cleaned section name, e.g. 'For the dressing:' => 'dressing'. */
  section: string | null;
}

const NOT_HEADER: HeaderVerdict = {
  isHeader: false,
  confidence: 0,
  rule: null,
  section: null,
};

/**
 * Whole lines that are structure, not ingredients, wherever they appear.
 * They come from pasted recipe blobs and would otherwise be bought.
 */
const STRUCTURAL = new Set([
  'method',
  'methods',
  'instructions',
  'instruction',
  'directions',
  'direction',
  'notes',
  'note',
  'ingredients',
  'ingredient',
  'preparation',
  'prep',
  'steps',
  'equipment',
  'tips',
  'tip',
  'to serve',
  'to finish',
  'garnish',
  'you will need',
  'shopping list',
  'nutrition',
]);

const META_LINE =
  /^(serves?|makes|yield[s]?|prep time|cook time|total time|cooking time|difficulty|servings)\b/i;

const FOR_THE = /^for\s+the\s+/i;

function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

function isAllCaps(s: string): boolean {
  const letters = s.replace(/[^A-Za-z]/g, '');
  return letters.length >= 2 && letters === letters.toUpperCase();
}

function isTitleCase(s: string): boolean {
  const ws = words(s).filter((w) => /[A-Za-z]/.test(w));
  if (ws.length === 0) return false;
  return ws.every((w) => /^[^a-zA-Z]*[A-Z]/.test(w));
}

/** Cleans 'For the dressing:' down to 'dressing'. */
function sectionName(line: string): string {
  return line
    .replace(/[:：]\s*$/, '')
    .replace(FOR_THE, '')
    .replace(/^for\s+/i, '')
    .trim();
}

/**
 * `next` is the next non-blank line in the block, or null at the end. Rule 3
 * needs it: a one-word Title Case line is only a header when something with a
 * quantity follows it.
 */
export function isSectionHeader(
  line: string,
  next: string | null,
  lex: HeaderLexicon,
): HeaderVerdict {
  const s = line.trim();
  if (!s) return NOT_HEADER;
  const key = normaliseKey(s).replace(/[:：.]+$/, '').trim();

  // Structural blocks and recipe metadata are always headers.
  if (STRUCTURAL.has(key) || META_LINE.test(s)) {
    return { isHeader: true, confidence: 0.95, rule: 1, section: sectionName(s) };
  }

  // Rule 1: ends with a colon, has no digits, six words or fewer.
  if (/[:：]\s*$/.test(s) && !/\d/.test(s) && words(s).length <= 6) {
    return { isHeader: true, confidence: 0.95, rule: 1, section: sectionName(s) };
  }

  // Rule 2: 'For the ...'
  if (FOR_THE.test(s)) {
    return { isHeader: true, confidence: 0.95, rule: 2, section: sectionName(s) };
  }

  // Rule 3: a short, capitalised, unmeasured, non-food line followed by a
  // measured one. Ambiguous by construction, so it is flagged for review.
  const hasQuantity = parseQuantityPrefix(s, { allowWordNumbers: false }) !== null;
  if (hasQuantity) return NOT_HEADER;
  if (/\d/.test(s)) return NOT_HEADER;

  const allCaps = isAllCaps(s);
  const short = words(s).length <= 3;
  if (!allCaps && !short) return NOT_HEADER;
  if (words(s).length > 6) return NOT_HEADER;
  if (!allCaps && !isTitleCase(s)) return NOT_HEADER;
  if (lex.isFood(key) || lex.isSeasoning(key)) return NOT_HEADER;
  if (next === null) return NOT_HEADER;
  if (parseQuantityPrefix(next.trim(), { allowWordNumbers: false }) === null) return NOT_HEADER;

  return { isHeader: true, confidence: 0.6, rule: 3, section: sectionName(s) };
}
