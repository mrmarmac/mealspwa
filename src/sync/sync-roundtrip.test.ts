import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemorySyncServer } from './testServer';
import { createSyncEngine } from './adapter';
import { RemoteAdapter } from './remote';
import { resetTestDatabase } from '@/db/testUtils';
import { getOutboxEntries, recipeRepo } from '@/db/repo';
import { resolve } from '@/domain/sync';
import { encodeHLC } from '@/domain/hlc';
import { SCHEMA_VERSION, type Recipe, type Syncable } from '@/domain/types';

const BASE = 'https://sync.test';
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function recipe(id: string, updatedAt: string, patch: Partial<Recipe> = {}): Recipe {
  return {
    id,
    kind: 'recipe',
    spaceId: 'space-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    lastWriterClientId: 'seed',
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

// -- A device modelled as an in-memory entity set that merges pulls via the
//    real `resolve()` (exactly what repo.applyRemote does), so this proves the
//    push/pull/server round-trip converges, independent of IndexedDB. --------

function syncDevice(
  server: InMemorySyncServer,
  token: string,
  local: Map<string, Syncable>,
): void {
  server.push('space-1', token, [...local.values()]);
  const pulled = server.pull('space-1', token, null).entities ?? [];
  for (const entity of pulled) {
    local.set(entity.id, resolve(local.get(entity.id), entity));
  }
}

describe('two-device convergence through the server', () => {
  const t1 = encodeHLC(1000, 0, 'seed');
  const t2 = encodeHLC(2000, 0, 'client-a');
  const t3 = encodeHLC(3000, 0, 'client-b');

  function run(order: Array<'a' | 'b'>): { a: Map<string, Syncable>; b: Map<string, Syncable> } {
    const server = new InMemorySyncServer();
    const a = new Map<string, Syncable>([
      ['r1', recipe('r1', t2, { name: 'A-name', lastWriterClientId: 'client-a' })],
      ['r2', recipe('r2', t1)],
    ]);
    const b = new Map<string, Syncable>([
      ['r1', recipe('r1', t3, { name: 'B-name', lastWriterClientId: 'client-b' })],
      ['r3', recipe('r3', t1)],
    ]);
    for (const who of order) syncDevice(server, 'shared-token', who === 'a' ? a : b);
    return { a, b };
  }

  it('both devices reach byte-identical state, and the causally-latest edit wins', () => {
    // Enough rounds for a full exchange, in different interleavings.
    const orders: Array<Array<'a' | 'b'>> = [
      ['a', 'b', 'a', 'b'],
      ['b', 'a', 'b', 'a'],
      ['a', 'a', 'b', 'a', 'b'],
    ];
    for (const order of orders) {
      const { a, b } = run(order);
      expect([...a.keys()].sort()).toEqual(['r1', 'r2', 'r3']);
      expect(a).toEqual(b);
      // r1: t3 (client-b) is the newest write, so it wins on both devices.
      expect((a.get('r1') as Recipe).name).toBe('B-name');
      expect(a.get('r1')!.updatedAt).toBe(t3);
    }
  });

  it('rejects a device presenting the wrong token', () => {
    const server = new InMemorySyncServer();
    server.push('space-1', 'right', [recipe('r1', t1)]);
    expect(server.push('space-1', 'wrong', [recipe('r2', t2)]).ok).toBe(false);
    expect(server.pull('space-1', 'wrong', null).ok).toBe(false);
    expect(server.snapshot('space-1').map((e) => e.id)).toEqual(['r1']);
  });
});

// -- The real engine + repos + RemoteAdapter, on one device's IndexedDB. -----

describe('engine + repo + RemoteAdapter against the fake server', () => {
  beforeEach(() => resetTestDatabase());

  it('pushes the outbox to the server and drains it, then merges a newer pull without re-queuing it', async () => {
    const server = new InMemorySyncServer();
    const restore = server.installFetch();
    try {
      const engine = createSyncEngine({ adapter: new RemoteAdapter(BASE, 'tok') });

      // Local write goes to the outbox.
      await recipeRepo.put(recipe('r1', '', { name: 'Local' }));
      expect((await getOutboxEntries()).length).toBe(1);

      // Push drains the outbox; the server now holds the recipe.
      await engine.pushPending('space-1');
      expect((await getOutboxEntries()).length).toBe(0);
      expect(server.snapshot('space-1').map((e) => e.id)).toEqual(['r1']);

      // The other device writes a strictly-newer version of the same recipe.
      const newer = recipe('r1', encodeHLC(9_999_999_999_999, 0, 'client-b'), {
        name: 'Remote wins',
        lastWriterClientId: 'client-b',
      });
      server.push('space-1', 'tok', [newer]);

      // Pull merges it in — and must NOT re-queue it to the outbox.
      const { pulledCount } = await engine.pullSince('space-1');
      expect(pulledCount).toBe(1);
      expect((await recipeRepo.get('r1'))?.name).toBe('Remote wins');
      expect((await getOutboxEntries()).length).toBe(0);
    } finally {
      restore();
    }
  });
});
