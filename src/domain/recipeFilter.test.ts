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
  const soupDinner = makeRecipe('soupDinner', ['soup', 'dinner']);
  const sweet = makeRecipe('sweet', ['sweet']);
  const untagged = makeRecipe('untagged', []);
  const all = [soupDinner, sweet, untagged];

  it('returns everything when no tags are selected', () => {
    expect(filterByTags(all, [])).toEqual(all);
  });

  it('matches a single tag', () => {
    expect(filterByTags(all, ['soup'])).toEqual([soupDinner]);
    expect(filterByTags(all, ['sweet'])).toEqual([sweet]);
  });

  it('matches ANY selected tag (OR semantics)', () => {
    // soup OR sweet -> both the soup recipe and the sweet one.
    expect(filterByTags(all, ['soup', 'sweet'] as RecipeTag[])).toEqual([soupDinner, sweet]);
    // dinner OR sweet -> the soup+dinner recipe (has dinner) and the sweet one.
    expect(filterByTags(all, ['dinner', 'sweet'] as RecipeTag[])).toEqual([soupDinner, sweet]);
  });

  it('excludes recipes with no matching tag', () => {
    expect(filterByTags(all, ['lunch'])).toEqual([]);
    expect(filterByTags([untagged], ['soup'])).toEqual([]);
  });
});
