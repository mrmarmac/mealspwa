import { COUNTER_PAD, EPOCH_PAD, type ClientId, type HLC } from './primitives';

/** Refuse to accept a remote clock more than this far ahead of ours. */
const MAX_SKEW_MS = 60 * 60 * 1000;

export interface Clock {
  /** Timestamp for a local write. Monotonic even if the wall clock goes backwards. */
  now(): HLC;
  /** Pull our clock forward past a timestamp we have seen from a peer. */
  observe(remote: HLC): void;
  /** Current state, for persisting across reloads. */
  state(): { epochMs: number; counter: number };
}

export function encodeHLC(epochMs: number, counter: number, clientId: ClientId): HLC {
  return `${String(epochMs).padStart(EPOCH_PAD, '0')}-${counter
    .toString(36)
    .padStart(COUNTER_PAD, '0')}-${clientId}`;
}

export function decodeHLC(h: HLC): { epochMs: number; counter: number; clientId: ClientId } {
  const first = h.indexOf('-');
  const second = h.indexOf('-', first + 1);
  return {
    epochMs: Number(h.slice(0, first)),
    counter: parseInt(h.slice(first + 1, second), 36),
    clientId: h.slice(second + 1),
  };
}

export function hlcTime(h: HLC): number {
  return decodeHLC(h).epochMs;
}

/**
 * The whole ordering primitive: HLCs are built so a plain string compare is the
 * causal order. Keep it that way — do not decode to compare.
 */
export function hlcCompare(a: HLC, b: HLC): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function hlcMax(a: HLC | null, b: HLC | null): HLC | null {
  if (!a) return b;
  if (!b) return a;
  return hlcCompare(a, b) >= 0 ? a : b;
}

export function createClock(
  clientId: ClientId,
  initial?: { epochMs: number; counter: number },
  wallClock: () => number = Date.now,
): Clock {
  let epochMs = initial?.epochMs ?? 0;
  let counter = initial?.counter ?? 0;

  return {
    now(): HLC {
      const wall = wallClock();
      if (wall > epochMs) {
        epochMs = wall;
        counter = 0;
      } else {
        // Wall clock stalled or went backwards; stay monotonic via the counter.
        counter += 1;
      }
      return encodeHLC(epochMs, counter, clientId);
    },

    observe(remote: HLC): void {
      const r = decodeHLC(remote);
      if (!Number.isFinite(r.epochMs)) return;
      // A peer with a badly wrong clock could otherwise push us decades ahead and
      // make every subsequent local write lose forever.
      if (r.epochMs > wallClock() + MAX_SKEW_MS) return;
      if (r.epochMs > epochMs) {
        epochMs = r.epochMs;
        counter = r.counter;
      } else if (r.epochMs === epochMs && r.counter > counter) {
        counter = r.counter;
      }
    },

    state: () => ({ epochMs, counter }),
  };
}
