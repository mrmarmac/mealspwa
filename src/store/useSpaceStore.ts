/**
 * The active space and its settings. Also owns first-run bootstrap: if no
 * space exists yet on this device, create one and seed it from the recipe
 * library exactly once.
 */
import { create } from 'zustand';
import { getMeta, setMeta, spaceRepo } from '@/db/repo';
import { seedSpace } from '@/seed';
import { uuidv7 } from '@/domain/primitives';
import { DEFAULT_SETTINGS, SCHEMA_VERSION, type Space, type SpaceSettings } from '@/domain/types';

export const ACTIVE_SPACE_ID_META_KEY = 'activeSpaceId';

interface SpaceStoreState {
  space: Space | null;
  loading: boolean;
  initialized: boolean;
  error: string | null;
  /** Loads the active space, bootstrapping (create space + seed recipes) on
   *  first ever launch. Safe to call more than once — subsequent calls are
   *  no-ops while already initialized or in flight. */
  init(): Promise<void>;
  /** Re-read the active space from storage (e.g. after a remote sync pull
   *  applied a settings/name change from the other device). No-op if no space
   *  is active yet. */
  reload(): Promise<void>;
  updateSettings(patch: Partial<SpaceSettings>): Promise<void>;
}

async function createDefaultSpace(): Promise<Space> {
  const id = uuidv7();
  const nowIso = new Date().toISOString();
  const draft: Space = {
    id,
    kind: 'space',
    // A space's own row is scoped to itself — this is what makes
    // space-scoped index/export queries include the space entity too.
    spaceId: id,
    createdAt: nowIso,
    // Overwritten by repo.put()'s stamp() call; placeholders only.
    updatedAt: '',
    lastWriterClientId: '',
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
    name: 'My kitchen',
    settings: DEFAULT_SETTINGS,
  };
  return spaceRepo.put(draft);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useSpaceStore = create<SpaceStoreState>((set, get) => ({
  space: null,
  loading: false,
  initialized: false,
  error: null,

  async init() {
    if (get().initialized || get().loading) return;
    set({ loading: true, error: null });
    try {
      const activeId = await getMeta<string>(ACTIVE_SPACE_ID_META_KEY);
      let space = activeId ? await spaceRepo.get(activeId) : undefined;

      if (!space) {
        space = await createDefaultSpace();
        await setMeta(ACTIVE_SPACE_ID_META_KEY, space.id);
      }

      // Idempotent (guarded by a meta flag) — safe, and necessary, to call
      // on every init: it also recovers a space whose first-launch seeding
      // was interrupted before the flag was set.
      await seedSpace(space.id);

      set({ space, loading: false, initialized: true });
    } catch (err) {
      set({ error: errorMessage(err), loading: false });
    }
  },

  async reload() {
    const current = get().space;
    if (!current) return;
    const fresh = await spaceRepo.get(current.id);
    if (fresh) set({ space: fresh });
  },

  async updateSettings(patch) {
    const current = get().space;
    if (!current) return;

    const optimistic: Space = { ...current, settings: { ...current.settings, ...patch } };
    set({ space: optimistic });

    try {
      const saved = await spaceRepo.put(optimistic);
      set({ space: saved });
    } catch (err) {
      // Revert the optimistic update on failure.
      set({ space: current, error: errorMessage(err) });
    }
  },
}));
