/**
 * Pure tag filtering for the recipe library. Kept out of the store so it is
 * trivially unit-testable and reusable by any screen that wants to narrow a
 * recipe list by tag.
 */
import type { Recipe, RecipeTag } from './types';

/**
 * Narrow `recipes` to those carrying EVERY selected tag (AND semantics — each
 * added tag tightens the filter). An empty selection is a no-op. Legacy rows
 * predating the `tags` field (where `tags` may be `undefined`) are treated as
 * having no tags.
 */
export function filterByTags(recipes: Recipe[], tags: RecipeTag[]): Recipe[] {
  if (tags.length === 0) return recipes;
  return recipes.filter((r) => {
    const recipeTags = r.tags ?? [];
    return tags.every((t) => recipeTags.includes(t));
  });
}
