/**
 * Shared test-only setup for anything touching IndexedDB. Not a test file
 * itself (vitest only picks up `*.test.ts`), so it's safe to import from
 * suites under `src/db`, `src/sync`, and `src/store`.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { _resetDBConnectionForTests } from './idb';
import { _resetClockForTests } from './clock';

/** Swap in a brand-new, empty fake IndexedDB factory and forget the cached
 *  `getDB()`/clock singletons, so each test starts from a clean database
 *  instead of accumulating state across the file (or leaking a stale
 *  cached connection from a previous test's factory instance). */
export function resetTestDatabase(): void {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  _resetDBConnectionForTests();
  _resetClockForTests();
}
