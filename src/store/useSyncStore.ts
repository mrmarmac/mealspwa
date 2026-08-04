/**
 * The sync driver: owns the `SyncEngine` for the active space and the polling
 * loop that pushes the outbox and pulls remote changes. Everything conflict-
 * related already lives below this (the engine, `resolve()`, the outbox, the
 * clock) — this store only decides *when* to sync and refreshes the UI stores
 * when a pull actually applied something.
 *
 * Degradation contract (same as the recipe fetcher): with no `VITE_SYNC_URL`
 * or no per-space token, `enabled` is false and this store does nothing. The
 * adapter never throws, so a failed cycle just leaves the outbox intact for the
 * next poll.
 */
import { create } from 'zustand';
import { createSyncEngine, type SyncEngine, type SyncStatus } from '@/sync/adapter';
import { isSyncAvailable, syncBaseUrl } from '@/sync';
import {
  clearSyncConfig,
  decodeJoinCode,
  encodeJoinCode,
  generateSyncToken,
  getSyncConfig,
  setSyncConfig,
  type SyncConfig,
} from '@/sync/config';
import { RemoteAdapter } from '@/sync/remote';
import { exportSpace } from '@/sync/spaceFile';
import { getMeta, setMeta } from '@/db/repo';
import { ACTIVE_SPACE_ID_META_KEY, useSpaceStore } from '@/store/useSpaceStore';
import { usePlanStore } from '@/store/usePlanStore';
import { useRecipeStore } from '@/store/useRecipeStore';
import { useShoppingStore } from '@/store/useShoppingStore';
import type { Id } from '@/domain/primitives';

const POLL_INTERVAL_MS = 20000;

// Imperative driver handles kept outside zustand state (they aren't UI state).
let engine: SyncEngine | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let driverSpaceId: Id | null = null;
let listenersBound = false;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function triggerSync(): void {
  void useSyncStore.getState().syncNow();
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') triggerSync();
}

function bindListeners(): void {
  if (listenersBound || typeof window === 'undefined') return;
  window.addEventListener('online', triggerSync);
  document.addEventListener('visibilitychange', onVisibilityChange);
  listenersBound = true;
}

function unbindListeners(): void {
  if (!listenersBound || typeof window === 'undefined') return;
  window.removeEventListener('online', triggerSync);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  listenersBound = false;
}

/** After a pull applied remote changes, re-read whichever UI stores are
 *  already loaded so the screens reflect the merged state without a reload.
 *  Only runs when something actually changed (guarded by the caller), so it
 *  never causes a loading flash on an idle poll. */
async function refreshLoadedStores(spaceId: Id): Promise<void> {
  const recipe = useRecipeStore.getState();
  if (recipe.loaded) await recipe.load(spaceId);

  const plan = usePlanStore.getState();
  if (plan.range) await plan.load(plan.range.spaceId, plan.range.from, plan.range.to);

  const shopping = useShoppingStore.getState();
  if (shopping.session) await shopping.loadActive(shopping.session.spaceId);

  await useSpaceStore.getState().reload();
}

interface SyncStoreState {
  /** Remote sync is possible in this build (VITE_SYNC_URL configured). */
  available: boolean;
  /** This device is syncing the active space (token present + space matches). */
  enabled: boolean;
  status: SyncStatus | null;
  syncing: boolean;
  lastError: string | null;

