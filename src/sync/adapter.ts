/**
 * The sync engine: adapter-agnostic push/pull orchestration on top of the
 * repos and the shared clock. `domain/sync.ts` owns the `SyncAdapter`
 * contract and `resolve()`; this file is the seam that drives them.
 */
import { ensureClock } from '@/db/clock';
import {
  applyRemoteEntity,
  getMeta,
  getOutboxEntities,
  getOutboxEntries,
  removeOutboxEntries,
  repos as defaultRepos,
  setMeta,
  type Repos,
} from '@/db/repo';
import type { HLC, Id } from '@/domain/primitives';
import type { Syncable } from '@/domain/types';
import type { SyncAdapter, SyncCursor, SyncPacket } from '@/domain/sync';

export type { SyncAdapter, SyncPacket, SyncCursor } from '@/domain/sync';

const SYNC_CURSOR_META_KEY = 'syncCursor';

export interface SyncEngineOptions {
  adapter: SyncAdapter;
  /** Defaults to the app-wide singleton repos; tests pass their own. */
  repos?: Repos;
}

export interface SyncStatus {
  adapterName: string;
  isRemote: boolean;
  pendingCount: number;
  lastPushOkAt: string | null;
  lastPullOkAt: string | null;
}

export interface SyncEngine {
  /** Push every locally-dirty entity for `spaceId`; drains accepted ids from
   *  the outbox. */
  pushPending(spaceId: Id): Promise<{ pushedIds: Id[] }>;
  /** Pull everything for `spaceId` since the last successful pull and merge
   *  it in via `applyPacket`. */
  pullSince(spaceId: Id): Promise<{ pulledCount: number }>;
  /** Observe every incoming timestamp, then merge each entity through its
   *  repo's `applyRemote` (never touching the outbox). */
  applyPacket(packet: SyncPacket): Promise<void>;
  status(): Promise<SyncStatus>;
}

async function loadCursor(): Promise<SyncCursor> {
  const clock = await ensureClock();
  const existing = await getMeta<SyncCursor>(SYNC_CURSOR_META_KEY);
  if (existing) return existing;
  return {
    clientId: clock.clientId,
    lastPulledHlc: null,
    dirtyIds: [],
    lastPushOkAt: null,
    lastPullOkAt: null,
  };
}

async function saveCursor(cursor: SyncCursor): Promise<void> {
  await setMeta(SYNC_CURSOR_META_KEY, cursor);
}

async function applyPacketWith(target: Repos, packet: SyncPacket): Promise<void> {
  if (packet.entities.length === 0) return;
  const clock = await ensureClock();
  for (const entity of packet.entities) {
    clock.observe(entity.updatedAt);
  }
  await Promise.all(packet.entities.map((entity: Syncable) => applyRemoteEntity(target, entity)));
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { adapter } = options;
  const target = options.repos ?? defaultRepos;

  return {
    async pushPending(spaceId) {
      const entities = await getOutboxEntities(target);
      const scoped = entities.filter((e) => e.spaceId === spaceId);
      if (scoped.length === 0) return { pushedIds: [] };

      const accepted = await adapter.push(spaceId, scoped);
      await removeOutboxEntries(accepted);

      const cursor = await loadCursor();
      cursor.lastPushOkAt = new Date().toISOString();
      await saveCursor(cursor);

      return { pushedIds: accepted };
    },

    async pullSince(spaceId) {
      const cursor = await loadCursor();
      const packet = await adapter.pull(spaceId, cursor.lastPulledHlc);
      await applyPacketWith(target, packet);

      let newest: HLC | null = cursor.lastPulledHlc;
      for (const entity of packet.entities) {
        if (newest === null || entity.updatedAt > newest) newest = entity.updatedAt;
      }
      cursor.lastPulledHlc = newest;
      cursor.lastPullOkAt = new Date().toISOString();
      await saveCursor(cursor);

      return { pulledCount: packet.entities.length };
    },

    async applyPacket(packet) {
      await applyPacketWith(target, packet);
    },

    async status() {
      const [entries, cursor] = await Promise.all([getOutboxEntries(), loadCursor()]);
      return {
        adapterName: adapter.name,
        isRemote: adapter.isRemote,
        pendingCount: entries.length,
        lastPushOkAt: cursor.lastPushOkAt,
        lastPullOkAt: cursor.lastPullOkAt,
      };
    },
  };
}
