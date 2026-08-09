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
  type ShoppingLine,
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
  return undefined;
}

/** A fresh tick row for a line. Shared by `toggleTick` and `removeLine` so the
 *  two cannot drift in how they seed the at-tick snapshot. */
function newTick(
  session: ShoppingSession,
  lineKey: string,
  line: ShoppingLine | undefined,
  nowIso: string,
): ShoppingTick {
  const primaryTotal = line?.totals[0];
  return {
    id: tickId(session.id, lineKey),
    kind: 'shoppingTick',
    spaceId: session.spaceId,
    createdAt: nowIso,
    updatedAt: '',
    lastWriterClientId: '',
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    sessionId: session.id,
    lineKey,
    ticked: false,
    tickedAt: null,
    quantityAtTick: primaryTotal?.value ?? null,
    unitAtTick: primaryTotal?.unit ?? null,
    displayNameAtTick: line?.displayName ?? lineKey,
    displayQuantityAtTick: line?.displayQuantity ?? '',
  };
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

  /**
   * Loads (or creates, if none is active) the session for a space and all of
   * its related rows, then computes the derived list.
   *
   * Rebuilding the SAME week reuses the open session, so editing the plan and
   * generating again never costs the user their ticks. A DIFFERENT week
   * throws unless `opts.replace` is set — the caller has to have asked first,
   * because replacing abandons the open list.
   */
  startSession(
    spaceId: Id,
    from: ISODate,
    to: ISODate,
    opts?: { replace?: boolean },
  ): Promise<ShoppingSession>;
  /** Loads the currently active session for a space without creating one. */
  loadActive(spaceId: Id): Promise<void>;
  /** Reads the active session WITHOUT loading it into the store, so a screen
   *  that never called `loadActive` (the plan board) can still ask "is a list
   *  open, and for which week?" before it offers to replace one. */
  peekActiveSession(spaceId: Id): Promise<ShoppingSession | null>;
  /** Marks the active session `done` and resets store state, so the shopping
   *  list is cleared and the next `startSession` builds a fresh one. Never
   *  touches the plan. */
  clearActiveSession(spaceId: Id): Promise<void>;
  toggleTick(lineKey: string): Promise<ShoppingTick | undefined>;
  /** Strikes a line off this shop's list. Leaves `ticked` alone, so an item
   *  already in the trolley stays recorded as such and `restoreLine` is
   *  lossless. */
  removeLine(lineKey: string): Promise<void>;
  /** Undoes `removeLine`. */
  restoreLine(lineKey: string): Promise<void>;
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

/** Closes every open session for a space. Shared by `clearActiveSession` and
 *  `startSession`'s replace path so "abandon the open list" means one thing. */
async function markActiveDone(spaceId: Id): Promise<void> {
  const active = await getShoppingSessionsBySpaceAndStatus(spaceId, 'active');
  await Promise.all(
    active.map((session) => shoppingSessionRepo.put({ ...session, status: 'done' })),
  );
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

  async startSession(spaceId, from, to, opts) {
    set({ loading: true, error: null });
    try {
      const active = await getShoppingSessionsBySpaceAndStatus(spaceId, 'active');
      let existing: ShoppingSession | undefined = active[0];

      if (existing && (existing.fromDate !== from || existing.toDate !== to)) {
        // A list is open for another week. Silently retargeting it used to
        // drag that week's ticks across, so the caller must have asked the
        // user first and passed `replace`.
        if (!opts?.replace) {
          throw new Error('A shopping list is already open for another week.');
        }
        await markActiveDone(spaceId);
        existing = undefined;
      }

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
      } else {
        // Same week: reuse the open session, so regenerating after a plan
        // edit keeps every tick the user has already made.
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

  async peekActiveSession(spaceId) {
    const active = await getShoppingSessionsBySpaceAndStatus(spaceId, 'active');
    return active[0] ?? null;
  },

  async clearActiveSession(spaceId) {
    await markActiveDone(spaceId);
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

    const base = existing ?? newTick(session, lineKey, line, nowIso);
    const draft: ShoppingTick = { ...base, ticked, tickedAt: ticked ? nowIso : null };

    set((s) => ({ ticks: replaceInList(s.ticks, draft) }));
    const saved = await shoppingTickRepo.put(draft);
    const { ticks, manualItems, itemMeta, packSizes } = get();
    const nextTicks = replaceInList(ticks, saved);
    const derivedList = await recomputeDerivedList(session, nextTicks, manualItems, itemMeta, packSizes);
    set({ ticks: nextTicks, derivedList });
    return saved;
  },

  async removeLine(lineKey) {
    const session = get().session;
    if (!session) return;

    const existing = get().ticks.find((t) => t.id === tickId(session.id, lineKey));
    const line = findLine(get().derivedList, lineKey);
    const base = existing ?? newTick(session, lineKey, line, new Date().toISOString());
    // `ticked` is deliberately untouched: the row leaves the list either way,
    // and keeping it means Undo restores exactly what the user had.
    const draft: ShoppingTick = { ...base, removed: true };

    // Hand-added rows are backed by a real entity, so hiding them is not
    // enough — tombstone them, or the line would come back the moment the
    // `removed` flag is cleared. Only this session's, though: a standing item
    // (`sessionId: null`) belongs to every future shop and must survive.
    //
    // Matched on `parsed.itemKey`, NOT `ManualItem.lineKey`: a shopping line's
    // key is the merge key, while `ManualItem.lineKey` is the parser's hash of
    // the raw text. Comparing those two never matches.
    const doomed = get().manualItems.filter(
      (m) => m.parsed.itemKey === lineKey && m.sessionId === session.id && m.deletedAt === null,
    );

    set((s) => ({ ticks: replaceInList(s.ticks, draft) }));
    const saved = await shoppingTickRepo.put(draft);
    await Promise.all(doomed.map((m) => manualItemRepo.remove(m.id)));

    // Re-read WITH tombstones so `restoreLine` can find them again.
    // `collectComponents` filters them out via `isLive`, so they cost nothing.
    const nextManualItems = await getManualItemsBySession(session.id, { includeDeleted: true });
    const { ticks, itemMeta, packSizes } = get();
    const nextTicks = replaceInList(ticks, saved);
    const derivedList = await recomputeDerivedList(
      session,
      nextTicks,
      nextManualItems,
      itemMeta,
      packSizes,
    );
    set({ ticks: nextTicks, manualItems: nextManualItems, derivedList });
  },

  async restoreLine(lineKey) {
    const session = get().session;
    if (!session) return;

    const existing = get().ticks.find((t) => t.id === tickId(session.id, lineKey));
    if (!existing) return;
    const draft: ShoppingTick = { ...existing, removed: false };

    const buried = get().manualItems.filter(
      (m) => m.parsed.itemKey === lineKey && m.sessionId === session.id && m.deletedAt !== null,
    );

    set((s) => ({ ticks: replaceInList(s.ticks, draft) }));
    const saved = await shoppingTickRepo.put(draft);
    await Promise.all(buried.map((m) => manualItemRepo.put({ ...m, deletedAt: null })));

    const nextManualItems = await getManualItemsBySession(session.id, { includeDeleted: true });
    const { ticks, itemMeta, packSizes } = get();
    const nextTicks = replaceInList(ticks, saved);
    const derivedList = await recomputeDerivedList(
      session,
      nextTicks,
      nextManualItems,
      itemMeta,
      packSizes,
    );
    set({ ticks: nextTicks, manualItems: nextManualItems, derivedList });
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

    // Typing an item the user struck off earlier has to bring it back. The
    // `removed` flag is keyed on the line, not on this new row, so without
    // this the add would write a row that derivation then filters straight
    // out — and the item would appear to vanish as you add it.
    // Keyed on `parsed.itemKey` — the shopping line's key — not on
    // `parsed.lineKey`, which is the parser's hash of the raw text.
    let nextTicks = get().ticks;
    const struckOff = session
      ? nextTicks.find(
          (t) => t.id === tickId(session.id, parsed.itemKey) && t.removed === true,
        )
      : undefined;
    if (struckOff) {
      const revived = await shoppingTickRepo.put({ ...struckOff, removed: false });
      nextTicks = replaceInList(nextTicks, revived);
    }

    const { manualItems, itemMeta, packSizes } = get();
    const nextManualItems = replaceInList(manualItems, saved);
    const derivedList = await recomputeDerivedList(
      session,
      nextTicks,
      nextManualItems,
      itemMeta,
      packSizes,
    );
    set({ ticks: nextTicks, manualItems: nextManualItems, derivedList });
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
