import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDatabase } from '@/db/testUtils';
import { placementRepo } from '@/db/repo';
import { deriveLeftoverLinks, usePlanStore } from './usePlanStore';
import { uuidv7 } from '@/domain/primitives';
import { SCHEMA_VERSION, makeSlotId, type Placement } from '@/domain/types';

function makePlacement(overrides: Partial<Placement> = {}): Placement {
  const date = overrides.date ?? '2026-08-03';
  const mealType = overrides.mealType ?? 'dinner';
  return {
    id: overrides.id ?? uuidv7(),
    kind: 'placement',
    spaceId: 'space-1',
    createdAt: new Date().toISOString(),
    updatedAt: '',
    lastWriterClientId: '',
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    date,
    mealType,
    slot: makeSlotId(date, mealType),
    position: 0,
    recipeId: null,
    recipeNameSnapshot: 'Chili',
    freeText: null,
    source: 'cook',
    leftoverOf: null,
    multiplier: 1,
    notes: null,
    ...overrides,
  };
}

describe('deriveLeftoverLinks (pure)', () => {
  it('marks a link broken when its source is missing (orphan), and still returns it', () => {
    const target = makePlacement({
      id: 'target-1',
      date: '2026-08-05',
      source: 'leftover',
      leftoverOf: 'missing-source-id',
    });

    const links = deriveLeftoverLinks([target]);

    expect(links).toHaveLength(1);
    expect(links[0]?.targetPlacementId).toBe('target-1');
    expect(links[0]?.broken).toBe(true);
  });

  it('marks a link broken when the source is scheduled after the target (inverted dates)', () => {
    const source = makePlacement({ id: 'source-1', date: '2026-08-10' });
    const target = makePlacement({
      id: 'target-1',
      date: '2026-08-05', // earlier than its own source
      source: 'leftover',
      leftoverOf: 'source-1',
    });

    const links = deriveLeftoverLinks([source, target]);

    expect(links).toHaveLength(1);
    expect(links[0]?.broken).toBe(true);
  });

  it('is not broken when the source exists and is on/before the target date', () => {
    const source = makePlacement({ id: 'source-1', date: '2026-08-03' });
    const target = makePlacement({
      id: 'target-1',
      date: '2026-08-05',
      source: 'leftover',
      leftoverOf: 'source-1',
    });

    const links = deriveLeftoverLinks([source, target]);

    expect(links[0]?.broken).toBe(false);
    expect(links[0]?.recipeName).toBe(source.recipeNameSnapshot);
  });

  it('ignores non-leftover placements entirely', () => {
    const cook = makePlacement({ id: 'cook-1', source: 'cook' });
    expect(deriveLeftoverLinks([cook])).toEqual([]);
  });

  it('a tombstoned source is indistinguishable from missing once excluded from the input', () => {
    // The store only ever hands deriveLeftoverLinks its live (non-deleted)
    // placements, so a tombstoned source is simply absent from the array —
    // this is the same code path as "missing" above; asserted here for
    // documentation/regression purposes.
    const target = makePlacement({
      id: 'target-1',
      date: '2026-08-05',
      source: 'leftover',
      leftoverOf: 'tombstoned-source-id',
    });
    const links = deriveLeftoverLinks([target]);
    expect(links[0]?.broken).toBe(true);
  });
});

describe('usePlanStore.remove cascades tombstones to leftover children', () => {
  beforeEach(() => resetTestDatabase());

  it('tombstones the cook placement and every leftover pointing at it, but leaves unrelated placements alone', async () => {
    const spaceId = 'space-1';
    const cook = await placementRepo.put(makePlacement({ spaceId, date: '2026-08-03', source: 'cook' }));
    const leftover1 = await placementRepo.put(
      makePlacement({ spaceId, date: '2026-08-04', source: 'leftover', leftoverOf: cook.id }),
    );
    const leftover2 = await placementRepo.put(
      makePlacement({ spaceId, date: '2026-08-05', source: 'leftover', leftoverOf: cook.id }),
    );
    const unrelated = await placementRepo.put(
      makePlacement({ spaceId, date: '2026-08-06', source: 'cook' }),
    );

    await usePlanStore.getState().load(spaceId, '2026-08-01', '2026-08-10');
    await usePlanStore.getState().remove(cook.id);

    const live = await placementRepo.getAll();
    expect(live.map((p) => p.id)).toEqual([unrelated.id]);

    const all = await placementRepo.getAll({ includeDeleted: true });
    const byId = new Map(all.map((p) => [p.id, p]));
    expect(byId.get(cook.id)?.deletedAt).not.toBeNull();
    expect(byId.get(leftover1.id)?.deletedAt).not.toBeNull();
    expect(byId.get(leftover2.id)?.deletedAt).not.toBeNull();
    expect(byId.get(unrelated.id)?.deletedAt).toBeNull();
  });

  it('cascades even to a leftover child outside the currently loaded in-memory range', async () => {
    const spaceId = 'space-1';
    const cook = await placementRepo.put(makePlacement({ spaceId, date: '2026-08-03', source: 'cook' }));
    // Child far outside the loaded window below.
    const farChild = await placementRepo.put(
      makePlacement({ spaceId, date: '2026-09-20', source: 'leftover', leftoverOf: cook.id }),
    );

    await usePlanStore.getState().load(spaceId, '2026-08-01', '2026-08-10');
    await usePlanStore.getState().remove(cook.id);

    const farChildAfter = await placementRepo.get(farChild.id);
    expect(farChildAfter?.deletedAt).not.toBeNull();
  });
});

describe('usePlanStore.setLeftovers', () => {
  beforeEach(() => resetTestDatabase());

  it('creates a live leftover link back to its source', async () => {
    const spaceId = 'space-1';
    const cook = await placementRepo.put(
      makePlacement({ spaceId, date: '2026-08-03', source: 'cook', recipeNameSnapshot: 'Chili' }),
    );

    await usePlanStore.getState().load(spaceId, '2026-08-01', '2026-08-10');
    const child = await usePlanStore.getState().setLeftovers(cook.id, '2026-08-04', 'lunch');

    expect(child?.source).toBe('leftover');
    expect(child?.leftoverOf).toBe(cook.id);

    const links = usePlanStore.getState().leftoverLinks();
    const link = links.find((l) => l.targetPlacementId === child?.id);
    expect(link?.broken).toBe(false);
    expect(link?.recipeName).toBe('Chili');
  });
});
