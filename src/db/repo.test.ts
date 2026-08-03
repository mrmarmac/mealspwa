import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDatabase } from './testUtils';
import {
  getManualItemsBySession,
  getOutboxEntries,
  getPlacementsInRange,
  getTicksBySession,
  manualItemRepo,
  placementRepo,
  recipeRepo,
  shoppingTickRepo,
} from './repo';
import { itemMetaId, tickId } from '@/domain/sync';
import { uuidv7 } from '@/domain/primitives';
import {
  SCHEMA_VERSION,
  makeSlotId,
  type ManualItem,
  type ParsedIngredientLine,
  type Placement,
  type Recipe,
  type ShoppingTick,
} from '@/domain/types';

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: uuidv7(),
    kind: 'recipe',
    spaceId: 'space-1',
    createdAt: new Date().toISOString(),
    updatedAt: '',
    lastWriterClientId: '',
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    name: 'Test recipe',
    sourceUrl: null,
    sourceDomain: null,
    photo: null,
    ingredientsRaw: '1 onion',
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

function makePlacement(overrides: Partial<Placement> = {}): Placement {
  const date = overrides.date ?? '2026-08-03';
  const mealType = overrides.mealType ?? 'dinner';
  return {
    id: uuidv7(),
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

describe('repo round-trip', () => {
  beforeEach(() => resetTestDatabase());

  it('put -> get -> tombstone -> excluded from getAll but present with includeDeleted', async () => {
    const draft = makeRecipe();
    const saved = await recipeRepo.put(draft);
    expect(saved.updatedAt).not.toBe('');
    expect(saved.lastWriterClientId).not.toBe('');

    const fetched = await recipeRepo.get(saved.id);
    expect(fetched?.name).toBe('Test recipe');

    await recipeRepo.remove(saved.id);

    const liveList = await recipeRepo.getAll();
    expect(liveList.find((r) => r.id === saved.id)).toBeUndefined();

    const allList = await recipeRepo.getAll({ includeDeleted: true });
    const tombstoned = allList.find((r) => r.id === saved.id);
    expect(tombstoned).toBeDefined();
    expect(tombstoned?.deletedAt).not.toBeNull();
  });

  it('remove() on a non-existent id is a no-op', async () => {
    await expect(recipeRepo.remove(uuidv7())).resolves.toBeUndefined();
  });
});

describe('outbox', () => {
  beforeEach(() => resetTestDatabase());

  it('a write enqueues exactly one id', async () => {
    const saved = await recipeRepo.put(makeRecipe());
    const entries = await getOutboxEntries();
    expect(entries.filter((e) => e.id === saved.id)).toHaveLength(1);
  });

  it('a second write to the same entity still leaves exactly one outbox row for it', async () => {
    const saved = await recipeRepo.put(makeRecipe());
    await recipeRepo.put({ ...saved, name: 'Renamed' });
    const entries = await getOutboxEntries();
    expect(entries.filter((e) => e.id === saved.id)).toHaveLength(1);
  });

  it('applyRemote does not enqueue', async () => {
    const draft = makeRecipe();
    const applied = await recipeRepo.applyRemote({
      ...draft,
      updatedAt: '000000000000001-0000-remote-client',
      lastWriterClientId: 'remote-client',
    });
    expect(applied).toBe(true);
    const entries = await getOutboxEntries();
    expect(entries.filter((e) => e.id === draft.id)).toHaveLength(0);
  });

  it('remove() enqueues the tombstone write', async () => {
    const saved = await recipeRepo.put(makeRecipe());
    const db = await import('./idb');
    // Drain the outbox from the initial put so we isolate remove()'s enqueue.
    const dbHandle = await db.getDB();
    const tx = dbHandle.transaction('outbox', 'readwrite');
    await tx.objectStore('outbox').delete(saved.id);
    await tx.done;

    await recipeRepo.remove(saved.id);
    const entries = await getOutboxEntries();
    expect(entries.filter((e) => e.id === saved.id)).toHaveLength(1);
  });
});

describe('byIndex helpers', () => {
  beforeEach(() => resetTestDatabase());

  it('getPlacementsInRange scopes by space and an inclusive date range', async () => {
    const inRange = await placementRepo.put(makePlacement({ spaceId: 'space-1', date: '2026-08-05' }));
    await placementRepo.put(makePlacement({ spaceId: 'space-1', date: '2026-08-20' })); // out of range
    await placementRepo.put(makePlacement({ spaceId: 'space-2', date: '2026-08-05' })); // other space

    const results = await getPlacementsInRange('space-1', '2026-08-01', '2026-08-10');
    expect(results.map((p) => p.id)).toEqual([inRange.id]);
  });

  it('getTicksBySession returns only ticks for that session', async () => {
    const parsedStub: ParsedIngredientLine = {
      lineKey: 'l1',
      rawText: '1 onion',
      isHeader: false,
      section: null,
      quantity: null,
      unit: null,
      unitKind: 'none',
      packSize: null,
      item: 'onion',
      itemKey: 'onion',
      itemAliases: [],
      clarifier: null,
      note: null,
      qualifiers: [],
      alternates: [],
      confidence: 1,
      confidenceReasons: [],
      parserVersion: 1,
      overridden: false,
      excluded: false,
    };
    void parsedStub; // silence unused in case not needed below

    const sessionA = 'session-a';
    const sessionB = 'session-b';
    const tickA: ShoppingTick = {
      id: tickId(sessionA, 'onion'),
      kind: 'shoppingTick',
      spaceId: 'space-1',
      createdAt: new Date().toISOString(),
      updatedAt: '',
      lastWriterClientId: '',
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
      sessionId: sessionA,
      lineKey: 'onion',
      ticked: true,
      tickedAt: new Date().toISOString(),
      quantityAtTick: null,
      unitAtTick: null,
      displayNameAtTick: 'Onion',
      displayQuantityAtTick: '1',
    };
    const tickB: ShoppingTick = { ...tickA, id: tickId(sessionB, 'onion'), sessionId: sessionB };

    await shoppingTickRepo.put(tickA);
    await shoppingTickRepo.put(tickB);

    const results = await getTicksBySession(sessionA);
    expect(results.map((t) => t.id)).toEqual([tickA.id]);
  });

  it('getManualItemsBySession(null) returns only standing items', async () => {
    const parsed: ParsedIngredientLine = {
      lineKey: 'l1',
      rawText: 'milk',
      isHeader: false,
      section: null,
      quantity: null,
      unit: null,
      unitKind: 'none',
      packSize: null,
      item: 'milk',
      itemKey: 'milk',
      itemAliases: [],
      clarifier: null,
      note: null,
      qualifiers: [],
      alternates: [],
      confidence: 1,
      confidenceReasons: [],
      parserVersion: 1,
      overridden: false,
      excluded: false,
    };
    const standing: ManualItem = {
      id: uuidv7(),
      kind: 'manualItem',
      spaceId: 'space-1',
      createdAt: new Date().toISOString(),
      updatedAt: '',
      lastWriterClientId: '',
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
      sessionId: null,
      rawText: 'milk',
      parsed,
      lineKey: 'milk',
    };
    const scoped: ManualItem = { ...standing, id: uuidv7(), sessionId: 'session-a' };

    await manualItemRepo.put(standing);
    await manualItemRepo.put(scoped);

    const results = await getManualItemsBySession(null);
    expect(results.map((m) => m.id)).toEqual([standing.id]);
  });

  it('itemMetaId helper produces the documented deterministic id', () => {
    expect(itemMetaId('onion')).toBe('item:onion');
  });
});
