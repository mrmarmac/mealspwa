/**
 * End-to-end tests for plan -> shopping list.
 *
 * These go through deriveShoppingList rather than mergeComponents directly,
 * because the thing worth protecting is the number that reaches the aisle, and
 * the bugs that would actually hurt live in the seams between collect, scale,
 * merge and format — not inside any one of them.
 */
import { describe, expect, it } from 'vitest';
import {
  placement,
  leftoverOf,
  recipe,
  session,
  settings,
  tick,
  packSize as packSizeMemory,
  manualItem,
} from '@/testdata/factories';
import { deriveShoppingList, type DeriveInput } from './derive';
import type { DerivedShoppingList, ShoppingLine } from '@/domain/types';

const MON = '2026-08-03';
const TUE = '2026-08-04';
const THU = '2026-08-06';
const SUN = '2026-08-09';

/** Every line across every group — order-independent lookups. */
function allLines(list: DerivedShoppingList): ShoppingLine[] {
  return list.groups.flatMap((g) => g.lines);
}

function lineFor(list: DerivedShoppingList, itemKey: string): ShoppingLine | undefined {
  return allLines(list).find((l) => l.lineKey === itemKey);
}

/** placement() takes an overrides object last; naming the recipe is the common case. */
function place(
  id: string,
  r: { id: string; name: string },
  date: string,
  mealType: 'lunch' | 'dinner' = 'dinner',
  extra: Record<string, unknown> = {},
) {
  return placement(id, r.id, date, mealType, { recipeNameSnapshot: r.name, ...extra });
}

/** A derive input with sensible empty defaults, so each test states only what it varies. */
function input(over: Partial<DeriveInput> = {}): DeriveInput {
  return {
    session: session('sess-1', MON, SUN),
    placements: [],
    recipes: [],
    manualItems: [],
    ticks: [],
    itemMeta: [],
    packSizes: [],
    settings: settings(),
    ...over,
  };
}

describe('collating ingredients across planned meals', () => {
  it('collates the same item from two different recipes into one row', () => {
    const gnocchi = recipe('r-gnocchi', 'Butter Bean Gnocchi', '2 tins butter beans\n500g gnocchi');
    const beans = recipe('r-beans', 'Creamy Butter Beans', '400g butter beans\n2 tbsp cream cheese');
    const list = deriveShoppingList(
      input({
        recipes: [gnocchi, beans],
        placements: [
          place('p1', gnocchi, TUE, 'dinner'),
          place('p2', beans, THU, 'dinner'),
        ],
      }),
    );

    const butterBeans = allLines(list).filter((l) => l.lineKey === 'butter bean');
    expect(butterBeans).toHaveLength(1);
    // 2 x 400g seeded tin default + 400g loose.
    expect(butterBeans[0]!.displayQuantity).toBe('≈ 1.2 kg');
    expect(butterBeans[0]!.hasAssumption).toBe(true);
  });

  it('keeps every contributing meal as provenance on the row', () => {
    const a = recipe('r-a', 'A', '1 onion');
    const b = recipe('r-b', 'B', '2 onions');
    const list = deriveShoppingList(
      input({
        recipes: [a, b],
        placements: [
          place('p1', a, TUE, 'dinner'),
          place('p2', b, THU, 'lunch'),
        ],
      }),
    );

    const onion = lineFor(list, 'onion')!;
    expect(onion.components).toHaveLength(2);
    expect(onion.components.map((c) => c.recipeName).sort()).toEqual(['A', 'B']);
  });

  it('never merges a variety into its base ingredient', () => {
    const r = recipe('r-1', 'Salad', '400g cherry tomatoes\n2 tomatoes');
    const list = deriveShoppingList(
      input({ recipes: [r], placements: [place('p1', r, TUE, 'dinner')] }),
    );

    expect(lineFor(list, 'cherry tomato')).toBeDefined();
    expect(lineFor(list, 'tomato')).toBeDefined();
    expect(lineFor(list, 'cherry tomato')!.displayQuantity).toBe('400 g');
  });

  it('produces a compound line rather than silently summing incompatible units', () => {
    // No pack size is known for a 'jar' of this item, and none is in the text,
    // so counting both containers is the honest answer.
    const r = recipe('r-1', 'Stew', '2 jars queen olives\n200g queen olives');
    const list = deriveShoppingList(
      input({ recipes: [r], placements: [place('p1', r, TUE, 'dinner')] }),
    );

    const olives = lineFor(list, 'queen olive')!;
    expect(olives.needsReview).toBe(true);
    expect(olives.totals.length).toBeGreaterThan(1);
    expect(olives.displayQuantity).toContain('+');
    // The components are never dropped just because they could not be summed.
    expect(olives.components).toHaveLength(2);
  });

  it('collapses a compound line once a pack size is supplied', () => {
    const r = recipe('r-1', 'Stew', '2 jars queen olives\n200g queen olives');
    const list = deriveShoppingList(
      input({
        recipes: [r],
        placements: [place('p1', r, TUE, 'dinner')],
        packSizes: [packSizeMemory('queen olive', 'jar', 300, 'g', false)],
      }),
    );

    const olives = lineFor(list, 'queen olive')!;
    expect(olives.totals).toHaveLength(1);
    expect(olives.displayQuantity).toBe('800 g');
    // The user told us the size, so this is not an assumption any more.
    expect(olives.hasAssumption).toBe(false);
  });
});

