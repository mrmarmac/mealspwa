/**
 * Foundational scalar types. Deliberately string-based: everything that crosses
 * a storage or sync boundary must be comparable, serialisable and stable.
 */

/** UUID v7 — time-sortable, which makes it a good IndexedDB primary key. */
export type Id = string;

/** UUID v4, generated once per device and kept in localStorage. */
export type ClientId = string;

/** 'YYYY-MM-DD' in the user's LOCAL calendar. Never a Date object — a Date is a
 *  point in time, and a meal slot is a calendar square. Conflating the two makes
 *  "Tuesday dinner" move across a timezone change. */
export type ISODate = string;

/** '2026-08-03T09:12:33.123Z' — an actual instant, used only for display. */
export type ISODateTime = string;

/**
 * Hybrid Logical Clock, serialised so that lexicographic string comparison is a
 * total causal order:
 *   `${epochMs padded to 15}-${counter base36 padded to 4}-${clientId}`
 * e.g. '000001785302400123-000b-a1b2c3d4'
 *
 * Wall clocks on two phones disagree by seconds to minutes, which is fatal for
 * last-write-wins. The HLC pulls forward on every observed remote timestamp, so
 * causally-later writes always sort later. The trailing clientId is a
 * deterministic tie-break: both devices independently pick the same winner.
 */
export type HLC = string;

export const EPOCH_PAD = 15;
export const COUNTER_PAD = 4;

/** ISO date helpers — local calendar, no timezone maths. */
export function toISODate(d: Date): ISODate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fromISODate(s: ISODate): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

export function addDays(s: ISODate, n: number): ISODate {
  const d = fromISODate(s);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/** Monday-or-Sunday-anchored start of the week containing `s`. */
export function startOfWeek(s: ISODate, weekStartsOn: 0 | 1): ISODate {
  const d = fromISODate(s);
  const diff = (d.getDay() - weekStartsOn + 7) % 7;
  d.setDate(d.getDate() - diff);
  return toISODate(d);
}

export function todayISO(): ISODate {
  return toISODate(new Date());
}

/** UUID v7: 48-bit big-endian timestamp + random, so ids sort by creation time. */
export function uuidv7(): Id {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ts = Date.now();
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidv4(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
