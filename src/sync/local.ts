/**
 * The v1 default adapter: no remote backend exists yet, so sync is a no-op
 * that still exercises the whole pipeline (outbox drains, cursor advances)
 * so wiring a real backend later is a new adapter, not new plumbing.
 */
import type { HLC, Id } from '@/domain/primitives';
import type { Syncable } from '@/domain/types';
import type { SyncAdapter, SyncPacket } from '@/domain/sync';

export class LocalOnlyAdapter implements SyncAdapter {
  readonly name = 'local-only';
  readonly isRemote = false;

  async push(_spaceId: Id, entities: Syncable[]): Promise<Id[]> {
    // Nothing to actually send anywhere; "accept" every id so the outbox
    // drains rather than growing forever on a device that never syncs.
    return entities.map((e) => e.id);
  }

  async pull(spaceId: Id, since: HLC | null): Promise<SyncPacket> {
    return { spaceId, since, entities: [] };
  }
}