  /** Recompute `available`/`enabled` from env + stored config. */
  refresh(): Promise<void>;
  /** Begin driving sync for `spaceId` if enabled; otherwise tear down. Safe to
   *  call repeatedly (idempotent timers/listeners). */
  start(spaceId: Id): Promise<void>;
  stop(): void;
  /** One push+pull cycle. No-op while offline or already in flight. */
  syncNow(): Promise<void>;
  refreshStatus(): Promise<void>;
  /** Device 1: mint a token, back-fill the whole space to the server, start
   *  syncing, and return the join code for the second device. */
  enable(spaceId: Id): Promise<{ joinCode: string }>;
  /** The current space's join code, or null if sync isn't enabled. */
  getJoinCode(): Promise<string | null>;
  /** Device 2: adopt the space in `code`, pull it down, and make it active.
   *  Returns the joined space id; the caller should reload so it renders. */
  join(code: string): Promise<Id>;
  /** Stop syncing and forget the token on this device. */
  disable(): Promise<void>;
}

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  available: isSyncAvailable(),
  enabled: false,
  status: null,
  syncing: false,
  lastError: null,

  async refresh() {
    const available = isSyncAvailable();
    const config = await getSyncConfig();
    const activeSpaceId = await getMeta<string>(ACTIVE_SPACE_ID_META_KEY);
    set({ available, enabled: available && !!config && config.spaceId === activeSpaceId });
  },

  async start(spaceId) {
    await get().refresh();
    if (!get().enabled) {
      get().stop();
      return;
    }
    const base = syncBaseUrl();
    const config = await getSyncConfig();
    if (!base || !config) return;

    engine = createSyncEngine({ adapter: new RemoteAdapter(base, config.token) });
    driverSpaceId = spaceId;
    bindListeners();
    if (!pollTimer) {
      pollTimer = setInterval(triggerSync, POLL_INTERVAL_MS);
    }
    await get().syncNow();
  },

  stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    unbindListeners();
    engine = null;
    driverSpaceId = null;
  },

  async syncNow() {
    if (!engine || !driverSpaceId) return;
    if (get().syncing) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    const spaceId = driverSpaceId;
    const activeEngine = engine;
    set({ syncing: true });
    try {
      await activeEngine.pushPending(spaceId);
      const { pulledCount } = await activeEngine.pullSince(spaceId);
      set({ lastError: null });
      if (pulledCount > 0) await refreshLoadedStores(spaceId);
    } catch (err) {
      set({ lastError: errorMessage(err) });
    } finally {
      set({ syncing: false });
      await get().refreshStatus();
    }
  },

  async refreshStatus() {
    if (!engine) {
      set({ status: null });
      return;
    }
    try {
      set({ status: await engine.status() });
    } catch {
      // Status is best-effort; a failure here must not break a sync cycle.
    }
  },

  async enable(spaceId) {
    const base = syncBaseUrl();
    if (!base) throw new Error('Sync is not configured in this build.');

    const token = generateSyncToken();
    const config: SyncConfig = { spaceId, token, enabledAt: new Date().toISOString() };
    await setSyncConfig(config);

    // The outbox has been draining into LocalOnlyAdapter for this device's
    // whole life, so it's empty — back-fill the entire current space once,
    // directly, before switching over to outbox-driven deltas.
    const snapshot = await exportSpace(spaceId);
    await new RemoteAdapter(base, token).push(spaceId, snapshot.entities);

    set({ enabled: true });
    await get().start(spaceId);
    return { joinCode: encodeJoinCode(spaceId, token) };
  },

  async getJoinCode() {
    const config = await getSyncConfig();
    return config ? encodeJoinCode(config.spaceId, config.token) : null;
  },

  async join(code) {
    const base = syncBaseUrl();
    if (!base) throw new Error('Sync is not configured in this build.');

    const payload = decodeJoinCode(code);
    await setSyncConfig({
      spaceId: payload.spaceId,
      token: payload.token,
      enabledAt: new Date().toISOString(),
    });

    // Pull the whole space in BEFORE making it active, so the space entity and
    // all its data exist locally when the app reloads onto it.
    const joinEngine = createSyncEngine({ adapter: new RemoteAdapter(base, payload.token) });
    await joinEngine.pullSince(payload.spaceId);
    await setMeta(ACTIVE_SPACE_ID_META_KEY, payload.spaceId);
    return payload.spaceId;
  },

  async disable() {
    get().stop();
    await clearSyncConfig();
    set({ enabled: false, status: null, lastError: null });
  },
}));
