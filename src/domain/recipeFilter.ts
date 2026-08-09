/**
 * Pure tag filtering for the recipe library. Kept out of the store so it is
 * trivially unit-testable and reusable by any screen that wants to narrow a
 * recipe list by tag.
 */
import type { Recipe, RecipeTag } from './types';

const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;

/**
 * Fold text to a comparable form: decompose, strip accents, trim, lowercase.
 * Shared with the store's search so a chip and a typed query agree on what
 * counts as the same word.
 */
export function normalizeText(s: string): string {
  return s.normalize('NFKD').replace(COMBINING_MARKS_RE, '').trim().toLowerCase();
}

/**
 * Narrow `recipes` to those matching ANY of the selected tags (OR semantics —
 * each added tag widens the results). A recipe matches when it carries the tag
 * OR when its name contains the tag word: most libraries are largely untagged,
 * and without the name fallback every chip would be a dead end returning
 * nothing. Name matching ignores case and accents. An empty selection is a
 * no-op. Assumes `tags` is always an array (normalised on read — see
 * `getRecipesBySpace`).
 */
export function filterByTags(recipes: Recipe[], tags: RecipeTag[]): Recipe[] {
  if (tags.length === 0) return recipes;
  const needles = tags.map(normalizeText);
  return recipes.filter((r) => {
    if (r.tags.some((t) => tags.includes(t as RecipeTag))) return true;
    const name = normalizeText(r.name);
    return needles.some((n) => name.includes(n));
  });
}
