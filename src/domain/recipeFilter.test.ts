import { describe, expect, it } from 'vitest';
import { filterByTags } from './recipeFilter';
import type { Recipe, RecipeTag } from './types';

function makeRecipe(id: string, tags: string[]): Recipe {
  return {
    id,
    kind: 'recipe',
    spaceId: 's1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '000-0-a',
    lastWriterClientId: 'a',
    deletedAt: null,
    schemaVersion: 1,
    name: id,
    sourceUrl: null,
    sourceDomain: null,
    photo: null,
    ingredientsRaw: '',
    method: null,
    baseServings: null,
    ingredients: [],
    parserVersion: 1,
    overrides: [],
    dialect: null,
    tags,
    timesPlanned: 0,
    lastPlannedOn: null,
    archived: false,
  };
}

describe('filterByTags', () => {
  const soupPasta = makeRecipe('soupPasta', ['soup', 'pasta']);
  const bake = makeRecipe('bake', ['bake']);
  const untagged = makeRecipe('untagged', []);
  const all = [soupPasta, bake, untagged];

  it('returns everything when no tags are selected', () => {
    expect(filterByTags(all, [])).toEqual(all);
  });

  it('matches a single tag', () => {
    expect(filterByTags(all, ['soup'])).toEqual([soupPasta]);
    expect(filterByTags(all, ['bake'])).toEqual([bake]);
  });

  it('matches ANY selected tag (OR semantics)', () => {
    // soup OR bake -> both the soup recipe and the bake one.
    expect(filterByTags(all, ['soup', 'bake'] as RecipeTag[])).toEqual([soupPasta, bake]);
    // pasta OR bake -> the soup+pasta recipe (has pasta) and the bake one.
    expect(filterByTags(all, ['pasta', 'bake'] as RecipeTag[])).toEqual([soupPasta, bake]);
  });

  it('excludes recipes with no matching tag', () => {
    expect(filterByTags(all, ['easy'])).toEqual([]);
    expect(filterByTags([untagged], ['soup'])).toEqual([]);
  });
});
