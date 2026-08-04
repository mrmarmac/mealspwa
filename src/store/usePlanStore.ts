/**
 * The meal plan board: placements for a loaded date range, plus leftover
 * link derivation. `deriveLeftoverLinks` is a pure function over whatever
 * placement list you hand it — the store wires it to the currently loaded
 * range, but a caller that needs an authoritative broken/not-broken answer
 * for a placement whose source might be outside that range should load a
 * wider window (or fetch the source directly) before trusting `broken`.
 */
import { create } from 'zustand';
import {
  deletePlacementsBefore,
  getPlacementsByLeftoverOf,
  getPlacementsInRange,
  placementRepo,
} from '@/db/repo';
import { uuidv7, type Id, type ISODate } from '@/domain/primitives';
import {
  SCHEMA_VERSION,
  makeSlotId,
  type LeftoverLink,
  type MealType,
  type Multiplier,
  type Placement,
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

/**
 * Derive leftover links from a set of placements (normally: the currently
 * live placements in view). A link is `broken` when its source cook
 * placement is not present in `placements` — which covers both "deleted"
 * (a live-only fetch simply won't include a tombstoned row) and "missing" —
 * or when the source is scheduled AFTER the leftover target. Broken links
 * are still returned: the caller decides how to render them, but this
 * function never deletes anything.
 */
export function deriveLeftoverLinks(placements: Placement[]): LeftoverLink[] {
  const byId = new Map(placements.map((p) => [p.id, p] as const));
  const links: LeftoverLink[] = [];

  for (const target of placements) {
    if (target.source !== 'leftover' || target.leftoverOf === null) continue;
    const source = byId.get(target.leftoverOf);
    const broken = !source || source.date > target.date;

    links.push({
      sourcePlacementId: target.leftoverOf,
      // The real source slot is unknowable once the source is missing; fall
      // back to the target's own slot as a harmless placeholder — callers
      // must treat this field as unreliable whenever `broken` is true.
      sourceSlot: source ? source.slot : target.slot,
      targetPlacementId: target.id,
      targetSlot: target.slot,
      recipeName: source ? source.recipeNameSnapshot : target.recipeNameSnapshot,
      // Not derivable from a placement pair alone; informational only, and
      // never read by the merge, per the domain contract.
      portionShare: 1,
      broken,
    });
  }

  return links;
}

export interface PlaceInput {
  spaceId: Id;
  date: ISODate;
  mealType: MealType;
  recipeId: Id | null;
  recipeNameSnapshot: string;
  freeText?: string | null;
  multiplier?: Multiplier;
  notes?: string | null;
  position?: number;
}

function newPlacement(input: PlaceInput): Placement {
  return {
    id: uuidv7(),
    kind: 'placement',
    spaceId: input.spaceId,
    createdAt: new Date().toISOString(),
    updatedAt: '',
    lastWriterClientId: '',
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    date: input.date,
    mealType: input.mealType,
    slot: makeSlotId(input.date, input.mealType),
    position: input.position ?? 0,
    recipeId: input.recipeId,
    recipeNameSnapshot: input.recipeNameSnapshot,
    freeText: input.freeText ?? null,
    source: 'cook',
    leftoverOf: null,
    multiplier: input.multiplier ?? 1,
    notes: input.notes ?? null,
  };
}

interface PlanStoreState {
  placements: Placement[];
  range: { spaceId: Id; from: ISODate; to: ISODate } | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;

  load(spaceId: Id, from: ISODate, to: ISODate): Promise<void>;
  place(input: PlaceInput): Promise<Placement>;
  move(placementId: Id, date: ISODate, mealType: MealType): Promise<Placement | undefined>;
  /** Tombstones the placement AND, in the same batch, every leftover
   *  placement that points at it (queried directly from IndexedDB, not just
   *  the in-memory list, so cascades work even if a child falls outside the
   *  loaded range). */
  remove(placementId: Id): Promise<void>;
  /** Tombstones every placement in the inclusive [from, to] range (both cook
   *  and leftover), clearing the week from the board. */
  clearRange(spaceId: Id, from: ISODate, to: ISODate): Promise<void>;
  /** Hard-deletes local placements dated before `cutoff` (4-week retention).
   *  Returns the number pruned. */
  pruneBefore(spaceId: Id, cutoff: ISODate): Promise<number>;
  setMultiplier(placementId: Id, multiplier: Multiplier): Promise<Placement | undefined>;
  /** Creates the child leftover placement for a source cook placement. */
  setLeftovers(
    sourcePlacementId: Id,
    targetDate: ISODate,
    targetMealType: MealType,
  ): Promise<Placement | undefined>;
  leftoverLinks(): LeftoverLink[];
}

export const usePlanStore = create<PlanStoreState>((set, get) => ({
  placements: [],
  range: null,
  loading: false,
  loaded: false,
  error: null,

  async load(spaceId, from, to) {
    set({ loading: true, error: null });
    try {
      const placements = await getPlacementsInRange(spaceId, from, to);
      set({ placements, range: { spaceId, from, to }, loading: false, loaded: true });
    } catch (err) {
      set({ error: errorMessage(err), loading: false });
    }
  },

  async place(input) {
    const placement = newPlacement(input);
    set((s) => ({ placements: [...s.placements, placement] }));
    const saved = await placementRepo.put(placement);
    set((s) => ({ placements: replaceInList(s.placements, saved) }));
    return saved;
  },

  async move(placementId, date, mealType) {
    const existing = get().placements.find((p) => p.id === placementId);
    if (!existing) return undefined;
    const updated: Placement = { ...existing, date, mealType, slot: makeSlotId(date, mealType) };
    set((s) => ({ placements: replaceInList(s.placements, updated) }));
    const saved = await placementRepo.put(updated);
    set((s) => ({ placements: replaceInList(s.placements, saved) }));
    return saved;
  },

  async remove(placementId) {
    const children = await getPlacementsByLeftoverOf(placementId);
    const idsToRemove = [placementId, ...children.map((c) => c.id)];
    const idSet = new Set(idsToRemove);
    set((s) => ({ placements: s.placements.filter((p) => !idSet.has(p.id)) }));
    await Promise.all(idsToRemove.map((id) => placementRepo.remove(id)));
  },

  async clearRange(spaceId, from, to) {
    // Include tombstoned rows? No — tombstoning an already-tombstoned row is a
    // harmless no-op, but we only need to clear what's live in the range.
    const inRange = await getPlacementsInRange(spaceId, from, to);
    const idSet = new Set(inRange.map((p) => p.id));
    set((s) => ({ placements: s.placements.filter((p) => !idSet.has(p.id)) }));
    await Promise.all(inRange.map((p) => placementRepo.remove(p.id)));
  },

  async pruneBefore(spaceId, cutoff) {
    const removed = await deletePlacementsBefore(spaceId, cutoff);
    if (removed > 0) {
      set((s) => ({ placements: s.placements.filter((p) => p.date >= cutoff) }));
    }
    return removed;
  },

  async setMultiplier(placementId, multiplier) {
    const existing = get().placements.find((p) => p.id === placementId);
    if (!existing) return undefined;
    const updated: Placement = { ...existing, multiplier };
    set((s) => ({ placements: replaceInList(s.placements, updated) }));
    const saved = await placementRepo.put(updated);
    set((s) => ({ placements: replaceInList(s.placements, saved) }));
    return saved;
  },

  async setLeftovers(sourcePlacementId, targetDate, targetMealType) {
    const source =
      get().placements.find((p) => p.id === sourcePlacementId) ??
      (await placementRepo.get(sourcePlacementId));
    if (!source) return undefined;

    const child: Placement = {
      id: uuidv7(),
      kind: 'placement',
      spaceId: source.spaceId,
      createdAt: new Date().toISOString(),
      updatedAt: '',
      lastWriterClientId: '',
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
      date: targetDate,
      mealType: targetMealType,
      slot: makeSlotId(targetDate, targetMealType),
      position: 0,
      recipeId: source.recipeId,
      recipeNameSnapshot: source.recipeNameSnapshot,
      freeText: null,
      source: 'leftover',
      leftoverOf: source.id,
      multiplier: source.multiplier,
      notes: null,
    };

    set((s) => ({ placements: [...s.placements, child] }));
    const saved = await placementRepo.put(child);
    set((s) => ({ placements: replaceInList(s.placements, saved) }));
    return saved;
  },

  leftoverLinks() {
    return deriveLeftoverLinks(get().placements);
  },
}));
