import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDatabase } from '@/db/testUtils';
import {
  getManualItemsBySession,
  getPlacementsInRange,
  getShoppingSessionsBySpaceAndStatus,
  getTicksBySession,
  placementRepo,
} from '@/db/repo';
import { placement } from '@/testdata/factories';
import { useShoppingStore } from './useShoppingStore';

const spaceId = 'space-1';

/** Every line on the derived list, flattened for order-independent lookups. */
function lineFor(lineKey: string) {
  const list = useShoppingStore.getState().derivedList;
  return list?.groups.flatMap((g) => g.lines).find((l) => l.lineKey === lineKey);
}

describe('useShoppingStore.clearActiveSession', () => {
  beforeEach(async () => {
    await resetTestDatabase();
    // Reset the singleton store between tests.
    useShoppingStore.setState({
      session: null,
      ticks: [],
      manualItems: [],
      itemMeta: [],
      packSizes: [],
      derivedList: null,
      loading: false,
      error: null,
    });
  });

  it('marks the active session done and resets store state', async () => {
    await useShoppingStore.getState().startSession(spaceId, '2026-08-03', '2026-08-09');
    expect(useShoppingStore.getState().session).not.toBeNull();

    await useShoppingStore.getState().clearActiveSession(spaceId);

    // Store is cleared.
    expect(useShoppingStore.getState().session).toBeNull();
    expect(useShoppingStore.getState().derivedList).toBeNull();

    // No active session remains; the old one is now 'done'.
    expect(await getShoppingSessionsBySpaceAndStatus(spaceId, 'active')).toHaveLength(0);
    expect(await getShoppingSessionsBySpaceAndStatus(spaceId, 'done')).toHaveLength(1);
  });

  it('refuses to retarget an open list to a different week', async () => {
    // Retargeting used to happen silently, which dragged one week's ticks onto
    // another week's list. The caller has to ask the user and pass `replace`.
    const first = await useShoppingStore.getState().startSession(spaceId, '2026-08-03', '2026-08-09');

    await expect(
      useShoppingStore.getState().startSession(spaceId, '2026-08-10', '2026-08-16'),
    ).rejects.toThrow(/already open/i);

    const active = await getShoppingSessionsBySpaceAndStatus(spaceId, 'active');
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(first.id);
    expect(active[0]!.fromDate).toBe('2026-08-03');
  });

  it('reuses the open session — and its ticks — when the week is unchanged', async () => {
    // The common flow: edit the plan, generate again. Losing ticks here would
    // punish the user for tidying their week.
    const first = await useShoppingStore.getState().startSession(spaceId, '2026-08-03', '2026-08-09');
    await useShoppingStore.getState().toggleTick('pasta');

    const again = await useShoppingStore.getState().startSession(spaceId, '2026-08-03', '2026-08-09');

    expect(again.id).toBe(first.id);
    expect(useShoppingStore.getState().ticks.find((t) => t.lineKey === 'pasta')?.ticked).toBe(true);
  });

  it('replace mints a fresh session and leaves the old ticks behind', async () => {
    const first = await useShoppingStore.getState().startSession(spaceId, '2026-08-03', '2026-08-09');
    await useShoppingStore.getState().toggleTick('pasta');

    const second = await useShoppingStore
      .getState()
      .startSession(spaceId, '2026-08-10', '2026-08-16', { replace: true });

    expect(second.id).not.toBe(first.id);
    expect(await getShoppingSessionsBySpaceAndStatus(spaceId, 'active')).toHaveLength(1);
    expect(await getShoppingSessionsBySpaceAndStatus(spaceId, 'done')).toHaveLength(1);
    expect(await getTicksBySession(second.id)).toHaveLength(0);
  });

  it('leaves the plan alone', async () => {
    // The whole point of "clear list" as distinct from "clear week": the plan
    // survives, so the same list can be rebuilt from the board.
    await placementRepo.put({ ...placement('p1', 'r-1', '2026-08-04', 'dinner'), spaceId });
    await useShoppingStore.getState().startSession(spaceId, '2026-08-03', '2026-08-09');

    await useShoppingStore.getState().clearActiveSession(spaceId);

    const kept = await getPlacementsInRange(spaceId, '2026-08-03', '2026-08-09');
    expect(kept).toHaveLength(1);
    expect(kept[0]!.id).toBe('p1');
  });

  it('lets the next startSession build a fresh session with the new dates', async () => {
    await useShoppingStore.getState().startSession(spaceId, '2026-08-03', '2026-08-09');
    await useShoppingStore.getState().clearActiveSession(spaceId);

    const next = await useShoppingStore.getState().startSession(spaceId, '2026-08-10', '2026-08-16');
    expect(next.fromDate).toBe('2026-08-10');
    expect(next.toDate).toBe('2026-08-16');
    expect(await getShoppingSessionsBySpaceAndStatus(spaceId, 'active')).toHaveLength(1);
  });
});

