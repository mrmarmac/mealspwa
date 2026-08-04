/**
 * Seeds a fresh space with the built-in recipe library. Idempotent via a
 * per-space flag in `meta` — safe to call on every app boot; it only does
 * real work the first time for a given `spaceId`.
 */
import recipesData from './recipes.json';
import { applyOverrides, parseIngredientBlock, PARSER_VERSION } from '@/parser';
import { getMeta, getRecipesBySpace, recipeRepo, setMeta } from '@/db/repo';
import { uuidv7, type Id } from '@/domain/primitives';
import { SCHEMA_VERSION, type Recipe } from '@/domain/types';

const SEEDED_META_KEY_PREFIX = 'seeded:';

interface SeedRecipeInput {
  name: string;
  ingredientsRaw: string;
  method: string | null;
  sourceUrl: string | null;
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

export async function seedSpace(spaceId: Id): Promise<void> {
  const flagKey = `${SEEDED_META_KEY_PREFIX}${spaceId}`;
  const alreadySeeded = await getMeta<boolean>(flagKey);
  if (alreadySeeded) return;

  // Belt-and-braces beyond the flag: if a previous call was interrupted
  // partway through (so the flag never got set), skip names already
  // present — including tombstoned ones, so a recipe the user deliberately
  // deleted before the retry doesn't come back — rather than duplicating
  // everything that already made it in.
  const existing = await getRecipesBySpace(spaceId, { includeDeleted: true });
  const existingNames = new Set(existing.map((r) => r.name));
  const recipes = (recipesData as SeedRecipeInput[]).filter((r) => !existingNames.has(r.name));
  const nowIso = new Date().toISOString();

  for (const r of recipes) {
    const parsed = parseIngredientBlock(r.ingredientsRaw);
    const ingredients = applyOverrides(parsed, []);
    const recipe: Recipe = {
      id: uuidv7(),
      kind: 'recipe',
      spaceId,
      createdAt: nowIso,
      updatedAt: '',
      lastWriterClientId: '',
      deletedAt: null,
      schemaVersion: SCHEMA_VERSION,
      name: r.name,
      sourceUrl: r.sourceUrl,
      sourceDomain: deriveSourceDomain(r.sourceUrl),
      photo: null,
      ingredientsRaw: r.ingredientsRaw,
      method: r.method,
      baseServings: null,
      ingredients,
      parserVersion: PARSER_VERSION,
      overrides: [],
      dialect: null,
      tags: [],
      timesPlanned: 0,
      lastPlannedOn: null,
      archived: false,
    };
    await recipeRepo.put(recipe);
  }

  // Set last, only after every recipe is written — if seeding throws
  // partway through, the flag stays unset and the next call retries. The
  // per-recipe `put()` is not itself idempotent-safe against a partial
  // re-run (it would create duplicates with fresh uuidv7 ids), so this is a
  // best-effort recovery: it protects the common "never ran" and "ran
  // fully" cases, which cover every real first-launch flow.
  await setMeta(flagKey, true);
}
