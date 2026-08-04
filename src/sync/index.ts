/**
 * Adapter selection: the one place that decides whether this device syncs to a
 * remote backend or stays local-only. Mirrors the recipe fetcher's "feature is
 * off when its env var is unset" contract — no `VITE_SYNC_URL` (or no
 * per-space token) means `LocalOnlyAdapter`, and nothing throws.
 */
import { getMeta } from '@/db/repo';
import { ACTIVE_SPACE_ID_META_KEY } from '@/store/useSpaceStore';
import type { SyncAdapter } from '@/domain/sync';
import { getSyncConfig } from './config';
import { LocalOnlyAdapter } from './local';
import { RemoteAdapter } from './remote';

/** The configured sync backend origin, or undefined when unset/blank. */
export function syncBaseUrl(): string | undefined {
  const url = import.meta.env.VITE_SYNC_URL as string | undefined;
  return url && url.length > 0 ? url : undefined;
}

/** Whether remote sync is even possible in this build (URL configured). */
export function isSyncAvailable(): boolean {
  return syncBaseUrl() !== undefined;
}

/**
 * Pick the adapter for the currently active space. Returns a `RemoteAdapter`
 * only when: a sync URL is configured, a sync token exists for a space, and
 * that space is the active one — otherwise `LocalOnlyAdapter`.
 */
export async function selectAdapter(): Promise<SyncAdapter> {
  const base = syncBaseUrl();
  if (!base) return new LocalOnlyAdapter();

  const config = await getSyncConfig();
  if (!config) return new LocalOnlyAdapter();

  const activeSpaceId = await getMeta<string>(ACTIVE_SPACE_ID_META_KEY);
  if (config.spaceId !== activeSpaceId) return new LocalOnlyAdapter();

  return new RemoteAdapter(base, config.token);
}
