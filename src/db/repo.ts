/**
 * The repository layer: the only code in the app allowed to write to
 * IndexedDB directly. Every mutation funnels through `put()` (or the
 * `remove()` tombstone wrapper around it), which stamps the entity and
 * enqueues its id in the outbox in a single transaction — so a crash
 * between "wrote the entity" and "queued it for sync" is not a state that
 * can happen.
 */
import type { StoreNames } from 'idb';
import { resolve, stamp, tombstone } from '@/domain/sync';
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
  Syncable,
} from '@/domain/types';
import type { Id, ISODate } from '@/domain/primitives';
import { ensureClock } from './clock';
import { getDB, type MealsDBSchema, type OutboxEntry } from './idb';

export interface GetAllOptions {
  includeDeleted?: boolean;
}

export interface Repo<T extends Syncable> {
  get(id: Id): Promise<T | undefined>;
  getAll(opts?: GetAllOptions): Promise<T[]>;
  /** Stamps `updatedAt`/`lastWriterClientId`, writes the entity, and enqueues
   *  its id in the outbox — all in one IndexedDB transaction. Returns the
   *  stamped entity actually written. */
  put(entity: T): Promise<T>;
  /** Tombstones (never hard-deletes) via `domain/sync#tombstone`, through the
   *  same atomic write+enqueue path as `put`. No-ops if the entity doesn't
   *  exist locally. */
  remove(id: Id): Promise<void>;
  /** Merge an entity received from sync/import via `resolve()`. Writes only
   *  when the incoming entity wins; never touches the outbox — an entity
   *  that arrived FROM sync must not be queued TO sync. Returns whether the
   *  incoming entity was the winner (true) or the existing local copy was
   *  kept (false), so callers like the space-file importer can report
   *  applied/skipped counts. */
  applyRemote(entity: T): Promise<boolean>;
}

type SyncableStoreName = Exclude<
  StoreNames<MealsDBSchema>,
  'blobs' | 'outbox' | 'meta'
>;

async function writeStampedAndEnqueue<T extends Syncable>(
  storeName: SyncableStoreName,
  kind: EntityKind,
  stamped: T,
): Promise<T> {
  const db = await getDB();
  const tx = db.transaction([storeName, 'outbox'], 'readwrite');
  const entry: OutboxEntry = { id: stamped.id, kind, updatedAt: stamped.updatedAt };
  await Promise.all([
    // Every store here is keyed by `id`, matching Syncable — safe by
    // construction of the store↔type pairing in `createRepo` below. The
    // union-vs-generic-T mismatch TS sees here is real (nothing ties T to
    // storeName within this helper), so the cast goes through `unknown`.
    tx.objectStore(storeName).put(stamped as unknown as MealsDBSchema[typeof storeName]['value']),
    tx.objectStore('outbox').put(entry),
  ]);
  await tx.done;
  return stamped;
}

