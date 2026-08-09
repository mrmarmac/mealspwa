/**
 * The shopping list, derived end to end.
 *
 *   collect -> scale -> merge -> reconcile ticks -> group
 *
 * The reconciliation step is the one that earns the user's trust. The plan can
 * change while they are standing in the shop; when it does, every tick they
 * already made survives, a row that grew is RE-OPENED rather than quietly
 * rewritten, and a row whose last recipe left the plan leaves the list with
 * it. A tick outlives the row, so if that recipe comes back this session the
 * line returns already ticked.
 */
import type { Id, ISODate } from '@/domain/primitives';
import { isLive } from '@/domain/sync';
import type {
  AisleCategory,
  DerivedShoppingList,
  ItemMeta,
  ManualItem,
  PackSizeMemory,
  Placement,
  Recipe,
  ShoppingLine,
  ShoppingSession,
  ShoppingTick,
  SpaceSettings,
} from '@/domain/types';
import { collectComponents } from '@/merge/collect';
import { mergeComponents, packMemoryMap, type MergeContext } from '@/merge/merge';
import { materiallyIncreased } from './ticks';

export interface DeriveInput {
  /** Either the session itself, or its id plus the date window. */
  session?: ShoppingSession;
  sessionId?: Id;
  placements: Placement[];
  recipes: Recipe[];
  manualItems: ManualItem[];
  ticks: ShoppingTick[];
  itemMeta: ItemMeta[];
  packSizes: PackSizeMemory[];
  settings: SpaceSettings;
  fromDate?: ISODate;
  toDate?: ISODate;
  /** Item keys present when the session started; anything else is 'added since'. */
  keysAtStart?: string[];
}

export function deriveShoppingList(input: DeriveInput): DerivedShoppingList {
  const sessionId = input.sessionId ?? input.session?.id ?? '';
  const fromDate = input.fromDate ?? input.session?.fromDate ?? '0000-01-01';
  const toDate = input.toDate ?? input.session?.toDate ?? '9999-12-31';
  const metaByKey = new Map<string, ItemMeta>();
  for (const m of input.itemMeta) if (isLive(m)) metaByKey.set(m.itemKey, m);

  const components = collectComponents({
    placements: input.placements,
    recipes: input.recipes,
    manualItems: input.manualItems,
    settings: input.settings,
    fromDate,
    toDate,
    sessionId,
  });

  const ctx: MergeContext = {
    settings: input.settings,
    itemMeta: metaByKey,
    packSizes: packMemoryMap(input.packSizes),
  };
  const merged = mergeComponents(components, ctx);

  // ---- reconcile ticks ---------------------------------------------------
  const tickByKey = new Map<string, ShoppingTick>();
  for (const t of input.ticks) {
    if (!isLive(t)) continue;
    if (t.sessionId !== sessionId) continue;
    tickByKey.set(t.lineKey, t);
  }

  const startKeys = input.keysAtStart ? new Set(input.keysAtStart) : null;
  const lines: ShoppingLine[] = merged
    // Struck off by hand for this shop. Dropped before the counts are taken so
    // a removed row cannot sit in `total` and stop the list ever reading done.
    .filter((line) => tickByKey.get(line.lineKey)?.removed !== true)
    .map((line) => {
      const tick = tickByKey.get(line.lineKey);
      const ticked = tick?.ticked ?? false;
      const reopened = tick ? materiallyIncreased(tick, line, input.settings.dialect) : false;
      return {
        ...line,
        ticked,
        reopened,
        addedSinceStart: startKeys !== null && !startKeys.has(line.lineKey),
      };
    });

  // ---- group by aisle ----------------------------------------------------
  const order = input.settings.aisleOrder;
  const rank = new Map<AisleCategory, number>();
  order.forEach((c, i) => rank.set(c, i));
  const staplesRank = order.length + 1;
  const rankOf = (c: AisleCategory): number =>
    c === 'staples' ? staplesRank : (rank.get(c) ?? order.length);

  const byCategory = new Map<AisleCategory, ShoppingLine[]>();
  for (const l of lines) {
    const arr = byCategory.get(l.category);
    if (arr) arr.push(l);
    else byCategory.set(l.category, [l]);
  }

  const groups = [...byCategory.entries()]
    .sort((a, b) => rankOf(a[0]) - rankOf(b[0]) || a[0].localeCompare(b[0]))
    .map(([category, ls]) => ({
      category,
      lines: ls.slice().sort((a, b) => a.displayName.localeCompare(b.displayName) || a.lineKey.localeCompare(b.lineKey)),
    }));

  return {
    sessionId,
    groups,
    counts: {
      total: lines.length,
      ticked: lines.filter((l) => l.ticked).length,
      needsReview: lines.filter((l) => l.needsReview).length,
    },
  };
}
