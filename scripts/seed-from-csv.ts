/**
 * Reads `data/meal-list.csv` (Dish/Ingredients/Method/Link, RFC4180 quoted,
 * embedded newlines) and writes `src/seed/recipes.json`: a plain array of
 * `{ name, ingredientsRaw, method, sourceUrl }` ready for `seedSpace()` to
 * turn into real Recipe entities (parsing happens at seed time, not here, so
 * the JSON stays parser-version-agnostic).
 *
 * Run with: npx tsx scripts/seed-from-csv.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseRecipeCsv } from '../src/import/csv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = resolve(__dirname, '..', 'data', 'meal-list.csv');
const OUT_PATH = resolve(__dirname, '..', 'src', 'seed', 'recipes.json');

function main(): void {
  const text = readFileSync(CSV_PATH, 'utf-8');
  const preview = parseRecipeCsv(text);

  if (preview.warnings.length > 0) {
    for (const w of preview.warnings) {
      console.warn(`[seed-from-csv] ${w}`);
    }
  }

  const out = preview.rows.map((r) => ({
    name: r.name,
    ingredientsRaw: r.ingredientsRaw,
    method: r.method,
    sourceUrl: r.sourceUrl,
  }));

  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  console.log(`[seed-from-csv] wrote ${out.length} recipes to ${OUT_PATH}`);
}

main();