function createRepo<T extends Syncable>(storeName: SyncableStoreName, kind: EntityKind): Repo<T> {
  return {
    async get(id) {
      const db = await getDB();
      const row = await db.get(storeName, id);
      return row as T | undefined;
    },

    async getAll(opts) {
      const db = await getDB();
      const rows = (await db.getAll(storeName)) as unknown as T[];
      if (opts?.includeDeleted) return rows;
      return rows.filter((r) => r.deletedAt === null);
    },

    async put(entity) {
      const clock = await ensureClock();
      const stamped = stamp(entity, { clientId: clock.clientId, now: clock.now });
      return writeStampedAndEnqueue<T>(storeName, kind, stamped);
    },

    async remove(id) {
      const db = await getDB();
      const existing = (await db.get(storeName, id)) as T | undefined;
      if (!existing) return;
      const clock = await ensureClock();
      const stamped = tombstone(existing, { clientId: clock.clientId, now: clock.now });
      await writeStampedAndEnqueue<T>(storeName, kind, stamped);
    },

    async applyRemote(entity) {
      const db = await getDB();
      const local = (await db.get(storeName, entity.id)) as T | undefined;
      const winner = resolve(local, entity);
      if (winner === local) return false;
      await db.put(storeName, winner as unknown as MealsDBSchema[typeof storeName]['value']);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Typed repos
// ---------------------------------------------------------------------------

export const spaceRepo = createRepo<Space>('spaces', 'space');
export const recipeRepo = createRepo<Recipe>('recipes', 'recipe');
export const placementRepo = createRepo<Placement>('placements', 'placement');
export const shoppingSessionRepo = createRepo<ShoppingSession>('shoppingSessions', 'shoppingSession');
export const shoppingTickRepo = createRepo<ShoppingTick>('shoppingTicks', 'shoppingTick');
export const manualItemRepo = createRepo<ManualItem>('manualItems', 'manualItem');
export const itemMetaRepo = createRepo<ItemMeta>('itemMeta', 'itemMeta');
export const packSizeRepo = createRepo<PackSizeMemory>('packSizes', 'packSize');

export interface Repos {
  space: Repo<Space>;
  recipe: Repo<Recipe>;
  placement: Repo<Placement>;
  shoppingSession: Repo<ShoppingSession>;
  shoppingTick: Repo<ShoppingTick>;
  manualItem: Repo<ManualItem>;
  itemMeta: Repo<ItemMeta>;
  packSize: Repo<PackSizeMemory>;
}

export const repos: Repos = {
  space: spaceRepo,
  recipe: recipeRepo,
  placement: placementRepo,
  shoppingSession: shoppingSessionRepo,
  shoppingTick: shoppingTickRepo,
  manualItem: manualItemRepo,
  itemMeta: itemMetaRepo,
  packSize: packSizeRepo,
};

/** Route an entity coming from sync/import to the repo for its `kind`, so
 *  callers that only have a generic `Syncable` (the sync engine, the space
 *  file importer) don't need to know each entity's concrete shape. Returns
 *  whether the incoming entity was applied (see `Repo.applyRemote`). */
export function applyRemoteEntity(target: Repos, entity: Syncable): Promise<boolean> {
  // `entity.kind` narrows the discriminant but `Syncable` itself carries no
  // corresponding union of shapes to narrow against, so each branch casts
  // to the concrete type its kind implies — sound because the cast target
  // is always assignable to `Syncable`, the source's declared type.
  switch (entity.kind) {
    case 'space':
      return target.space.applyRemote(entity as Space);
    case 'recipe':
      return target.recipe.applyRemote(entity as Recipe);
    case 'placement':
      return target.placement.applyRemote(entity as Placement);
    case 'shoppingSession':
      return target.shoppingSession.applyRemote(entity as ShoppingSession);
    case 'shoppingTick':
      return target.shoppingTick.applyRemote(entity as ShoppingTick);
    case 'manualItem':
      return target.manualItem.applyRemote(entity as ManualItem);
    case 'itemMeta':
      return target.itemMeta.applyRemote(entity as ItemMeta);
    case 'packSize':
      return target.packSize.applyRemote(entity as PackSizeMemory);
  }
}

// ---------------------------------------------------------------------------
// byIndex helpers for the plan/shopping queries
// ---------------------------------------------------------------------------

/** Normalise a recipe read from storage so callers can rely on the invariant
 *  that `tags` is always an array — rows written before the field existed lack
 *  it at runtime despite the type. */
function normalizeRecipe(r: Recipe): Recipe {
  return r.tags ? r : { ...r, tags: [] };
}

export async function getRecipesBySpace(spaceId: Id, opts?: GetAllOptions): Promise<Recipe[]> {
  const db = await getDB();
  const rows = await db.getAllFromIndex('recipes', 'spaceId', spaceId);
  const visible = opts?.includeDeleted ? rows : rows.filter((r) => r.deletedAt === null);
  return visible.map(normalizeRecipe);
}

/**
 * One-time cleanup: give every legacy recipe missing `tags` an empty array,
 * written straight to storage. This is a purely local schema tidy-up, so it
 * bypasses the stamp/outbox path — no `updatedAt` churn, no sync push; each
 * device fixes its own rows (reads are already normalised regardless). Returns
 * the number backfilled; idempotent, so later runs write nothing.
 */
export async function backfillRecipeTags(spaceId: Id): Promise<number> {
  const db = await getDB();
  const rows = await db.getAllFromIndex('recipes', 'spaceId', spaceId);
  const missing = rows.filter((r) => !r.tags);
  if (missing.length === 0) return 0;
  const tx = db.transaction('recipes', 'readwrite');
  await Promise.all(missing.map((r) => tx.objectStore('recipes').put({ ...r, tags: [] })));
  await tx.done;
  return missing.length;
}

/**
 * Refresh the derived ingredient cache for any recipe parsed by an older
 * parser version. `ingredients` is a pure function of `ingredientsRaw` +
 * overrides + parser, so — exactly like `backfillRecipeTags` — this recomputes
 * locally and writes straight to storage, bypassing the stamp/outbox path: no
 * `updatedAt` churn, no sync push, each device re-derives its own rows
 * identically. `rederive` re-runs the parser (passed in so this low-level layer
 * stays parser-agnostic). Idempotent once every row is at `parserVersion`.
 */
export async function reparseStaleRecipes(
  spaceId: Id,
  parserVersion: number,
  rederive: (recipe: Recipe) => Recipe,
): Promise<number> {
  const db = await getDB();
  const rows = await db.getAllFromIndex('recipes', 'spaceId', spaceId);
  const stale = rows.filter((r) => r.parserVersion !== parserVersion);
  if (stale.length === 0) return 0;
  const tx = db.transaction('recipes', 'readwrite');
  await Promise.all(stale.map((r) => tx.objectStore('recipes').put(rederive(normalizeRecipe(r)))));
  await tx.done;
  return stale.length;
}

/** Placements for a space within an inclusive local-calendar date range,
 *  using the compound `by-space-date` index so this is a single index scan
 *  rather than a full-store filter. */
export async function getPlacementsInRange(
  spaceId: Id,
  fromDate: ISODate,
  toDate: ISODate,
  opts?: GetAllOptions,
): Promise<Placement[]> {
  const db = await getDB();
  const range = IDBKeyRange.bound([spaceId, fromDate], [spaceId, toDate]);
  const rows = await db.getAllFromIndex('placements', 'by-space-date', range);
  return opts?.includeDeleted ? rows : rows.filter((r) => r.deletedAt === null);
}

/**
 * Hard-delete placements dated strictly before `cutoff` for a space. This is
 * local retention hygiene for the 4-week window — a real delete, not a
 * tombstone.
 *
 * ONLY prunes rows that have already synced, i.e. that are NOT sitting in the
 * outbox waiting to be pushed. A row still in the outbox has a pending local
 * change the peer hasn't seen; deleting it would drop that change AND, because
 * sync is whole-entity last-write-wins with no tombstone left behind, invite
 * the peer to re-push its own copy and resurrect the row. Waiting until the
 * outbox has drained means the write has settled and normal delta sync (which
 * only re-pulls entities updated after its cursor) won't bring it back.
 *
 * Returns the count actually removed.
 */
export async function deletePlacementsBefore(spaceId: Id, cutoff: ISODate): Promise<number> {
  const db = await getDB();
  // Upper bound exclusive so a placement exactly on the cutoff is kept.
  const range = IDBKeyRange.bound([spaceId, ''], [spaceId, cutoff], false, true);
  const stale = await db.getAllFromIndex('placements', 'by-space-date', range);
  if (stale.length === 0) return 0;

  const pending = new Set((await db.getAll('outbox')).map((e) => e.id));
  const prunable = stale.filter((p) => !pending.has(p.id));
  if (prunable.length === 0) return 0;

  const tx = db.transaction('placements', 'readwrite');
  await Promise.all(prunable.map((p) => tx.objectStore('placements').delete(p.id)));
  await tx.done;
  return prunable.length;
}

export async function getPlacementsByRecipeId(
  recipeId: Id,
  opts?: GetAllOptions,
): Promise<Placement[]> {
  const db = await getDB();
  const rows = await db.getAllFromIndex('placements', 'recipeId', recipeId);
  return opts?.includeDeleted ? rows : rows.filter((r) => r.deletedAt === null);
}

/** The leftover placements that point back at a given cook placement. */
export async function getPlacementsByLeftoverOf(
  sourcePlacementId: Id,
  opts?: GetAllOptions,
): Promise<Placement[]> {
  const db = await getDB();
  const rows = await db.getAllFromIndex('placements', 'leftoverOf', sourcePlacementId);
  return opts?.includeDeleted ? rows : rows.filter((r) => r.deletedAt === null);
}

export async function getShoppingSessionsBySpaceAndStatus(
  spaceId: Id,
  status: ShoppingSession['status'],
  opts?: GetAllOptions,
): Promise<ShoppingSession[]> {
  const db = await getDB();
  const range = IDBKeyRange.only([spaceId, status]);
  const rows = await db.getAllFromIndex('shoppingSessions', 'by-space-status', range);
  return opts?.includeDeleted ? rows : rows.filter((r) => r.deletedAt === null);
}

export async function getTicksBySession(sessionId: Id, opts?: GetAllOptions): Promise<ShoppingTick[]> {
  const db = await getDB();
  const rows = await db.getAllFromIndex('shoppingTicks', 'sessionId', sessionId);
  return opts?.includeDeleted ? rows : rows.filter((r) => r.deletedAt === null);
}

/** `sessionId: null` (a standing item) is not indexable via `getAllFromIndex`
 *  on an index keyed by `sessionId`, since IndexedDB never indexes a `null`
 *  key value — so standing items are filtered out of the store scan. */
export async function getManualItemsBySession(
  sessionId: Id | null,
  opts?: GetAllOptions,
): Promise<ManualItem[]> {
  const db = await getDB();
  const rows =
    sessionId === null
      ? (await db.getAll('manualItems')).filter((r) => r.sessionId === null)
      : await db.getAllFromIndex('manualItems', 'sessionId', sessionId);
  return opts?.includeDeleted ? rows : rows.filter((r) => r.deletedAt === null);
}

export async function getItemMetaBySpace(spaceId: Id, opts?: GetAllOptions): Promise<ItemMeta[]> {
  const db = await getDB();
  const rows = await db.getAllFromIndex('itemMeta', 'spaceId', spaceId);
  return opts?.includeDeleted ? rows : rows.filter((r) => r.deletedAt === null);
}

export async function getPackSizesBySpace(
  spaceId: Id,
  opts?: GetAllOptions,
): Promise<PackSizeMemory[]> {
  const db = await getDB();
  const rows = await db.getAllFromIndex('packSizes', 'spaceId', spaceId);
  return opts?.includeDeleted ? rows : rows.filter((r) => r.deletedAt === null);
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export async function getOutboxEntries(): Promise<OutboxEntry[]> {
  const db = await getDB();
  return db.getAll('outbox');
}

export async function removeOutboxEntries(ids: Id[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('outbox', 'readwrite');
  await Promise.all(ids.map((id) => tx.objectStore('outbox').delete(id)));
  await tx.done;
}

/** Read the full, current entity for each outbox entry, routed by kind. An
 *  id that no longer resolves (should not happen — removal is a tombstone
 *  write, which itself goes through the outbox) is skipped rather than
 *  thrown on, so a push is never blocked by one bad row. */
export async function getOutboxEntities(target: Repos = repos): Promise<Syncable[]> {
  const entries = await getOutboxEntries();
  const entities = await Promise.all(
    entries.map(async (entry): Promise<Syncable | undefined> => {
      switch (entry.kind) {
        case 'space':
          return target.space.get(entry.id);
        case 'recipe':
          return target.recipe.get(entry.id);
        case 'placement':
          return target.placement.get(entry.id);
        case 'shoppingSession':
          return target.shoppingSession.get(entry.id);
        case 'shoppingTick':
          return target.shoppingTick.get(entry.id);
        case 'manualItem':
          return target.manualItem.get(entry.id);
        case 'itemMeta':
          return target.itemMeta.get(entry.id);
        case 'packSize':
          return target.packSize.get(entry.id);
      }
    }),
  );
  return entities.filter((e): e is Syncable => e !== undefined);
}

// ---------------------------------------------------------------------------
// Meta store — small keyed facts (clientId/HLC live in clock.ts; this is for
// everything else: active space id, one-shot flags, sync cursor).
// ---------------------------------------------------------------------------

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await getDB();
  const row = await db.get('meta', key);
  return row?.value as T | undefined;
}

export async function setMeta<T>(key: string, value: T): Promise<void> {
  const db = await getDB();
  await db.put('meta', { key, value });
}
