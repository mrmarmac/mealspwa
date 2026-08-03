/**
 * The user's real 39-recipe library, read straight from the CSV they exported.
 * This is the corpus the parser is actually judged against — synthetic examples
 * are useful for pinning individual rules, but only the real file contains the
 * typos, the mixed dialects and the seven different ways of writing a
 * tablespoon.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface CorpusRecipe {
  dish: string;
  ingredients: string;
  method: string;
  link: string;
}

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

export function corpusPath(): string {
  return fileURLToPath(new URL('../../data/meal-list.csv', import.meta.url));
}

export function loadCorpus(): CorpusRecipe[] {
  const rows = parseCsv(readFileSync(corpusPath(), 'utf8'));
  const [, ...body] = rows;
  return body.map((r) => ({
    dish: r[0] ?? '',
    ingredients: r[1] ?? '',
    method: r[2] ?? '',
    link: r[3] ?? '',
  }));
}

/** Every distinct ingredient line in the library, in first-seen order. */
export function distinctIngredientLines(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of loadCorpus()) {
    for (const raw of r.ingredients.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const key = line.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }
  return out;
}
