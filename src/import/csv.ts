/**
 * A small, correct RFC4180 parser plus the recipe-import mapping built on top
 * of it. Shared by `scripts/seed-from-csv.ts` and the in-app CSV/TSV import
 * flow — both need the exact same "quoted fields may contain the delimiter,
 * newlines, and doubled quotes" behaviour, so it lives in one place.
 */

/**
 * Parse RFC4180-style delimited text into rows of raw string cells.
 *
 * Rules implemented:
 *  - A field may be wrapped in double quotes. Inside a quoted field the
 *    delimiter and newlines (both \n and \r\n) are literal.
 *  - A doubled quote ("") inside a quoted field is an escaped literal quote.
 *  - A record ends at an unquoted \n or \r\n.
 *  - Trailing fields are not padded; the last record does not need a
 *    trailing newline.
 *  - A wholly empty input yields zero rows.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  if (text.length === 0) return rows;

  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  let sawAnyFieldInRow = false;

  const pushField = () => {
    row.push(field);
    field = '';
    sawAnyFieldInRow = true;
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    sawAnyFieldInRow = false;
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // Treat \r\n and lone \r as a row break.
      if (text[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // Flush the final field/row if the file doesn't end with a newline.
  if (field.length > 0 || sawAnyFieldInRow || row.length > 0) {
    pushRow();
  }

  return rows;
}

/** Guess whether the text is comma- or tab-delimited by counting occurrences
 *  of each in the header line (the portion before the first newline that is
 *  not inside quotes — approximated by the first physical line, which is
 *  correct for every real header we expect to see). */
export function detectDelimiter(text: string): ',' | '\t' {
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? '';
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? '\t' : ',';
}

// ---------------------------------------------------------------------------
// Recipe import mapping
// ---------------------------------------------------------------------------

export interface ImportRow {
  name: string;
  ingredientsRaw: string;
  method: string | null;
  sourceUrl: string | null;
}

export interface ImportPreview {
  rows: ImportRow[];
  warnings: string[];
  /** Names in `rows` that match an existing recipe name (case/whitespace
   *  insensitive), so the UI can offer to skip or merge instead of
   *  duplicating. */
  duplicateOfExistingName: string[];
}

const NAME_HEADERS = ['dish', 'name', 'title'];
const INGREDIENTS_HEADERS = ['ingredients'];
const METHOD_HEADERS = ['method', 'instructions', 'directions'];
const SOURCE_HEADERS = ['link', 'url', 'source'];

function classifyHeader(h: string): keyof ImportRow | null {
  const norm = h.trim().toLowerCase();
  if (NAME_HEADERS.includes(norm)) return 'name';
  if (INGREDIENTS_HEADERS.includes(norm)) return 'ingredientsRaw';
  if (METHOD_HEADERS.includes(norm)) return 'method';
  if (SOURCE_HEADERS.includes(norm)) return 'sourceUrl';
  return null;
}

const URL_RE = /^https?:\/\/\S+$/i;

/** A cell sometimes contains two URLs separated by a blank line (a user
 *  pasted an alternate link below the first) — take the first line that
 *  looks like a URL. A cell that isn't a URL at all (a stray label pasted
 *  into the wrong column) becomes null rather than being kept as garbage. */
export function normaliseSourceUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const candidates = trimmed
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const firstUrl = candidates.find((c) => URL_RE.test(c));
  return firstUrl ?? null;
}

const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;

export function existingNameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(COMBINING_MARKS_RE, '')
    .trim()
    .toLowerCase();
}

/** Parse a full CSV/TSV recipe export into an import preview. Does not write
 *  anything — the caller decides which rows to actually import. */
export function parseRecipeCsv(text: string, existingNames: string[] = []): ImportPreview {
  const delimiter = detectDelimiter(text);
  const table = parseDelimited(text, delimiter);
  const warnings: string[] = [];
  const rows: ImportRow[] = [];

  if (table.length === 0) {
    return { rows, warnings: ['File is empty.'], duplicateOfExistingName: [] };
  }

  const header = table[0]!;
  const colRoles = header.map(classifyHeader);
  if (!colRoles.includes('name')) {
    warnings.push('No name/dish/title column found.');
  }
  if (!colRoles.includes('ingredientsRaw')) {
    warnings.push('No ingredients column found.');
  }

  for (let r = 1; r < table.length; r++) {
    const cells = table[r]!;
    // Skip fully blank rows (a single empty cell from a trailing newline).
    if (cells.length === 1 && cells[0] === '') continue;

    let name = '';
    let ingredientsRaw = '';
    let method: string | null = null;
    let sourceUrl: string | null = null;

    for (let c = 0; c < colRoles.length; c++) {
      const role = colRoles[c];
      if (!role) continue;
      const value = cells[c] ?? '';
      if (role === 'name') name = value.trim();
      else if (role === 'ingredientsRaw') ingredientsRaw = value;
      else if (role === 'method') method = value.trim() === '' ? null : value;
      else if (role === 'sourceUrl') sourceUrl = normaliseSourceUrl(value);
    }

    if (name === '' && ingredientsRaw.trim() === '') continue;
    if (name === '') {
      warnings.push(`Row ${r + 1} has no name; skipped.`);
      continue;
    }

    rows.push({ name, ingredientsRaw, method, sourceUrl });
  }

  const existingKeys = new Set(existingNames.map(existingNameKey));
  const duplicateOfExistingName = rows
    .map((row) => row.name)
    .filter((name) => existingKeys.has(existingNameKey(name)));

  return { rows, warnings, duplicateOfExistingName };
}

const SECTION_BREAK_RE = /^(method|instructions|directions|steps)\b/i;

/** Parse a single pasted recipe: first non-empty line is the name, then
 *  ingredient lines accumulate until a line that looks like a section
 *  heading for the method ('Method', 'Instructions', 'Directions', 'Steps',
 *  optionally followed by a colon), after which everything remaining is the
 *  method body. */
export function parseRecipePaste(text: string): ImportPreview {
  const lines = text.split(/\r\n|\r|\n/);
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++;

  if (i >= lines.length) {
    return { rows: [], warnings: ['Pasted text is empty.'], duplicateOfExistingName: [] };
  }

  const name = (lines[i] ?? '').trim();
  i++;

  const ingredientLines: string[] = [];
  let methodStartIndex = -1;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (SECTION_BREAK_RE.test(line.trim())) {
      methodStartIndex = i + 1;
      break;
    }
    ingredientLines.push(line);
  }

  let method: string | null = null;
  if (methodStartIndex >= 0) {
    const methodBody = lines.slice(methodStartIndex).join('\n').trim();
    method = methodBody === '' ? null : methodBody;
  }

  // Trim leading/trailing blank ingredient lines but preserve internal ones.
  while (ingredientLines.length > 0 && (ingredientLines[0] ?? '').trim() === '') {
    ingredientLines.shift();
  }
  while (
    ingredientLines.length > 0 &&
    (ingredientLines[ingredientLines.length - 1] ?? '').trim() === ''
  ) {
    ingredientLines.pop();
  }

  const ingredientsRaw = ingredientLines.join('\n');
  const warnings: string[] = [];
  if (ingredientsRaw.trim() === '') warnings.push('No ingredient lines detected.');

  return {
    rows: [{ name, ingredientsRaw, method, sourceUrl: null }],
    warnings,
    duplicateOfExistingName: [],
  };
}
