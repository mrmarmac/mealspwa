/**
 * Deterministic fixtures. No uuidv7, no Date.now: a test that produces a
 * different id on every run cannot assert on ordering or on lineKeys.
 */
import type { ClientId, HLC, Id, ISODate, ISODateTime } from '@/domain/primitives';
import { tickId } from '@/domain/sync';
import {
  DEFAULT_SETTINGS,
  makeSlotId,
  SCHEMA_VERSION,
  type ItemMeta,
  type ManualItem,
  type MealType,
  type PackSizeMemory,
  type Placement,
  type Recipe,
  type ShoppingSession,
  type ShoppingTick,
  type SpaceSettings,
} from '@/domain/types';
import { parseIngredientBlock, parseIngredientLine, type ParseContext } from '@/parser/index';

export const SPACE_ID: Id = 'space-1';
export const CLIENT_ID: ClientId = 'client-a';

let counter = 0;
export function resetIds(): void {
  counter = 0;
}
function nextHlc(): HLC {
  counter += 1;
  return `${String(counter).padStart(18, '0')}-0000-${CLIENT_ID}`;
}

const NOW: ISODateTime = '2026-08-03T09:00:00.000Z';

function syncable(id: Id, kind: string) {
  return {
    id,
    kind,
    spaceId: SPACE_ID,
    createdAt: NOW,
    updatedAt: nextHlc(),
    lastWriterClientId: CLIENT_ID,
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
  } as const;
}

export function settings(overrides: Partial<SpaceSettings> = {}): SpaceSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

export function recipe(id: Id, name: string, ingredientsRaw: string, extra: Partial<Recipe> = {}): Recipe {
  return {
    ...syncable(id, 'recipe'),
    kind: 'recipe',
    name,
    sourceUrl: null,
    sourceDomain: null,
    photo: null,
    ingredientsRaw,
    method: null,
    baseServings: null,
    ingredients: parseIngredientBlock(ingredientsRaw),
    parserVersion: 1,
    overrides: [],
    dialect: null,
    tags: [],
    timesPlanned: 0,
    lastPlannedOn: null,
    archived: false,
    ...extra,
  };
}

export function placement(
  id: Id,
  recipeId: Id | null,
  date: ISODate,
  mealType: MealType = 'dinner',
  extra: Partial<Placement> = {},
): Placement {
  return {
    ...syncable(id, 'placement'),
    kind: 'placement',
    date,
    mealType,
    slot: makeSlotId(date, mealType),
    position: 0,
    recipeId,
    recipeNameSnapshot: recipeId ?? '',
    freeText: null,
    source: 'cook',
    leftoverOf: null,
    multiplier: 1,
    notes: null,
    ...extra,
  };
}

export function leftoverOf(id: Id, source: Placement, date: ISODate, mealType: MealType = 'lunch'): Placement {
  return placement(id, source.recipeId, date, mealType, {
    source: 'leftover',
    leftoverOf: source.id,
    multiplier: 1,
  });
}

export function session(id: Id, fromDate: ISODate, toDate: ISODate): ShoppingSession {
  return {
    ...syncable(id, 'shoppingSession'),
    kind: 'shoppingSession',
    fromDate,
    toDate,
    status: 'active',
    startedAt: NOW,
  };
}

export function tick(
  sessionId: Id,
  lineKey: string,
  ticked: boolean,
  snapshot: Partial<ShoppingTick> = {},
): ShoppingTick {
  return {
    ...syncable(tickId(sessionId, lineKey), 'shoppingTick'),
    kind: 'shoppingTick',
    sessionId,
    lineKey,
    ticked,
    tickedAt: ticked ? NOW : null,
    quantityAtTick: null,
    unitAtTick: null,
    displayNameAtTick: lineKey,
    displayQuantityAtTick: '',
    ...snapshot,
  };
}

export function itemMeta(itemKey: string, overrides: Partial<ItemMeta> = {}): ItemMeta {
  return {
    ...syncable(`item:${itemKey}`, 'itemMeta'),
    kind: 'itemMeta',
    itemKey,
    displayName: null,
    category: null,
    pantryStaple: false,
    halvable: false,
    aliasOf: null,
    ...overrides,
  };
}

export function packSize(
  itemKey: string,
  container: PackSizeMemory['container'],
  size: number,
  unit: PackSizeMemory['unit'],
  assumed = false,
): PackSizeMemory {
  return {
    ...syncable(`pack:${itemKey}:${container}`, 'packSize'),
    kind: 'packSize',
    itemKey,
    container,
    size,
    unit,
    assumed,
  };
}

export function manualItem(id: Id, rawText: string, sessionId: Id | null = null): ManualItem {
  const parsed = parseLine(rawText);
  return {
    ...syncable(id, 'manualItem'),
    kind: 'manualItem',
    sessionId,
    rawText,
    parsed,
    lineKey: parsed.lineKey,
  };
}

/** Parses one line with a plain context — the shorthand every test wants. */
export function parseLine(raw: string, ctx: Partial<ParseContext> = {}) {
  const full: ParseContext = {
    dialect: 'metric-uk',
    section: null,
    next: '1 tbsp oil',
    occurrenceIndex: 0,
    ...ctx,
  };
  return parseIngredientLine(raw, full);
}
