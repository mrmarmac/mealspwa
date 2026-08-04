/**
 * The recipe library: list, search, and the write path that keeps the
 * derived `ingredients` cache in sync with `ingredientsRaw` + overrides +
 * the parser version.
 */
import { create } from 'zustand';
import { applyOverrides, parseIngredientBlock, PARSER_VERSION } from '@/parser';
import { getRecipesBySpace, recipeRepo } from '@/db/repo';
import { uuidv7, type Id } from '@/domain/primitives';
import {
  SCHEMA_VERSION,
  type IngredientOverride,
  type MeasurementDialect,
  type PhotoRef,
  type Recipe,
} from '@/domain/types';

const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;

function normalize(s: string): string {
  return s.normalize('NFKD').replace(COMBINING_MARKS_RE, '').trim().toLowerCase();
}

function deriveSourceDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

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

function matchesQuery(recipe: Recipe, normalizedQuery: string): boolean {
  if (normalize(recipe.name).includes(normalizedQuery)) return true;
  if (recipe.tags.some((tag) => normalize(tag).includes(normalizedQuery))) return true;
  if (recipe.ingredients.some((line) => normalize(line.itemKey).includes(normalizedQuery))) {
    return true;
  }
  return false;
}

/** Re-run the parser over `ingredientsRaw`, apply the given overrides on
 *  top, and persist. This is the ONLY path that writes `ingredients` /
 *  `parserVersion` — anything that changes raw text or overrides must go
 *  through it so the cache never drifts from its inputs. */
async function reparseAndSave(recipe: Recipe, overrides: IngredientOverride[]): Promise<Recipe> {
  const parsed = parseIngredientBlock(recipe.ingredientsRaw, {
    dialect: recipe.dialect ?? undefined,
  });
  const ingredients = applyOverrides(parsed, overrides);
  const next: Recipe = {
    ...recipe,
    ingredients,
    overrides,
    parserVersion: PARSER_VERSION,
  };
  return recipeRepo.put(next);
}

export interface SaveRecipeInput {
  /** Omit to create a new recipe; include an existing id to update it. */
  id?: Id;
  spaceId: Id;
  name: string;
  sourceUrl?: string | null;
  photo?: PhotoRef | null;
  ingredientsRaw: string;
  method?: string | null;
  baseServings?: number | null;
  dialect?: MeasurementDialect | null;
  tags?: string[];
}

interface RecipeStoreState {
  recipes: Recipe[];
  loading: boolean;
  loaded: boolean;
  error: string | null;

  load(spaceId: Id): Promise<void>;
  search(query: string): Recipe[];
  saveRecipe(input: SaveRecipeInput): Promise<Recipe>;
  deleteRecipe(recipeId: Id): Promise<void>;
  archiveRecipe(recipeId: Id, archived?: boolean): Promise<Recipe | undefined>;
  /** Upserts a single override by `lineKey`, then re-parses so the change is
   *  reflected in `ingredients` immediately. */
  setOverride(recipeId: Id, override: IngredientOverride): Promise<Recipe | undefined>;
}

export const useRecipeStore = create<RecipeStoreState>((set, get) => ({
  recipes: [],
  loading: false,
  loaded: false,
  error: null,

  async load(spaceId) {
    set({ loading: true, error: null });
    try {
      const recipes = await getRecipesBySpace(spaceId);
      set({ recipes, loading: false, loaded: true });
    } catch (err) {
      set({ error: errorMessage(err), loading: false });
    }
  },

  search(query) {
    const q = normalize(query);
    const recipes = get().recipes;
    if (q === '') return recipes;
    return recipes.filter((r) => matchesQuery(r, q));
  },

  async saveRecipe(input) {
    const existing = input.id
      ? (get().recipes.find((r) => r.id === input.id) ?? (await recipeRepo.get(input.id)))
      : undefined;

    const nowIso = new Date().toISOString();
    const base: Recipe =
      existing ??
      {
        id: input.id ?? uuidv7(),
        kind: 'recipe',
        spaceId: input.spaceId,
        createdAt: nowIso,
        updatedAt: '',
        lastWriterClientId: '',
        deletedAt: null,
        schemaVersion: SCHEMA_VERSION,
        name: input.name,
        sourceUrl: null,
        sourceDomain: null,
        photo: null,
        ingredientsRaw: '',
        method: null,
        baseServings: null,
        ingredients: [],
        parserVersion: PARSER_VERSION,
        overrides: [],
        dialect: null,
        tags: [],
        timesPlanned: 0,
        lastPlannedOn: null,
        archived: false,
      };

    const sourceUrl = input.sourceUrl ?? null;
    const merged: Recipe = {
      ...base,
      name: input.name,
      sourceUrl,
      sourceDomain: deriveSourceDomain(sourceUrl),
      photo: input.photo ?? base.photo,
      ingredientsRaw: input.ingredientsRaw,
      method: input.method ?? null,
      baseServings: input.baseServings ?? null,
      dialect: input.dialect ?? base.dialect,
      tags: input.tags ?? base.tags,
    };

    const saved = await reparseAndSave(merged, base.overrides);
    set((s) => ({ recipes: replaceInList(s.recipes, saved) }));
    return saved;
  },

  async deleteRecipe(recipeId) {
    await recipeRepo.remove(recipeId);
    set((s) => ({ recipes: s.recipes.filter((r) => r.id !== recipeId) }));
  },

  async archiveRecipe(recipeId, archived = true) {
    const existing = get().recipes.find((r) => r.id === recipeId) ?? (await recipeRepo.get(recipeId));
    if (!existing) return undefined;
    const saved = await recipeRepo.put({ ...existing, archived });
    set((s) => ({ recipes: replaceInList(s.recipes, saved) }));
    return saved;
  },

  async setOverride(recipeId, override) {
    const existing = get().recipes.find((r) => r.id === recipeId) ?? (await recipeRepo.get(recipeId));
    if (!existing) return undefined;

    const nextOverrides = [
      ...existing.overrides.filter((o) => o.lineKey !== override.lineKey),
      override,
    ];
    const saved = await reparseAndSave(existing, nextOverrides);
    set((s) => ({ recipes: replaceInList(s.recipes, saved) }));
    return saved;
  },
}));
