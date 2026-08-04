/**
 * The active shopping session: ticks, manual items, and the derived list
 * (computed by the parallel `shopping` package's `deriveShoppingList`, kept
 * here only as a cached recomputation result).
 *
 * ASSUMPTION: `deriveShoppingList`'s exact signature isn't frozen yet (it's
 * owned by a parallel agent under `src/shopping/derive.ts`). This store
 * calls it with a single input object bundling everything a derivation over
 * `domain/types`'s `ShoppingLine`/`DerivedShoppingList` shapes would
 * plausibly need: the session, the plan window's placements and recipes,
 * manual items, existing ticks, item-meta/pack-size memory, and the space's
 * settings (aisle order, dialect, household size). If the real signature
 * differs, only this call site needs updating.
 */
import { create } from 'zustand';
import { deriveShoppingList } from '@/shopping/derive';
import { parseIngredientBlock } from '@/parser';
import {
  getItemMetaBySpace,
  getManualItemsBySession,
  getPackSizesBySpace,
  getPlacementsInRange,
  getRecipesBySpace,
  getShoppingSessionsBySpaceAndStatus,
  getTicksBySession,
  itemMetaRepo,
  manualItemRepo,
  packSizeRepo,
  shoppingSessionRepo,
  shoppingTickRepo,
  spaceRepo,
} from '@/db/repo';
import { itemMetaId, packSizeId, tickId } from '@/domain/sync';
import { uuidv7, type Id, type ISODate } from '@/domain/primitives';
import {
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  type AisleCategory,
  type ContainerUnit,
  type DerivedShoppingList,
  type ItemMeta,
  type ManualItem,
  type MassUnit,
  type PackSizeMemory,
  type ShoppingSession,
  type ShoppingTick,
  type VolumeUnit,
} from '@/domain/types';

function replaceInList<T extends { id: Id }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const next = list.slice();
  next[idx] = item;
  return next;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function findLine(list: DerivedShoppingList | null, lineKey: string) {
  if (!list) return undefined;
  for (const group of list.groups) {
    const hit = group.lines.find((l) => l.lineKey === lineKey);
    if (hit) return hit;
  }
  return list.orphans.find((l) => l.lineKey === lineKey);
}

interface ShoppingStoreState {
  session: ShoppingSession | null;
  ticks: ShoppingTick[];
  manualItems: ManualItem[];
  itemMeta: ItemMeta[];
  packSizes: PackSizeMemory[];
  derivedList: DerivedShoppingList | null;
  loading: boolean;
  error: string | null;

  /** Loads (or creates, if none is active) the session for a space and all
   *  of its related rows, then computes the derived list. */
  startSession(spaceId: Id, from: ISODate, to: ISODate): Promise<ShoppingSession>;
  /** Loads the currently active session for a space without creating one. */
  loadActive(spaceId: Id): Promise<void>;
  /** Marks the active session `done` and resets store state, so the shopping
   *  list is cleared and the next `startSession` builds a fresh one. */
  clearActiveSession(spaceId: Id): Promise<void>;
  toggleTick(lineKey: string): Promise<ShoppingTick | undefined>;
  addManualItem(rawText: string, sessionId: Id | null): Promise<ManualItem | undefined>;
  setPackSize(
    spaceId: Id,
    itemKey: string,
    container: ContainerUnit,
    size: number,
    unit: MassUnit | VolumeUnit,
    assumed?: boolean,
  ): Promise<PackSizeMemory>;
  setItemMeta(
    spaceId: Id,
    itemKey: string,
    patch: Partial<Pick<ItemMeta, 'displayName' | 'category' | 'pantryStaple' | 'halvable' | 'aliasOf'>>,
  ): Promise<ItemMeta>;
}

async function recomputeDerivedList(
  session: ShoppingSession | null,
  ticks: ShoppingTick[],
  manualItems: ManualItem[],
  itemMeta: ItemMeta[],
  packSizes: PackSizeMemory[],
): Promise<DerivedShoppingList | null> {
  if (!session) return null;
  const [placements, recipes, space] = await Promise.all([
    getPlacementsInRange(session.spaceId, session.fromDate, session.toDate),
    getRecipesBySpace(session.spaceId),
    spaceRepo.get(session.spaceId),
  ]);
  const settings = space?.settings ?? DEFAULT_SETTINGS;

  return deriveShoppingList({
    session,
    placements,
    recipes,
    manualItems,
    ticks,
    itemMeta,
    packSizes,
    settings,
  });
}

