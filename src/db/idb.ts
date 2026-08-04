/**
 * The IndexedDB schema. This is the only file that should call `openDB` — every
 * other module reaches storage through `src/db/repo.ts`.
 *
 * Versioning: bump `DB_VERSION` and add a new `if (oldVersion < N)` block to
 * `upgrade()` for any future schema change. Never mutate an existing block —
 * a device that already ran it must not run it again, and a device jumping
 * straight from v1 to v3 must still pick up everything.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  EntityKind,
  ItemMeta,
  ManualItem,
  PackSizeMemory,
  Placement,
  Recipe,
  ShoppingSession,
  ShoppingTick,
  Space,
} from '@/domain/types';
import type { HLC, Id, ISODate } from '@/domain/primitives';

export const DB_NAME = 'mealspwa';
export const DB_VERSION = 1;

/** An immutable content-addressed blob (recipe photos). Never synced — v1
 *  export/import and the sync engine both skip this store entirely. */
export interface BlobRecord {
  sha256: string;
  mime: string;
  bytes: ArrayBuffer;
  createdAt: string;
}

/** One row per entity id that has local changes not yet confirmed pushed.
 *  `kind` says which store to re-read the live entity from at push time. */
export interface OutboxEntry {
  id: Id;
  kind: EntityKind;
  updatedAt: HLC;
}

/** Arbitrary small facts that aren't per-space sync data: this device's
 *  clientId, the HLC's persisted state, the sync cursor, which space is
 *  active, and one-shot flags like "seed has run". Each row is keyed by a
 *  well-known string; `value` is whatever shape that key uses. */
export interface MetaRow<T = unknown> {
  key: string;
  value: T;
}

export interface MealsDBSchema extends DBSchema {
  spaces: {
    key: Id;
    value: Space;
  };
  recipes: {
    key: Id;
    value: Recipe;
    indexes: {
      spaceId: Id;
      name: string;
      updatedAt: HLC;
    };
  };
  placements: {
    key: Id;
    value: Placement;
    indexes: {
      'by-space-date': [Id, ISODate];
      slot: string;
      recipeId: Id;
      leftoverOf: Id;
      updatedAt: HLC;
    };
  };
  shoppingSessions: {
    key: Id;
    value: ShoppingSession;
    indexes: {
      'by-space-status': [Id, string];
    };
  };
  shoppingTicks: {
    key: Id;
    value: ShoppingTick;
    indexes: {
      sessionId: Id;
    };
  };
  manualItems: {
    key: Id;
    value: ManualItem;
    indexes: {
      sessionId: Id;
    };
  };
  itemMeta: {
    key: Id;
    value: ItemMeta;
    indexes: {
      spaceId: Id;
    };
  };
  packSizes: {
    key: Id;
    value: PackSizeMemory;
    indexes: {
      spaceId: Id;
    };
  };
  blobs: {
    key: string;
    value: BlobRecord;
  };
  outbox: {
    key: Id;
    value: OutboxEntry;
    indexes: {
      updatedAt: HLC;
    };
  };
  meta: {
    key: string;
    value: MetaRow;
  };
}

function upgradeToV1(db: IDBPDatabase<MealsDBSchema>): void {
  db.createObjectStore('spaces', { keyPath: 'id' });

  const recipes = db.createObjectStore('recipes', { keyPath: 'id' });
  recipes.createIndex('spaceId', 'spaceId');
  recipes.createIndex('name', 'name');
  recipes.createIndex('updatedAt', 'updatedAt');

  const placements = db.createObjectStore('placements', { keyPath: 'id' });
  placements.createIndex('by-space-date', ['spaceId', 'date']);
  placements.createIndex('slot', 'slot');
  placements.createIndex('recipeId', 'recipeId');
  placements.createIndex('leftoverOf', 'leftoverOf');
  placements.createIndex('updatedAt', 'updatedAt');

  const shoppingSessions = db.createObjectStore('shoppingSessions', { keyPath: 'id' });
  shoppingSessions.createIndex('by-space-status', ['spaceId', 'status']);

  const shoppingTicks = db.createObjectStore('shoppingTicks', { keyPath: 'id' });
  shoppingTicks.createIndex('sessionId', 'sessionId');

  const manualItems = db.createObjectStore('manualItems', { keyPath: 'id' });
  manualItems.createIndex('sessionId', 'sessionId');

  const itemMeta = db.createObjectStore('itemMeta', { keyPath: 'id' });
  itemMeta.createIndex('spaceId', 'spaceId');

  const packSizes = db.createObjectStore('packSizes', { keyPath: 'id' });
  packSizes.createIndex('spaceId', 'spaceId');

  db.createObjectStore('blobs', { keyPath: 'sha256' });

  const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
  outbox.createIndex('updatedAt', 'updatedAt');

  db.createObjectStore('meta', { keyPath: 'key' });
}

let dbPromise: Promise<IDBPDatabase<MealsDBSchema>> | null = null;

export function getDB(): Promise<IDBPDatabase<MealsDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<MealsDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // Additive: each block only ever runs for a device crossing that
        // version boundary, and every later block still runs on top of it.
        if (oldVersion < 1) {
          upgradeToV1(db);
        }
      },
    });
  }
  return dbPromise;
}

/** Test-only: drop the cached connection so a fresh `getDB()` reopens against
 *  whatever fake-indexeddb instance the test just installed. */
export function _resetDBConnectionForTests(): void {
  dbPromise = null;
}
