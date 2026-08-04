/**
 * Pure tag filtering for the recipe library. Kept out of the store so it is
 * trivially unit-testable and reusable by any screen that wants to narrow a
 * recipe list by tag.
 */
import type { Recipe, RecipeTag } from './types';

/**
 * Narrow `recipes` to those carrying ANY of the selected tags (OR semantics —
 * each added tag widens the results). An empty selection is a no-op. Assumes
 * `tags` is always an array (normalised on read — see `getRecipesBySpace`).
 */
export function filterByTags(recipes: Recipe[], tags: RecipeTag[]): Recipe[] {
  if (tags.length === 0) return recipes;
  return recipes.filter((r) => r.tags.some((t) => tags.includes(t as RecipeTag)));
}
