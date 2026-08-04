import { afterEach, describe, expect, it } from 'vitest';
import { RemoteAdapter } from './remote';
import { InMemorySyncServer } from './testServer';
import { encodeHLC } from '@/domain/hlc';
import { SCHEMA_VERSION, type Syncable } from '@/domain/types';

const BASE = 'https://sync.test';
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function entity(id: string, updatedAt: string, spaceId = 'space-1'): Syncable {
  return {
    id,
    kind: 'recipe',
    spaceId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    lastWriterClientId: 'client-a',
    deletedAt: null,
    schemaVersion: SCHEMA_VERSION,
  };
}

describe('RemoteAdapter — happy path against the fake server', () => {
  it('pushes entities and returns the accepted ids', async () => {
    const server = new InMemorySyncServer();
    const restore = server.installFetch();
    try {
      const adapter = new RemoteAdapter(BASE, 'tok');
      const accepted = await adapter.push('space-1', [
        entity('r1', encodeHLC(1000, 0, 'a')),
        entity('r2', encodeHLC(1001, 0, 'a')),
      ]);
      expect(accepted.sort()).toEqual(['r1', 'r2']);
      expect(server.snapshot('space-1').map((e) => e.id).sort()).toEqual(['r1', 'r2']);
    } finally {
      restore();
    }
  });

  it('tolerates a trailing slash in the base url', async () => {
    const server = new InMemorySyncServer();
    const restore = server.installFetch();
    try {
      const adapter = new RemoteAdapter(`${BASE}/`, 'tok');
      const accepted = await adapter.push('space-1', [entity('r1', encodeHLC(1000, 0, 'a'))]);
      expect(accepted).toEqual(['r1']);
    } finally {
      restore();
    }
  });

  it('pulls entities changed since the cursor', async () => {
    const server = new InMemorySyncServer();
    const restore = server.installFetch();
    try {
      const adapter = new RemoteAdapter(BASE, 'tok');
      const older = encodeHLC(1000, 0, 'a');
      const newer = encodeHLC(2000, 0, 'a');
      await adapter.push('space-1', [entity('r1', older), entity('r2', newer)]);

      const all = await adapter.pull('space-1', null);
      expect(all.entities.map((e) => e.id).sort()).toEqual(['r1', 'r2']);

      const delta = await adapter.pull('space-1', older);
      expect(delta.entities.map((e) => e.id)).toEqual(['r2']);
    } finally {
      restore();
    }
  });

  it('returns no accepted ids for an empty push without hitting the network', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const adapter = new RemoteAdapter(BASE, 'tok');
    expect(await adapter.push('space-1', [])).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('RemoteAdapter — auth', () => {
  it('drains nothing (returns []) when the space token does not match', async () => {
    const server = new InMemorySyncServer();
    const restore = server.installFetch();
    try {
      // First device binds the token.
      await new RemoteAdapter(BASE, 'right').push('space-1', [entity('r1', encodeHLC(1000, 0, 'a'))]);
      // Second device with the wrong token is rejected; adapter swallows the
      // 401 and reports nothing accepted, so the caller keeps its outbox.
      const accepted = await new RemoteAdapter(BASE, 'wrong').push('space-1', [
        entity('r2', encodeHLC(2000, 0, 'b')),
      ]);
      expect(accepted).toEqual([]);
      expect(server.snapshot('space-1').map((e) => e.id)).toEqual(['r1']);
    } finally {
      restore();
    }
  });
});

describe('RemoteAdapter — never throws, always degrades', () => {
  const adapter = new RemoteAdapter(BASE, 'tok');

  it('on a network error', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    expect(await adapter.push('space-1', [entity('r1', encodeHLC(1, 0, 'a'))])).toEqual([]);
    expect((await adapter.pull('space-1', null)).entities).toEqual([]);
  });

  it('on an aborted/timed-out request', async () => {
    globalThis.fetch = (async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }) as typeof fetch;
    expect(await adapter.push('space-1', [entity('r1', encodeHLC(1, 0, 'a'))])).toEqual([]);
    expect((await adapter.pull('space-1', null)).entities).toEqual([]);
  });

  it('on a non-200 response', async () => {
    globalThis.fetch = (async () => new Response('{"error":"boom"}', { status: 500 })) as typeof fetch;
    expect(await adapter.push('space-1', [entity('r1', encodeHLC(1, 0, 'a'))])).toEqual([]);
    expect((await adapter.pull('space-1', null)).entities).toEqual([]);
  });

  it('on a malformed JSON body', async () => {
    globalThis.fetch = (async () => new Response('not json at all', { status: 200 })) as typeof fetch;
    expect(await adapter.push('space-1', [entity('r1', encodeHLC(1, 0, 'a'))])).toEqual([]);
    expect((await adapter.pull('space-1', null)).entities).toEqual([]);
  });

  it('preserves the requested `since` in the degraded pull packet', async () => {
    globalThis.fetch = (async () => {
      throw new Error('down');
    }) as typeof fetch;
    const since = encodeHLC(5, 0, 'a');
    expect(await adapter.pull('space-1', since)).toEqual({
      spaceId: 'space-1',
      since,
      entities: [],
    });
  });
});
