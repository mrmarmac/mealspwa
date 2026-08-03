/**
 * Turning a plan into a flat list of contributions.
 *
 * Leftover placements produce components with scale 0. They are deliberately
 * kept rather than filtered: the shopping list's provenance panel should still
 * say "Wednesday's dinner is the leftovers from Tuesday", and a component that
 * quietly disappeared would make that impossible to explain.
 */
import { isLive } from '@/domain/sync';
import type { ISODate } from '@/domain/primitives';
import type {
  AltMeasure,
  LineComponent,
  ManualItem,
  MeasurementDialect,
  ParsedIngredientLine,
  Placement,
  Recipe,
  SpaceSettings,
} from '@/domain/types';
import { applyOverrides } from '@/parser/index';
import { componentScale } from './scale';

/**
 * A LineComponent that also carries the identity fields merging needs.
 * Structurally still a LineComponent, so it satisfies ShoppingLine.components.
 */
export interface ResolvedComponent extends LineComponent {
  itemKey: string;
  item: string;
  clarifier: string | null;
  excluded: boolean;
  alternates: AltMeasure[];
}

export interface CollectInput {
  placements: Placement[];
  recipes: Recipe[];
  manualItems: ManualItem[];
  settings: SpaceSettings;
  fromDate: ISODate;
  toDate: ISODate;
  /** The session being shopped; manual items with a null sessionId always apply. */
  sessionId?: string;
}

function toComponent(
  line: ParsedIngredientLine,
  scale: number,
  meta: {
    placementId: string;
    recipeId: string | null;
    recipeName: string;
    date: ISODate;
    mealType: LineComponent['mealType'];
    source: 'recipe' | 'manual';
    dialect: MeasurementDialect;
  },
): ResolvedComponent {
  return {
    placementId: meta.placementId,
    recipeId: meta.recipeId,
    recipeName: meta.recipeName,
    date: meta.date,
    mealType: meta.mealType,
    lineKey: line.lineKey,
    rawText: line.rawText,
    scale,
    quantity: line.quantity,
    unit: line.unit,
    unitKind: line.unitKind,
    packSize: line.packSize,
    qualifiers: line.qualifiers,
    confidence: line.confidence,
    source: meta.source,
    dialect: meta.dialect,
    itemKey: line.itemKey,
    item: line.item,
    clarifier: line.clarifier,
    excluded: line.excluded,
    alternates: line.alternates,
  };
}

export function collectComponents(input: CollectInput): ResolvedComponent[] {
  const { placements, recipes, manualItems, settings, fromDate, toDate } = input;
  const recipeById = new Map<string, Recipe>();
  for (const r of recipes) if (isLive(r)) recipeById.set(r.id, r);

  const out: ResolvedComponent[] = [];

  const inRange = (d: ISODate): boolean => d >= fromDate && d <= toDate;

  const ordered = [...placements].sort((a, b) =>
    a.date === b.date
      ? a.slot === b.slot
        ? a.position - b.position || a.id.localeCompare(b.id)
        : a.slot.localeCompare(b.slot)
      : a.date.localeCompare(b.date),
  );

  for (const p of ordered) {
    if (!isLive(p)) continue;
    if (!inRange(p.date)) continue;
    const recipe = p.recipeId ? recipeById.get(p.recipeId) : undefined;
    if (!recipe) continue;
    const dialect: MeasurementDialect = recipe.dialect ?? settings.dialect;
    const lines = applyOverrides(recipe.ingredients, recipe.overrides);
    for (const line of lines) {
      if (line.isHeader) continue;
      if (!line.itemKey) continue;
      const scale = componentScale(p, line, settings);
      out.push(
        toComponent(line, scale, {
          placementId: p.id,
          recipeId: recipe.id,
          recipeName: recipe.name || p.recipeNameSnapshot,
          date: p.date,
          mealType: p.mealType,
          source: 'recipe',
          dialect,
        }),
      );
    }
  }

  for (const m of manualItems) {
    if (!isLive(m)) continue;
    if (m.sessionId !== null && input.sessionId !== undefined && m.sessionId !== input.sessionId) {
      continue;
    }
    if (!m.parsed.itemKey) continue;
    out.push(
      toComponent(m.parsed, 1, {
        placementId: m.id,
        recipeId: null,
        recipeName: 'Added by hand',
        date: fromDate,
        mealType: 'dinner',
        source: 'manual',
        dialect: settings.dialect,
      }),
    );
  }

  return out;
}
