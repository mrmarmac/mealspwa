/**
 * The module-level clock singleton. Every write in the app goes through the
 * same `AppClock` instance so causal ordering is consistent within a device.
 *
 * `clientId` is generated once (uuidv4) and persisted in the `meta` store.
 * The HLC's `{epochMs, counter}` state is restored from `meta` on first use
 * and re-persisted after every `now()`/`observe()` call, debounced onto a
 * microtask so a burst of writes only costs one extra IndexedDB write — the
 * in-memory clock itself (from `domain/hlc.ts`) is monotonic on every call
 * regardless of when the persisted copy catches up, so a crash before the
 * debounced write flushes can at worst replay a couple of already-issued
 * timestamps, which HLC comparison tolerates fine (it never revisits a
 * clock that went backwards; `observe()` on next boot pulls back in line
 * with any peer that saw the higher values).
 */
import { createClock, type Clock } from '@/domain/hlc';
import { uuidv4 } from '@/domain/primitives';
import type { ClientId, HLC } from '@/domain/primitives';
import { getDB } from './idb';

const CLIENT_ID_KEY = 'clientId';
const HLC_STATE_KEY = 'hlcState';

export interface AppClock extends Clock {
  readonly clientId: ClientId;
}

interface HlcState {
  epochMs: number;
  counter: number;
}

function isHlcState(v: unknown): v is HlcState {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as Record<string, unknown>;
  return typeof rec['epochMs'] === 'number' && typeof rec['counter'] === 'number';
}

async function loadOrCreateClientId(): Promise<ClientId> {
  const db = await getDB();
  const existing = await db.get('meta', CLIENT_ID_KEY);
  if (existing && typeof existing.value === 'string' && existing.value.length > 0) {
    return existing.value;
  }
  const id = uuidv4();
  await db.put('meta', { key: CLIENT_ID_KEY, value: id });
  return id;
}

async function loadHlcState(): Promise<HlcState | undefined> {
  const db = await getDB();
  const row = await db.get('meta', HLC_STATE_KEY);
  return row && isHlcState(row.value) ? row.value : undefined;
}

let persistScheduled = false;

function schedulePersist(base: Clock): void {
  if (persistScheduled) return;
  persistScheduled = true;
  queueMicrotask(() => {
    persistScheduled = false;
    void persistState(base);
  });
}

async function persistState(base: Clock): Promise<void> {
  const db = await getDB();
  await db.put('meta', { key: HLC_STATE_KEY, value: base.state() });
}

let readyPromise: Promise<AppClock> | null = null;

/** Resolve the app's clock, initialising it (and persisting a fresh
 *  clientId) the first time it is called. Safe to call concurrently — all
 *  callers share the same in-flight init. */
export function ensureClock(): Promise<AppClock> {
  if (!readyPromise) {
    readyPromise = (async () => {
      const clientId = await loadOrCreateClientId();
      const state = await loadHlcState();
      const base = createClock(clientId, state);

      const appClock: AppClock = {
        clientId,
        now(): HLC {
          const h = base.now();
          schedulePersist(base);
          return h;
        },
        observe(remote: HLC): void {
          base.observe(remote);
          schedulePersist(base);
        },
        state: () => base.state(),
      };
      return appClock;
    })();
  }
  return readyPromise;
}

/** Test-only: forget the cached clock so the next `ensureClock()` re-reads
 *  `meta` from whatever fake-indexeddb instance the test just installed. */
export function _resetClockForTests(): void {
  readyPromise = null;
  persistScheduled = false;
}
