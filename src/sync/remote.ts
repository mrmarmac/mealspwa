/**
 * The remote sync adapter: `push`/`pull` against the sync worker (see
 * sync-worker/). Like the recipe fetcher client (`src/lib/fetcher.ts`), it
 * NEVER throws — a down/flaky/misconfigured backend must degrade to "sync did
 * nothing this cycle", not break the app. Every failure (network, CORS, non-
 * 200, timeout, malformed JSON) collapses to an empty result, and the sync
 * engine simply retries on the next poll (the outbox is left intact on a
 * failed push).
 */
import type { HLC, Id } from '@/domain/primitives';
import type { Syncable } from '@/domain/types';
import type { SyncAdapter, SyncPacket } from '@/domain/sync';

const REQUEST_TIMEOUT_MS = 8000;

function isSyncableEntity(value: unknown): value is Syncable {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['kind'] === 'string' &&
    typeof v['spaceId'] === 'string' &&
    typeof v['updatedAt'] === 'string' &&
    (v['deletedAt'] === null || typeof v['deletedAt'] === 'string')
  );
}

export class RemoteAdapter implements SyncAdapter {
  readonly name = 'remote';
  readonly isRemote = true;

  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    // Tolerate a trailing slash in the configured URL.
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async push(spaceId: Id, entities: Syncable[]): Promise<Id[]> {
    if (entities.length === 0) return [];
    const data = await this.request('/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ spaceId, entities }),
    });
    if (typeof data !== 'object' || data === null) return [];
    const accepted = (data as Record<string, unknown>)['acceptedIds'];
    if (!Array.isArray(accepted)) return [];
    return accepted.filter((id): id is Id => typeof id === 'string');
  }

  async pull(spaceId: Id, since: HLC | null): Promise<SyncPacket> {
    const empty: SyncPacket = { spaceId, since, entities: [] };
    const query = new URLSearchParams({ spaceId });
    if (since) query.set('since', since);
    const data = await this.request(`/pull?${query.toString()}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (typeof data !== 'object' || data === null) return empty;
    const raw = (data as Record<string, unknown>)['entities'];
    if (!Array.isArray(raw)) return empty;
    return { spaceId, since, entities: raw.filter(isSyncableEntity) };
  }

  /** One request, bounded and non-throwing. Returns the parsed JSON body, or
   *  `null` on any failure whatsoever. */
  private async request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return (await response.json()) as unknown;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