describe('multipliers, leftovers and per-person lines', () => {
  it('scales ingredients by the multiplier', () => {
    const r = recipe('r-1', 'Pasta', '300g pasta');
    const list = deriveShoppingList(
      input({
        recipes: [r],
        placements: [place('p1', r, TUE, 'dinner', { multiplier: 2 })],
      }),
    );
    expect(lineFor(list, 'pasta')!.displayQuantity).toBe('600 g');
  });

  it('multiplies per-person lines by the household size as well', () => {
    const r = recipe('r-1', 'Pasta', '100g pasta per person');
    const list = deriveShoppingList(
      input({
        recipes: [r],
        placements: [place('p1', r, TUE, 'dinner', { multiplier: 2 })],
        settings: settings({ householdSize: 2 }),
      }),
    );
    // 100g x household 2 x multiplier 2.
    expect(lineFor(list, 'pasta')!.displayQuantity).toBe('400 g');
  });

  it('a leftover meal contributes nothing but stays visible as provenance', () => {
    const r = recipe('r-1', 'Chilli', '2 tins butter beans');
    const cook = place('p1', r, TUE, 'dinner', { multiplier: 2 });
    const list = deriveShoppingList(
      input({
        recipes: [r],
        placements: [cook, leftoverOf('p2', cook, THU, 'lunch')],
      }),
    );

    const beans = lineFor(list, 'butter bean')!;
    // Cooked once at x2 -> 4 tins. The Thursday leftover adds nothing. Tins stay
    // tins here: with nothing incompatible to reconcile, '4 tins' is what you buy.
    expect(beans.displayQuantity).toBe('4 tins');
    expect(beans.components).toHaveLength(2);
    expect(beans.components.find((c) => c.placementId === 'p2')!.scale).toBe(0);
  });

  it('does not multiply pantry staples or to-taste lines', () => {
    const r = recipe('r-1', 'Anything', 'Salt and black pepper');
    const list = deriveShoppingList(
      input({
        recipes: [r],
        placements: [place('p1', r, TUE, 'dinner', { multiplier: 3 })],
      }),
    );
    const salt = lineFor(list, 'salt and pepper')!;
    expect(salt.isToTaste).toBe(true);
    expect(salt.displayQuantity).toBe('to taste');
  });

  it('collapses salt and pepper from many recipes into a single staples row', () => {
    const rs = [
      recipe('r-1', 'A', 'Salt and black pepper'),
      recipe('r-2', 'B', 'salt and pepper'),
      recipe('r-3', 'C', 'Kosher salt and freshly ground black pepper, to taste'),
    ];
    const list = deriveShoppingList(
      input({
        recipes: rs,
        placements: rs.map((r, i) => place(`p${i}`, r, TUE, 'dinner')),
      }),
    );

    expect(allLines(list).filter((l) => l.lineKey === 'salt and pepper')).toHaveLength(1);
    expect(lineFor(list, 'salt and pepper')!.isPantryStaple).toBe(true);
  });

  it('excludes meals planned outside the session window', () => {
    const r = recipe('r-1', 'Pasta', '300g pasta');
    const list = deriveShoppingList(
      input({
        recipes: [r],
        placements: [place('p1', r, '2026-09-01', 'dinner')],
        session: session('sess-1', MON, SUN),
      }),
    );
    expect(lineFor(list, 'pasta')).toBeUndefined();
  });
});

describe('ticks survive the plan changing underneath them', () => {
  const r = recipe('r-1', 'Pasta', '300g pasta\n1 onion');
  const base = () =>
    input({
      recipes: [r],
      placements: [place('p1', r, TUE, 'dinner')],
      ticks: [tick('sess-1', 'pasta', true, { quantityAtTick: 300, unitAtTick: 'g' })],
    });

  it('keeps a tick when an unrelated meal is added', () => {
    const other = recipe('r-2', 'Soup', '2 carrots');
    const list = deriveShoppingList({
      ...base(),
      recipes: [r, other],
      placements: [
        place('p1', r, TUE, 'dinner'),
        place('p2', other, THU, 'dinner'),
      ],
    });

    expect(lineFor(list, 'pasta')!.ticked).toBe(true);
    expect(lineFor(list, 'carrot')!.ticked).toBe(false);
  });

  it('flags a ticked row whose quantity grew, rather than silently changing it', () => {
    const list = deriveShoppingList({
      ...base(),
      placements: [place('p1', r, TUE, 'dinner', { multiplier: 2 })],
    });

    const pasta = lineFor(list, 'pasta')!;
    expect(pasta.displayQuantity).toBe('600 g');
    expect(pasta.ticked).toBe(true);
    expect(pasta.reopened).toBe(true);
  });

  it('stays quiet when the quantity shrinks, because you already have enough', () => {
    const list = deriveShoppingList({
      ...base(),
      placements: [place('p1', r, TUE, 'dinner', { multiplier: 0.5 })],
    });

    const pasta = lineFor(list, 'pasta')!;
    expect(pasta.ticked).toBe(true);
    expect(pasta.reopened).toBe(false);
  });

  it('drops a ticked item once the meal that needed it leaves the plan', () => {
    // Ticked or not, the plan no longer justifies it, so it leaves the list.
    const list = deriveShoppingList({ ...base(), placements: [] });

    expect(lineFor(list, 'pasta')).toBeUndefined();
    expect(list.counts.total).toBe(0);
  });

  it('keeps ticks across a swap of the meal that produced them', () => {
    const other = recipe('r-2', 'Risotto', '300g pasta\n2 tins butter beans');
    const list = deriveShoppingList({
      ...base(),
      recipes: [r, other],
      placements: [place('p2', other, TUE, 'dinner')],
    });

    // Different recipe, different day, same ingredient -> same lineKey, tick holds.
    expect(lineFor(list, 'pasta')!.ticked).toBe(true);
  });
});

