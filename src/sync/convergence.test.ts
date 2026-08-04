import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDatabase } from '@/db/testUtils';
import { recipeRepo } from '@/db/repo';
import { encodeHLC } from '@/domain/hlc';
import { uuidv7 } from '@/domain/primitives';
import { SCHEMA_VERSION, type Recipe } from '@/domain/types';

function baseRecipe(id: string, updatedAt: string, patch: Partial<Recipe> = {}): Recipe {
  return {
    id,
    kind: 'recipe',
    spaceId: 'space-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    lastWriterClientId: 'seed-client',
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    name: 'Original',
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
    ...patch,
  };
}

describe('LWW convergence through repo.applyRemote', () => {
  beforeEach(() => resetTestDatabase());

  it('converges to the same state regardless of packet application order, and a newer edit beats an older delete', async () => {
    const id = uuidv7();
    const t1 = encodeHLC(1_000, 0, 'seed-client');
    const t5 = encodeHLC(5_000, 0, 'client-a'); // delete, OLDER
    const t7 = encodeHLC(7_000, 0, 'client-b'); // rename, NEWER

    const base = baseRecipe(id, t1);
    const deleteVersion: Recipe = { ...base, updatedAt: t5, deletedAt: t5, lastWriterClientId: 'client-a' };
    const renameVersion: Recipe = {
      ...base,
      updatedAt: t7,
      name: 'Renamed',
      lastWriterClientId: 'client-b',
    };

    // Order 1: base, then delete, then rename.
    await recipeRepo.applyRemote(base);
    await recipeRepo.applyRemote(deleteVersion);
    await recipeRepo.applyRemote(renameVersion);
    const result1 = await recipeRepo.get(id);

    resetTestDatabase();

    // Order 2: base, then rename, then delete (packets swapped).
    await recipeRepo.applyRemote(base);
    await recipeRepo.applyRemote(renameVersion);
    await recipeRepo.applyRemote(deleteVersion);
    const result2 = await recipeRepo.get(id);

    expect(result1).toEqual(result2);
    // The newer edit (rename, t7) beats the older delete (t5): entity lives.
    expect(result1?.name).toBe('Renamed');
    expect(result1?.deletedAt).toBeNull();
  });

  it('interleaved writes from two clients converge to the same state under any application order', async () => {
    const id = uuidv7();
    const t1 = encodeHLC(1_000, 0, 'seed-client');
    const t2 = encodeHLC(2_000, 0, 'client-a');
    const t3 = encodeHLC(3_000, 0, 'client-b');
    const t4 = encodeHLC(4_000, 0, 'client-a');

    const base = baseRecipe(id, t1);
    const v2: Recipe = { ...base, updatedAt: t2, tags: ['a'], lastWriterClientId: 'client-a' };
    const v3: Recipe = { ...base, updatedAt: t3, tags: ['b'], lastWriterClientId: 'client-b' };
    const v4: Recipe = { ...base, updatedAt: t4, tags: ['a', 'c'], lastWriterClientId: 'client-a' };

    const orders: Recipe[][] = [
      [base, v2, v3, v4],
      [v4, v3, v2, base],
      [v3, base, v4, v2],
      [v2, v4, base, v3],
    ];

    const results: Array<Recipe | undefined> = [];
    for (const order of orders) {
      resetTestDatabase();
      for (const entity of order) {
        await recipeRepo.applyRemote(entity);
      }
      results.push(await recipeRepo.get(id));
    }

    for (const r of results) {
      expect(r).toEqual(results[0]);
    }
    // t4 is the causally-latest write (highest HLC) — it must win everywhere.
    expect(results[0]?.tags).toEqual(['a', 'c']);
    expect(results[0]?.updatedAt).toBe(t4);
  });
});
