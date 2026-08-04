/**
 * Confidence scoring. The number itself is less important than what it drives:
 * anything below 0.55 is surfaced for review rather than silently trusted, so
 * the user finds out the parser was unsure BEFORE they are stood in the shop.
 */

export type ConfidenceBand = 'high' | 'medium' | 'low';

export interface ScoreInput {
  /** A named pattern (zest/juice, handful-of) or a seasoning phrase matched. */
  namedPattern: boolean;
  /** The head noun is in the food lexicon. */
  knownFood: boolean;
  hasQuantity: boolean;
  /** to-taste / to-serve / pantry-staple: a missing quantity is fine here. */
  toTasteOrStaple: boolean;
  /** A quantity was read but the token after it was not a unit we know. */
  unrecognisedUnit: boolean;
  /** Nothing structural matched; the whole line became the item. */
  unstructuredFallback: boolean;
  itemTokenCount: number;
  /** The item text still contains a digit or a verb-like token. */
  itemHasDigitOrVerb: boolean;
  /** Classified as a header by the ambiguous rule 3. */
  ambiguousHeader: boolean;
  /**
   * The head noun is not in the food lexicon. The mirror of `knownFood`: if we
   * cannot name the thing, we should not pretend we parsed it. This is what
   * pushes 'Your favorite crusty breast, to serve' below the review threshold.
   */
  unknownHeadNoun: boolean;
}

export interface Score {
  confidence: number;
  reasons: string[];
}

const RULES: {
  key: keyof ScoreInput | 'noQuantity' | 'longItem';
  delta: number;
  reason: string;
}[] = [
  { key: 'namedPattern', delta: 0.1, reason: 'named pattern matched' },
  { key: 'knownFood', delta: 0.1, reason: 'head noun in food lexicon' },
  { key: 'noQuantity', delta: -0.35, reason: 'no quantity and not a to-taste/staple line' },
  { key: 'unrecognisedUnit', delta: -0.15, reason: 'quantity present but unit unrecognised' },
  { key: 'unstructuredFallback', delta: -0.4, reason: 'unstructured fallback' },
  { key: 'longItem', delta: -0.1, reason: 'item longer than 5 tokens' },
  { key: 'itemHasDigitOrVerb', delta: -0.15, reason: 'item contains a digit or verb-like token' },
  { key: 'ambiguousHeader', delta: -0.3, reason: 'ambiguous header (rule 3)' },
  { key: 'unknownHeadNoun', delta: -0.2, reason: 'head noun not in food lexicon' },
];

export function scoreParse(input: ScoreInput): Score {
  let c = 1;
  const reasons: string[] = [];
  const flags: Record<string, boolean> = {
    ...(input as unknown as Record<string, boolean>),
    noQuantity: !input.hasQuantity && !input.toTasteOrStaple,
    longItem: input.itemTokenCount > 5,
  };
  for (const rule of RULES) {
    if (flags[rule.key]) {
      c += rule.delta;
      reasons.push(`${rule.delta > 0 ? '+' : ''}${rule.delta.toFixed(2)} ${rule.reason}`);
    }
  }
  return { confidence: clamp(c), reasons };
}

export function clamp(v: number): number {
  return Math.max(0, Math.min(1, Number(v.toFixed(4))));
}

export function band(confidence: number): ConfidenceBand {
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.55) return 'medium';
  return 'low';
}

/** Verb-like tokens that should never be part of a thing you buy. */
const VERBISH =
  /\b(add|stir|heat|cook|bake|preheat|serve|simmer|boil|pour|season|remove|place|drain|whisk|combine|transfer|repeat|squeeze|prepare|leave|toss|spread)\b/i;

export function looksVerbLike(item: string): boolean {
  return /\d/.test(item) || VERBISH.test(item);
}
