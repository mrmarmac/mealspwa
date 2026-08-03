/**
 * Text normalisation and block analysis. Everything downstream assumes it is
 * looking at NFKC text with ASCII fractions, ASCII dashes and no bullets.
 */

const UNICODE_FRACTIONS: Record<string, string> = {
  '½': '1/2',
  '⅓': '1/3',
  '⅔': '2/3',
  '¼': '1/4',
  '¾': '3/4',
  '⅛': '1/8',
  '⅜': '3/8',
  '⅝': '5/8',
  '⅞': '7/8',
  '⅕': '1/5',
  '⅖': '2/5',
  '⅗': '3/5',
  '⅘': '4/5',
  '⅙': '1/6',
  '⅚': '5/6',
  '⅐': '1/7',
  '⅑': '1/9',
  '⅒': '1/10',
};

const FRACTION_RE = new RegExp(`([${Object.keys(UNICODE_FRACTIONS).join('')}])`, 'g');

// Sentinels marking where a unicode fraction expansion begins and ends, so that
// '1½' can be recognised as a mixed number and '½tsp' spaced apart.
const OPEN = '\u0001';
const CLOSE = '\u0002';

/**
 * NFKC plus the substitutions the parser depends on. NFKC alone is not enough:
 * it turns '½' into '1⁄2' with a FRACTION SLASH that no arithmetic
 * understands, and it leaves en dashes and non-breaking spaces intact.
 */
export function normalizeUnicode(input: string): string {
  let s = input;
  s = s.replace(FRACTION_RE, (_m, ch: string) => `${OPEN}${UNICODE_FRACTIONS[ch]}${CLOSE}`);
  s = s.normalize('NFKC');
  // '1½' => '1 1/2'
  s = s.replace(new RegExp(`(\\d)\\s*${OPEN}`, 'g'), '$1 ');
  s = s.replace(new RegExp(OPEN, 'g'), '');
  // '½tsp' => '1/2 tsp'
  s = s.replace(new RegExp(`${CLOSE}(?=[A-Za-z0-9])`, 'g'), ' ');
  s = s.replace(new RegExp(CLOSE, 'g'), '');
  s = s.replace(/⁄/g, '/');
  s = s.replace(/[×✕✖]/g, 'x');
  s = s.replace(/[‒–—―−]/g, '-');
  s = s.replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
  s = s.replace(/[‘’‛ʼ]/g, "'");
  s = s.replace(/[“”‟]/g, '"');
  s = s.replace(/[\u200b-\u200d\ufeff]/g, '');
  return s;
}

/** Splits on newlines, preserving order and dropping nothing. */
export function splitLines(text: string): string[] {
  return normalizeUnicode(text).split(/\r\n|\r|\n/);
}

const BULLET_RE = /^\s*[-*•‣·▪○●◦⁃>]+\s*/;
const NUMBERED_RE = /^\s*(\d+)\s*[.)]\s+/;

/**
 * Removes a leading bullet. Numbered prefixes are only bullets when the block
 * they came from is an incrementing list — otherwise '1. tomato' is far more
 * likely to be a badly-typed quantity than a list marker.
 */
export function stripBullet(line: string, allowNumbered = false): string {
  let s = line;
  if (allowNumbered) {
    const n = NUMBERED_RE.exec(s);
    if (n) return s.slice(n[0].length).trim();
  }
  const b = BULLET_RE.exec(s);
  if (b) s = s.slice(b[0].length);
  return s.trim();
}

export interface RawLine {
  /** As it appeared, after unicode normalisation only. */
  raw: string;
  /** Bullet-stripped, whitespace-collapsed. */
  text: string;
  index: number;
  blank: boolean;
}

export interface BlockAnalysis {
  lines: RawLine[];
  /** True when a leading '1.' '2.' '3.' sequence was detected and stripped. */
  numberedList: boolean;
}

/** True when the block's numeric prefixes form an incrementing run of >= 2. */
function detectNumberedList(lines: string[]): boolean {
  const nums: number[] = [];
  for (const l of lines) {
    const m = NUMBERED_RE.exec(l);
    if (m) nums.push(Number(m[1]));
  }
  if (nums.length < 2) return false;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i]! !== nums[i - 1]! + 1) return false;
  }
  return true;
}

export function analyseBlock(text: string): BlockAnalysis {
  const raws = splitLines(text);
  const numberedList = detectNumberedList(raws);
  const lines: RawLine[] = raws.map((raw, index) => {
    const stripped = stripBullet(raw, numberedList).replace(/\s+/g, ' ').trim();
    return { raw, text: stripped, index, blank: stripped.length === 0 };
  });
  return { lines, numberedList };
}

/** Lowercase, unaccented, single-spaced. The key used for lexicon lookups. */
export function normaliseKey(s: string): string {
  return normalizeUnicode(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits into tokens, keeping a parenthesised group as a single token so that
 * '2 x 250g (8oz) packets' is four tokens and the container is still "within
 * two tokens" of the size.
 */
export function tokenizeWithGroups(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  let buf = '';
  const flush = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = '';
  };
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '(') {
      flush();
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      out.push(s.slice(i, Math.min(j + 1, s.length)));
      i = j + 1;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}