describe('useShoppingStore.removeLine', () => {
  beforeEach(async () => {
    resetTestDatabase();
    useShoppingStore.setState({
      session: null,
      ticks: [],
      manualItems: [],
      itemMeta: [],
      packSizes: [],
      derivedList: null,
      loading: false,
      error: null,
    });
  });

  /**
   * Starts a session and adds one hand-typed item, returning the key the
   * SHOPPING LINE uses — `parsed.itemKey`. Note this is not `ManualItem.lineKey`,
   * which is the parser's hash of the raw text and never matches a line.
   */
  async function withMilk(): Promise<string> {
    const session = await useShoppingStore
      .getState()
      .startSession(spaceId, '2026-08-03', '2026-08-09');
    const item = await useShoppingStore.getState().addManualItem('2 pints milk', session.id);
    return item!.parsed.itemKey;
  }

  it('takes the line off the list and tombstones the item behind it', async () => {
    const key = await withMilk();
    expect(lineFor(key)).toBeDefined();

    await useShoppingStore.getState().removeLine(key);

    expect(lineFor(key)).toBeUndefined();
    const session = useShoppingStore.getState().session!;
    expect(await getManualItemsBySession(session.id)).toHaveLength(0);
  });

  it('keeps the tick, so an item already in the trolley stays recorded', async () => {
    const key = await withMilk();
    await useShoppingStore.getState().toggleTick(key);

    await useShoppingStore.getState().removeLine(key);

    const session = useShoppingStore.getState().session!;
    const stored = (await getTicksBySession(session.id)).find((t) => t.lineKey === key)!;
    expect(stored.removed).toBe(true);
    expect(stored.ticked).toBe(true);
  });

  it('restoreLine puts the line back with its tick intact', async () => {
    const key = await withMilk();
    const before = lineFor(key)!.displayQuantity;
    await useShoppingStore.getState().toggleTick(key);
    await useShoppingStore.getState().removeLine(key);

    await useShoppingStore.getState().restoreLine(key);

    const line = lineFor(key);
    expect(line).toBeDefined();
    expect(line!.ticked).toBe(true);
    expect(line!.displayQuantity).toBe(before);
  });

  it('brings a removed item back exactly once when it is typed again', async () => {
    // The tombstone must hold. If the tombstoned row came back alongside the
    // newly typed one, both would count and the user would silently get double
    // what they asked for — hence comparing against the original quantity
    // rather than a literal, which also keeps this dialect-independent.
    const key = await withMilk();
    const before = lineFor(key)!.displayQuantity;
    await useShoppingStore.getState().removeLine(key);

    const session = useShoppingStore.getState().session!;
    await useShoppingStore.getState().addManualItem('2 pints milk', session.id);

    const line = lineFor(key);
    expect(line).toBeDefined();
    expect(line!.displayQuantity).toBe(before);
  });
});
