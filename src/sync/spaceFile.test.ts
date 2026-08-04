import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDatabase } from '@/db/testUtils';
import { recipeRepo, spaceRepo } from '@/db/repo';
import { exportSpace, importSpaceFile } from './spaceFile';
import { uuidv7 } from '@/domain/primitives';
import { DEFAULT_SETTINGS, SCHEMA_VERSION, type Recipe, type Space } from '@/domain/types';

function makeSpace(id: string): Space {
  return {
    id,
    kind: 'space',
    spaceId: id,
    createdAt: new Date().toISOString(),
    updatedAt: '',
    lastWriterClientId: '',
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    name: 'Export test kitchen',
    settings: DEFAULT_SETTINGS,
  };
}

function makeRecipe(spaceId: string, overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: uuidv7(),
    kind: 'recipe',
    spaceId,
    createdAt: new Date().toISOString(),
    updatedAt: '',
    lastWriterClientId: '',
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    name: 'Recipe',
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
    tags: [],
    timesPlanned: 0,
    lastPlannedOn: null,
    archived: false,
    ...overrides,
  };
}

describe('spaceFile export/import', () => {
  beforeEach(() => resetTestDatabase());

  it('formatVersion 1, blobs excluded, entities belong to the space', async () => {
    const spaceId = uuidv7();
    await spaceRepo.put(makeSpace(spaceId));
    await recipeRepo.put(makeRecipe(spaceId, { name: 'Soup' }));

    const file = await exportSpace(spaceId);
    expect(file.formatVersion).toBe(1);
    expect(file.spaceId).toBe(spaceId);
    expect(file.entities.every((e) => e.spaceId === spaceId)).toBe(true);
    // No 'blobs' kind ever appears — blobs are excluded from v1 export.
    expect(file.entities.every((e) => e.kind !== ('blob' as never))).toBe(true);
  });

  it('export -> import into an empty DB reproduces the space', async () => {
    const spaceId = uuidv7();
    await spaceRepo.put(makeSpace(spaceId));
    await recipeRepo.put(makeRecipe(spaceId, { name: 'Soup' }));
    await recipeRepo.put(makeRecipe(spaceId, { name: 'Salad' }));

    const file = await exportSpace(spaceId);
    expect(file.entities.length).toBeGreaterThanOrEqual(3); // space + 2 recipes

    resetTestDatabase(); // fresh, empty "device"

    const result = await importSpaceFile(file);
    expect(result.applied).toBe(file.entities.length);
    expect(result.skipped).toBe(0);

    const importedSpace = await spaceRepo.get(spaceId);
    expect(importedSpace?.name).toBe('Export test kitchen');

    const importedRecipes = await recipeRepo.getAll();
    expect(importedRecipes.map((r) => r.name).sort()).toEqual(['Salad', 'Soup']);
  });

  it('importing a stale export does not clobber a newer local edit', async () => {
    const spaceId = uuidv7();
    await spaceRepo.put(makeSpace(spaceId));
    const recipe = await recipeRepo.put(makeRecipe(spaceId, { name: 'Original' }));

    const staleFile = await exportSpace(spaceId); // snapshot BEFORE the newer edit

    // A newer local edit happens after the snapshot was taken.
    await recipeRepo.put({ ...recipe, name: 'Updated locally' });

    const result = await importSpaceFile(staleFile);
    expect(result.skipped).toBeGreaterThan(0);

    const current = await recipeRepo.get(recipe.id);
    expect(current?.name).toBe('Updated locally');
  });

  it('importing observes incoming timestamps so a later local write still sorts after the import', async () => {
    const spaceId = uuidv7();
    await spaceRepo.put(makeSpace(spaceId));
    const recipe = await recipeRepo.put(makeRecipe(spaceId, { name: 'Original' }));
    const file = await exportSpace(spaceId);

    resetTestDatabase(); // fresh device, clock starts from zero

    await importSpaceFile(file);
    const afterImport = await recipeRepo.get(recipe.id);
    expect(afterImport?.updatedAt).toBe(recipe.updatedAt);

    const localEdit = await recipeRepo.put({ ...(afterImport as Recipe), name: 'Local after import' });
    expect(localEdit.updatedAt > recipe.updatedAt).toBe(true);
  });

  it('rejects an unsupported formatVersion', async () => {
    const spaceId = uuidv7();
    await expect(
      importSpaceFile({
        // @ts-expect-error deliberately wrong formatVersion for the test
        formatVersion: 2,
        exportedAt: new Date().toISOString(),
        spaceId,
        entities: [],
      }),
    ).rejects.toThrow();
  });
});
