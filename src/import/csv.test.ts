import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectDelimiter,
  normaliseSourceUrl,
  parseDelimited,
  parseRecipeCsv,
  parseRecipePaste,
} from './csv';

const CSV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'meal-list.csv');

describe('parseDelimited (RFC4180)', () => {
  it('splits simple comma rows', () => {
    expect(parseDelimited('a,b,c\n1,2,3', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('keeps the delimiter and newlines literal inside a quoted field', () => {
    const text = 'name,note\n"Soup","line1\nline2, still one field"';
    expect(parseDelimited(text, ',')).toEqual([
      ['name', 'note'],
      ['Soup', 'line1\nline2, still one field'],
    ]);
  });

  it('unescapes doubled quotes as a literal quote', () => {
    expect(parseDelimited('"She said ""hi"""', ',')).toEqual([['She said "hi"']]);
  });

  it('handles a final record with no trailing newline', () => {
    expect(parseDelimited('a,b\nc,d', ',')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('returns no rows for empty input', () => {
    expect(parseDelimited('', ',')).toEqual([]);
  });

  it('supports tab delimiter', () => {
    expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('detectDelimiter', () => {
  it('detects comma-delimited text', () => {
    expect(detectDelimiter('Dish,Ingredients,Method,Link')).toBe(',');
  });

  it('detects tab-delimited text', () => {
    expect(detectDelimiter('Dish\tIngredients\tMethod\tLink')).toBe('\t');
  });
});

describe('normaliseSourceUrl', () => {
  it('returns null for empty text', () => {
    expect(normaliseSourceUrl('')).toBeNull();
    expect(normaliseSourceUrl('   ')).toBeNull();
  });

  it('returns null for text that is not a URL', () => {
    expect(normaliseSourceUrl('Quinoa, Corn, and Black Bean Salad')).toBeNull();
  });

  it('picks the first URL when a cell has two, separated by a blank line', () => {
    const cell =
      'https://www.tiktok.com/@dennistheprescott/video/7265061448127106309\n\nhttps://www.youtube.com/watch?v=wg-KowGfKdw';
    expect(normaliseSourceUrl(cell)).toBe(
      'https://www.tiktok.com/@dennistheprescott/video/7265061448127106309',
    );
  });

  it('passes through a single clean URL', () => {
    expect(normaliseSourceUrl('https://example.com/recipe')).toBe('https://example.com/recipe');
  });
});

describe('parseRecipeCsv against the real data/meal-list.csv', () => {
  const text = readFileSync(CSV_PATH, 'utf-8');
  const preview = parseRecipeCsv(text);

  it('parses with no warnings about missing columns', () => {
    expect(preview.warnings.filter((w) => w.includes('column'))).toEqual([]);
  });

  it('parses to the row count actually present in the committed file', () => {
    // An independent RFC4180-compliant parse of the file as committed
    // (verified with Python's csv module) yields 33 recipe rows, not 39 —
    // this assertion tracks the real file's content. See the final report
    // for detail; if `data/meal-list.csv` is later replaced with a 39-row
    // version this number should be revisited.
    expect(preview.rows).toHaveLength(33);
  });

  it('gets the first and last dish names right', () => {
    expect(preview.rows[0]?.name).toBe('hot-honey harissa chickpea salad');
    expect(preview.rows[preview.rows.length - 1]?.name).toBe('Roast chicken and veg');
  });

  it('preserves embedded newlines inside ingredients', () => {
    const first = preview.rows[0];
    expect(first?.ingredientsRaw).toContain('\n');
    expect(first?.ingredientsRaw).toContain('Dressing');
    expect(first?.ingredientsRaw).toContain('6 tbs harissa');
  });

  it('takes the first URL when a link cell has two, separated by a blank line', () => {
    const row = preview.rows.find((r) => r.name === 'Roasted tomato soup');
    expect(row).toBeDefined();
    expect(row?.sourceUrl).toBe(
      'https://www.tiktok.com/@dennistheprescott/video/7265061448127106309',
    );
  });

  it('treats a non-URL link cell as null', () => {
    const row = preview.rows.find((r) => r.name.toLowerCase().includes('quinoa'));
    expect(row).toBeDefined();
    expect(row?.sourceUrl).toBeNull();
  });

  it('treats a blank Method cell as null, not empty string', () => {
    const row = preview.rows.find((r) => r.name === 'hot-honey harissa chickpea salad');
    expect(row?.method).toBeNull();
  });
});

describe('parseRecipeCsv header mapping and duplicate detection', () => {
  it('maps case-insensitive header synonyms', () => {
    const csv = 'Title,Ingredients,Instructions,Source\nToast,"bread\nbutter",Toast it,https://x.example';
    const preview = parseRecipeCsv(csv);
    expect(preview.rows).toEqual([
      { name: 'Toast', ingredientsRaw: 'bread\nbutter', method: 'Toast it', sourceUrl: 'https://x.example' },
    ]);
  });

  it('flags rows whose name matches an existing recipe, case/whitespace-insensitively', () => {
    const csv = 'Dish,Ingredients\n  Soup  ,water';
    const preview = parseRecipeCsv(csv, ['soup']);
    expect(preview.duplicateOfExistingName).toEqual(['Soup']);
  });

  it('auto-detects a tab-separated export', () => {
    const tsv = 'Dish\tIngredients\nToast\tbread';
    const preview = parseRecipeCsv(tsv);
    expect(preview.rows).toEqual([{ name: 'Toast', ingredientsRaw: 'bread', method: null, sourceUrl: null }]);
  });
});

describe('parseRecipePaste', () => {
  it('splits name / ingredients / method on a Method heading', () => {
    const text = 'My Soup\n1 onion\n2 carrots\nMethod\nChop everything.\nSimmer.';
    const preview = parseRecipePaste(text);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]?.name).toBe('My Soup');
    expect(preview.rows[0]?.ingredientsRaw).toBe('1 onion\n2 carrots');
    expect(preview.rows[0]?.method).toBe('Chop everything.\nSimmer.');
  });

  it('recognises Instructions/Directions/Steps headings too', () => {
    for (const heading of ['Instructions', 'Directions', 'Steps', 'method:']) {
      const preview = parseRecipePaste(`Name\ningredient\n${heading}\nDo it.`);
      expect(preview.rows[0]?.method).toBe('Do it.');
    }
  });

  it('handles no method section at all', () => {
    const preview = parseRecipePaste('Just a name\nonion\ncarrot');
    expect(preview.rows[0]?.method).toBeNull();
    expect(preview.rows[0]?.ingredientsRaw).toBe('onion\ncarrot');
  });

  it('skips leading blank lines before the name', () => {
    const preview = parseRecipePaste('\n\nName\ningredient');
    expect(preview.rows[0]?.name).toBe('Name');
  });
});