describe('lines struck off by hand', () => {
  const r = recipe('r-1', 'Pasta', '300g pasta\n1 onion');
  const base = () =>
    input({
      recipes: [r],
      placements: [place('p1', r, TUE, 'dinner')],
      session: session('sess-1', MON, SUN),
    });

  it('hides a line the user struck off', () => {
    const list = deriveShoppingList({
      ...base(),
      ticks: [tick('sess-1', 'pasta', false, { removed: true })],
    });

    expect(lineFor(list, 'pasta')).toBeUndefined();
    expect(lineFor(list, 'onion')).toBeDefined();
  });

  it('keeps a struck-off line out even when it is ticked, and out of the counts', () => {
    // Removal and "already in the trolley" are independent facts, so a row can
    // be both. If `removed` didn't win here the list could never read as done.
    const list = deriveShoppingList({
      ...base(),
      ticks: [tick('sess-1', 'pasta', true, { removed: true })],
    });

    expect(lineFor(list, 'pasta')).toBeUndefined();
    expect(list.counts.ticked).toBe(0);
    expect(list.counts.total).toBe(1);
  });

  it('ignores a removal belonging to a different session', () => {
    const list = deriveShoppingList({
      ...base(),
      ticks: [tick('sess-2', 'pasta', false, { removed: true })],
    });

    expect(lineFor(list, 'pasta')).toBeDefined();
  });
});

describe('list structure', () => {
  it('groups lines into aisles and pins staples last', () => {
    const r = recipe('r-1', 'Dinner', '2 onions\n400g cherry tomatoes\nSalt and black pepper');
    const list = deriveShoppingList(
      input({ recipes: [r], placements: [place('p1', r, TUE, 'dinner')] }),
    );

    expect(list.groups.length).toBeGreaterThan(0);
    const last = list.groups[list.groups.length - 1]!;
    expect(last.category).toBe('staples');
  });

  it('folds a manual item into the same row as a recipe ingredient', () => {
    const r = recipe('r-1', 'Dinner', '2 onions');
    const list = deriveShoppingList(
      input({
        recipes: [r],
        placements: [place('p1', r, TUE, 'dinner')],
        manualItems: [manualItem('m1', '3 onions', 'sess-1')],
      }),
    );

    const onions = allLines(list).filter((l) => l.lineKey === 'onion');
    expect(onions).toHaveLength(1);
    expect(onions[0]!.components).toHaveLength(2);
  });

  it('counts what is on the list', () => {
    const r = recipe('r-1', 'Dinner', '2 onions\n300g pasta');
    const list = deriveShoppingList(
      input({
        recipes: [r],
        placements: [place('p1', r, TUE, 'dinner')],
        ticks: [tick('sess-1', 'pasta', true, { quantityAtTick: 300, unitAtTick: 'g' })],
      }),
    );

    expect(list.counts.total).toBe(2);
    expect(list.counts.ticked).toBe(1);
  });
});

describe('order independence', () => {
  // Sync delivers entities in nondeterministic order, so the list must not
  // depend on the order components happen to arrive in.
  it('produces an identical list regardless of placement order', () => {
    const a = recipe('r-a', 'A', '2 tins butter beans\n1 onion');
    const b = recipe('r-b', 'B', '400g butter beans\n300g pasta');
    const c = recipe('r-c', 'C', '2 onions\nSalt and pepper');
    const ps = [
      place('p1', a, MON, 'dinner'),
      place('p2', b, TUE, 'lunch', { multiplier: 2 }),
      place('p3', c, THU, 'dinner'),
    ];

    const forward = deriveShoppingList(input({ recipes: [a, b, c], placements: ps }));
    const reversed = deriveShoppingList(
      input({ recipes: [c, b, a], placements: [...ps].reverse() }),
    );

    const summarise = (l: DerivedShoppingList) =>
      allLines(l)
        .map((x) => `${x.lineKey}|${x.displayQuantity}|${x.category}`)
        .sort();

    expect(summarise(reversed)).toEqual(summarise(forward));
  });
});
