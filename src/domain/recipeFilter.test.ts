import { describe, expect, it } from 'vitest';
import { filterByTags } from './recipeFilter';
import type { Recipe, RecipeTag } from './types';

function makeRecipe(id: string, tags: string[] | undefined): Recipe {
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
    // Intentionally allow undefined to model legacy rows predating `tags`.
    tags: tags as string[],
    timesPlanned: 0,
    lastPlannedOn: null,
    archived: false,
  };
}

describe('filterByTags', () => {
  const soupDinner = makeRecipe('soupDinner', ['soup', 'dinner']);
  const sweet = makeRecipe('sweet', ['sweet']);
  const untagged = makeRecipe('untagged', []);
  const legacy = makeRecipe('legacy', undefined);
  const all = [soupDinner, sweet, untagged, legacy];

  it('returns everything when no tags are selected', () => {
    expect(filterByTags(all, [])).toEqual(all);
  });

  it('matches a single tag', () => {
    expect(filterByTags(all, ['soup'])).toEqual([soupDinner]);
    expect(filterByTags(all, ['sweet'])).toEqual([sweet]);
  });

  it('requires ALL selected tags (AND semantics)', () => {
    expect(filterByTags(all, ['soup', 'dinner'])).toEqual([soupDinner]);
    expect(filterByTags(all, ['soup', 'sweet'] as RecipeTag[])).toEqual([]);
  });

  it('treats a recipe with undefined tags as untagged (no crash)', () => {
    expect(filterByTags([legacy], ['soup'])).toEqual([]);
    expect(filterByTags([legacy], [])).toEqual([legacy]);
  });
});