export const useShoppingStore = create<ShoppingStoreState>((set, get) => ({
  session: null,
  ticks: [],
  manualItems: [],
  itemMeta: [],
  packSizes: [],
  derivedList: null,
  loading: false,
  error: null,

  async startSession(spaceId, from, to) {
    set({ loading: true, error: null });
    try {
      const active = await getShoppingSessionsBySpaceAndStatus(spaceId, 'active');
      const existing = active[0];

      let session: ShoppingSession;
      if (!existing) {
        const draft: ShoppingSession = {
          id: uuidv7(),
          kind: 'shoppingSession',
          spaceId,
          createdAt: new Date().toISOString(),
          updatedAt: '',
          lastWriterClientId: '',
          deletedAt: null,
          schemaVersion: SCHEMA_VERSION,
          fromDate: from,
          toDate: to,
          status: 'active',
          startedAt: new Date().toISOString(),
        };
        session = await shoppingSessionRepo.put(draft);
      } else if (existing.fromDate !== from || existing.toDate !== to) {
        // Reusing the open session, but for a different week — retarget its
        // range so the derived list is computed from the week being generated,
        // not whatever week the session was first opened for.
        session = await shoppingSessionRepo.put({ ...existing, fromDate: from, toDate: to });
      } else {
        session = existing;
      }

      const [ticks, manualItems, itemMeta, packSizes] = await Promise.all([
        getTicksBySession(session.id),
        getManualItemsBySession(session.id),
        getItemMetaBySpace(spaceId),
        getPackSizesBySpace(spaceId),
      ]);

      const derivedList = await recomputeDerivedList(session, ticks, manualItems, itemMeta, packSizes);
      set({ session, ticks, manualItems, itemMeta, packSizes, derivedList, loading: false });
      return session;
    } catch (err) {
      set({ error: errorMessage(err), loading: false });
      throw err;
    }
  },

  async loadActive(spaceId) {
    set({ loading: true, error: null });
    try {
      const active = await getShoppingSessionsBySpaceAndStatus(spaceId, 'active');
      const session = active[0] ?? null;
      if (!session) {
        set({ session: null, ticks: [], manualItems: [], derivedList: null, loading: false });
        return;
      }
      const [ticks, manualItems, itemMeta, packSizes] = await Promise.all([
        getTicksBySession(session.id),
        getManualItemsBySession(session.id),
        getItemMetaBySpace(spaceId),
        getPackSizesBySpace(spaceId),
      ]);
      const derivedList = await recomputeDerivedList(session, ticks, manualItems, itemMeta, packSizes);
      set({ session, ticks, manualItems, itemMeta, packSizes, derivedList, loading: false });
    } catch (err) {
      set({ error: errorMessage(err), loading: false });
    }
  },

  async clearActiveSession(spaceId) {
    const active = await getShoppingSessionsBySpaceAndStatus(spaceId, 'active');
    await Promise.all(
      active.map((session) => shoppingSessionRepo.put({ ...session, status: 'done' })),
    );
    set({ session: null, ticks: [], manualItems: [], derivedList: null });
  },

  async toggleTick(lineKey) {
    const session = get().session;
    if (!session) return undefined;

    const id = tickId(session.id, lineKey);
    const existing = get().ticks.find((t) => t.id === id);
    const line = findLine(get().derivedList, lineKey);
    const nowIso = new Date().toISOString();
    const ticked = !(existing?.ticked ?? false);
    const primaryTotal = line?.totals[0];

    const draft: ShoppingTick = existing
      ? { ...existing, ticked, tickedAt: ticked ? nowIso : null }
      : {
          id,
          kind: 'shoppingTick',
          spaceId: session.spaceId,
          createdAt: nowIso,
          updatedAt: '',
          lastWriterClientId: '',
          deletedAt: null,
          schemaVersion: SCHEMA_VERSION,
          sessionId: session.id,
          lineKey,
          ticked,
          tickedAt: ticked ? nowIso : null,
          quantityAtTick: primaryTotal?.value ?? null,
          unitAtTick: primaryTotal?.unit ?? null,
          displayNameAtTick: line?.displayName ?? lineKey,
          displayQuantityAtTick: line?.displayQuantity ?? '',
        };

    set((s) => ({ ticks: replaceInList(s.ticks, draft) }));
    const saved = await shoppingTickRepo.put(draft);
    const { ticks, manualItems, itemMeta, packSizes } = get();
    const nextTicks = replaceInList(ticks, saved);
    const derivedList = await recomputeDerivedList(session, nextTicks, manualItems, itemMeta, packSizes);
    set({ ticks: nextTicks, derivedList });
    return saved;
  },

  async addManualItem(rawText, sessionId) {
    const session = get().session;
    const spaceId = session?.spaceId;
    if (!spaceId) return undefined;

    const [parsed] = parseIngredientBlock(rawText);
    if (!parsed) return undefined;

    const draft: ManualItem = {
      id: uuidv7(),
      kind: 'manualItem',
      spaceId,
      createdAt: new Date().toISOString(),
      updatedAt: '',
      lastWriterClientId: '',
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      rawText,
      parsed,
      lineKey: parsed.lineKey,
    };

    set((s) => ({ manualItems: [...s.manualItems, draft] }));
    const saved = await manualItemRepo.put(draft);
    const { ticks, manualItems, itemMeta, packSizes } = get();
    const nextManualItems = replaceInList(manualItems, saved);
    const derivedList = await recomputeDerivedList(session, ticks, nextManualItems, itemMeta, packSizes);
    set({ manualItems: nextManualItems, derivedList });
    return saved;
  },

  async setPackSize(spaceId, itemKey, container, size, unit, assumed = false) {
    const id = packSizeId(itemKey, container);
    const existing = get().packSizes.find((p) => p.id === id);
    const draft: PackSizeMemory = existing
      ? { ...existing, size, unit, assumed }
      : {
          id,
          kind: 'packSize',
          spaceId,
          createdAt: new Date().toISOString(),
          updatedAt: '',
          lastWriterClientId: '',
          deletedAt: null,
          schemaVersion: SCHEMA_VERSION,
          itemKey,
          container,
          size,
          unit,
          assumed,
        };

    set((s) => ({ packSizes: replaceInList(s.packSizes, draft) }));
    const saved = await packSizeRepo.put(draft);
    const { session, ticks, manualItems, itemMeta, packSizes } = get();
    const nextPackSizes = replaceInList(packSizes, saved);
    const derivedList = await recomputeDerivedList(session, ticks, manualItems, itemMeta, nextPackSizes);
    set({ packSizes: nextPackSizes, derivedList });
    return saved;
  },

  async setItemMeta(spaceId, itemKey, patch) {
    const id = itemMetaId(itemKey);
    const existing = get().itemMeta.find((m) => m.id === id);
    const draft: ItemMeta = existing
      ? { ...existing, ...patch }
      : {
          id,
          kind: 'itemMeta',
          spaceId,
          createdAt: new Date().toISOString(),
          updatedAt: '',
          lastWriterClientId: '',
          deletedAt: null,
          schemaVersion: SCHEMA_VERSION,
          itemKey,
          displayName: patch.displayName ?? null,
          category: patch.category ?? null,
          pantryStaple: patch.pantryStaple ?? false,
          halvable: patch.halvable ?? false,
          aliasOf: patch.aliasOf ?? null,
        };

    set((s) => ({ itemMeta: replaceInList(s.itemMeta, draft) }));
    const saved = await itemMetaRepo.put(draft);
    const { session, ticks, manualItems, packSizes } = get();
    const nextItemMeta = replaceInList(get().itemMeta, saved);
    const derivedList = await recomputeDerivedList(session, ticks, manualItems, nextItemMeta, packSizes);
    set({ itemMeta: nextItemMeta, derivedList });
    return saved;
  },
}));

// Re-exported so consumers can annotate category choices without reaching
// into `@/domain/types` themselves.
export type { AisleCategory };
