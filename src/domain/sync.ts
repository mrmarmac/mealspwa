import { hlcCompare } from './hlc';
import type { ClientId, HLC, Id } from './primitives';
import type { EntityKind, Placement, Syncable } from './types';

/**
 * The entire conflict resolution algorithm: per-entity last-write-wins on the
 * hybrid logical clock.
 *
 * Note that `deletedAt` is deliberately NOT special-cased. If device A deletes a
 * recipe at t=5 while device B renames it at t=7, the rename wins and the recipe
 * lives. That is the right call for a two-person household, and it makes
 * "undelete" free — clearing the tombstone is just a newer write.
 */
export function resolve<T extends Syncable>(local: T | undefined, remote: T): T {
  if (!local) return remote;
  return hlcCompare(remote.updatedAt, local.updatedAt) > 0 ? remote : local;
}

export function isLive<T extends Syncable>(e: T | undefined): e is T {
  return !!e && e.deletedAt === null;
}

/** Entities are small enough that whole-entity LWW is cheap; a placement is one
 *  meal in one slot and a tick is one row, so the realistic collisions are
 *  convergent rather than lossy. */
export interface SyncPacket {
  spaceId: Id;
  since: HLC | null;
  entities: Syncable[];
}

export interface SyncCursor {
  clientId: ClientId;
  lastPulledHlc: HLC | null;
  /** Outbox: ids written locally since the last successful push. Maintained even
   *  with no remote configured, so the first ever sync push is already correct. */
  dirtyIds: Id[];
  lastPushOkAt: string | null;
  lastPullOkAt: string | null;
}

/**
 * The seam that keeps local-only from being a dead end. A remote backend is a
 * new implementation of this interface plus a config line — the repositories,
 * the clock, the outbox and `resolve` above are already correct for two peers.
 */
export interface SyncAdapter {
  readonly name: string;
  readonly isRemote: boolean;
  /** Push locally-dirty entities. Returns the ids the remote accepted. */
  push(spaceId: Id, entities: Syncable[]): Promise<Id[]>;
  /** Pull everything changed since `since`. */
  pull(spaceId: Id, since: HLC | null): Promise<SyncPacket>;
  /** Optional live updates; returns an unsubscribe function. */
  subscribe?(spaceId: Id, onPacket: (p: SyncPacket) => void): () => void;
}

// ---------------------------------------------------------------------------
// Scaling — the one rule that makes leftovers contribute nothing
// ---------------------------------------------------------------------------

/**
 * A leftover placement scales to zero. Keeping this as a single function, rather
 * than an `if` at each call site, is why there is no code path that can forget
 * it and double-buy the ingredients.
 */
export function effectiveScale(p: Placement): number {
  return p.source === 'leftover' ? 0 : p.multiplier;
}

// ---------------------------------------------------------------------------
// Write stamping
// ---------------------------------------------------------------------------

export interface StampContext {
  clientId: ClientId;
  now(): HLC;
}

/** Apply sync metadata to a new or updated entity. All writes go through this. */
export function stamp<T extends Syncable>(entity: T, ctx: StampContext): T {
  return {
    ...entity,
    updatedAt: ctx.now(),
    lastWriterClientId: ctx.clientId,
  };
}

export function tombstone<T extends Syncable>(entity: T, ctx: StampContext): T {
  const at = ctx.now();
  return { ...entity, deletedAt: at, updatedAt: at, lastWriterClientId: ctx.clientId };
}

/** Deterministic ids, so concurrent writes to the same logical row converge. */
export const tickId = (sessionId: Id, lineKey: string): Id => `${sessionId}:${lineKey}`;
export const itemMetaId = (itemKey: string): Id => `item:${itemKey}`;
export const packSizeId = (itemKey: string, container: string): Id =>
  `pack:${itemKey}:${container}`;

export const ENTITY_KINDS: EntityKind[] = [
  'space',
  'recipe',
  'placement',
  'shoppingSession',
  'shoppingTick',
  'manualItem',
  'itemMeta',
  'packSize',
];
