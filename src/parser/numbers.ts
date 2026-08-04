/**
 * Number grammar for ingredient lines.
 *
 *   range   := num sep num          sep ∈ '-' '–' '—' 'to' '~'
 *   mixed   := int ws fraction      '1 1/2' => 1.5
 *   fraction:= int '/' int
 *   decimal := [0-9]*'.'[0-9]+
 *   wordnum := a|an|one..twelve|half|quarter|third|couple|dozen|few
 *
 * A range is only a range when BOTH sides are numeric and what follows is a unit
 * or a known food — otherwise 'chilli-garlic paste' would parse as 'chilli' to
 * 'garlic'.
 */
import type { Quantity } from '@/domain/types';

export const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  half: 0.5,
  'a half': 0.5,
  quarter: 0.25,
  'a quarter': 0.25,
  third: 1 / 3,
  'a third': 1 / 3,
  couple: 2,
  'a couple': 2,
  dozen: 12,
  few: 3,
};

/** '1/2' => 0.5. Returns null for anything that is not int '/' int. */
export function fractionToNumber(s: string): number | null {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(s);
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!den) return null;
  return num / den;
}

/** 'half' => 0.5. Case-insensitive. Returns null when not a number word. */
export function wordToNumber(s: string): number | null {
  const k = s.trim().toLowerCase();
  const v = WORD_NUMBERS[k];
  return v === undefined ? null : v;
}

const RANGE_SEPS = ['-', '–', '—', '~'];

/** Matches a single numeric literal at the start: mixed, fraction, or decimal. */
const NUM_RE = /^(\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d*\.\d+|\d+)/;

interface NumLit {
  value: number;
  raw: string;
  length: number;
}

function readNumber(s: string): NumLit | null {
  const m = NUM_RE.exec(s);
  if (m) {
    const raw = m[1]!;
    const mixed = /^(\d+)\s+(\d+)\s*\/\s*(\d+)$/.exec(raw);
    if (mixed) {
      const den = Number(mixed[3]);
      if (!den) return null;
      return {
        value: Number(mixed[1]) + Number(mixed[2]) / den,
        raw,
        length: m[0]!.length,
      };
    }
    const frac = fractionToNumber(raw);
    if (frac !== null) return { value: frac, raw, length: m[0]!.length };
    return { value: Number(raw), raw, length: m[0]!.length };
  }
  // word numbers — two-word phrases first, so 'a couple' is 2 and not 1.
  const wm2 = /^([A-Za-z]+[ \t]+[A-Za-z]+)/.exec(s);
  if (wm2) {
    const v = wordToNumber(wm2[1]!.replace(/\s+/g, ' '));
    if (v !== null) return { value: v, raw: wm2[1]!, length: wm2[1]!.length };
  }
  const wm = /^([A-Za-z]+)/.exec(s);
  if (wm) {
    const v = wordToNumber(wm[1]!);
    if (v !== null) return { value: v, raw: wm[1]!, length: wm[1]!.length };
  }
  return null;
}

export interface QuantityPrefix {
  qty: Quantity;
  rest: string;
}

export interface NumberOpts {
  /**
   * Lookahead guard for ranges: given the text that follows the candidate
   * range, decide whether it starts with a unit or a known food. Defaults to a
   * permissive check that accepts anything alphabetic, which is correct for
   * '400-500g' but is tightened by the parser, which passes the real lexicon.
   */
  rangeFollows?: (rest: string) => boolean;
  /** Allow bare word numbers ('a', 'an') to start a quantity. Default true. */
  allowWordNumbers?: boolean;
}

const defaultRangeFollows = (rest: string): boolean => /^\s*[A-Za-z(]/.test(rest);

function makeQuantity(low: number, high: number, raw: string, approx = false): Quantity {
  return { low, high, isRange: low !== high, approx, raw: raw.trim() };
}

/**
 * Reads a leading quantity. Returns null when the string does not start with a
 * number — callers treat that as "no quantity", never as an error.
 */
export function parseQuantityPrefix(s: string, opts: NumberOpts = {}): QuantityPrefix | null {
  const allowWords = opts.allowWordNumbers !== false;
  const follows = opts.rangeFollows ?? defaultRangeFollows;
  const trimmed = s.replace(/^\s+/, '');
  if (!trimmed) return null;

  const first = readNumber(trimmed);
  if (!first) return null;
  if (!allowWords && !/^[\d.]/.test(trimmed)) return null;

  const afterFirst = trimmed.slice(first.length);

  // range?
  const sepMatch = /^\s*(-|–|—|~|\bto\b)\s*/i.exec(afterFirst);
  if (sepMatch) {
    const sepText = sepMatch[1]!.toLowerCase();
    const isDashSep = RANGE_SEPS.includes(sepText);
    const isWordSep = sepText === 'to';
    if (isDashSep || isWordSep) {
      const afterSep = afterFirst.slice(sepMatch[0].length);
      const second = readNumber(afterSep);
      // Both sides must be numeric literals (not word numbers) for a range.
      if (second && /^[\d.]/.test(afterSep) && /^[\d.]/.test(trimmed)) {
        const rest = afterSep.slice(second.length);
        if (follows(rest)) {
          const lo = Math.min(first.value, second.value);
          const hi = Math.max(first.value, second.value);
          const rawRange = trimmed.slice(0, trimmed.length - rest.length);
          return { qty: makeQuantity(lo, hi, rawRange), rest };
        }
      }
    }
  }

  return {
    qty: makeQuantity(first.value, first.value, first.raw),
    rest: afterFirst,
  };
}

const DEFAULT_DENOMS = [2, 3, 4, 8];

/**
 * Renders a float as a mixed fraction when one is honest within `tol`, else
 * null. Prefers the smallest denominator, so 0.5 is '1/2' and never '4/8'.
 */
export function toFraction(
  v: number,
  denoms: number[] = DEFAULT_DENOMS,
  tol = 0.02,
): string | null {
  if (!Number.isFinite(v)) return null;
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  const whole = Math.floor(abs + 1e-9);
  const frac = abs - whole;

  if (frac < tol) return whole === 0 ? '0' : `${sign}${whole}`;
  if (1 - frac < tol) return `${sign}${whole + 1}`;

  const sorted = [...denoms].sort((a, b) => a - b);
  for (const den of sorted) {
    for (let num = 1; num < den; num++) {
      if (gcd(num, den) !== 1) continue;
      if (Math.abs(frac - num / den) <= tol) {
        return whole === 0 ? `${sign}${num}/${den}` : `${sign}${whole} ${num}/${den}`;
      }
    }
  }
  return null;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
