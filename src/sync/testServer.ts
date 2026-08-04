/**
 * Test-only in-memory sync server that mirrors the real Cloudflare worker's
 * push/pull/LWW/auth contract (sync-worker/src/index.ts). Not a test file
 * itself, so suites under src/sync can import it (same pattern as
 * src/db/testUtils.ts).
 *
 * It models the token as an opaque equality key rather than hashing it — the
 * sha256 step is an implementation detail proven separately in the worker's
 * own store.test.ts; what matters here is the trust-on-first-use behaviour and
 * the last-write-wins-by-HLC merge, which use the SAME `hlcCompare` the client
 * does.
 */
import { hlcCompare } from '@/domain/hlc';
import type { Syncable } from '@/domain/types';

interface SpaceState {
  token: string | null;
  entities: Map<string, Syncable>;
}

export interface ServerResult {
  ok: boolean;
  status: number;
  acceptedIds?: string[];
  entities?: Syncable[];
}

export class InMemorySyncServer {
  private readonly spaces = new Map<string, SpaceState>();

  private ensure(spaceId: string): SpaceState {
    let state = this.spaces.get(spaceId);
    if (!state) {
      state = { token: null, entities: new Map() };
      this.spaces.set(spaceId, state);
    }
    return state;
  }

  /** The entities the server currently holds for a space (test assertions). */
  snapshot(spaceId: string): Syncable[] {
    return [...(this.spaces.get(spaceId)?.entities.values() ?? [])];
  }

  push(spaceId: string, token: string, entities: Syncable[]): ServerResult {
    const state = this.ensure(spaceId);
    if (state.token === null) state.token = token; // trust-on-first-use
    else if (state.token !== token) return { ok: false, status: 401 };

    const owned = entities.filter((e) => e.spaceId === spaceId);
    for (const entity of owned) {
      const current = state.entities.get(entity.id);
      if (!current || hlcCompare(entity.updatedAt, current.updatedAt) > 0) {
        state.entities.set(entity.id, entity);
      }
    }
    return { ok: true, status: 200, acceptedIds: owned.map((e) => e.id) };
  }

  pull(spaceId: string, token: string, since: string | null): ServerResult {
    const state = this.spaces.get(spaceId);
    if (state && state.token !== null && state.token !== token) {
      return { ok: false, status: 401 };
    }
    const all = state ? [...state.entities.values()] : [];
    const filtered = (since ? all.filter((e) => hlcCompare(e.updatedAt, since) > 0) : all).sort(
      (a, b) => hlcCompare(a.updatedAt, b.updatedAt),
    );
    return { ok: true, status: 200, entities: filtered };
  }

  /** Install this server as the global `fetch`, routing /push and /pull to it.
   *  Returns a restore function. */
  installFetch(): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const token = bearerFrom(init?.headers) ?? '';

      if (url.includes('/push')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          spaceId?: string;
          entities?: Syncable[];
        };
        const result = this.push(body.spaceId ?? '', token, body.entities ?? []);
        return jsonResponse(result.ok ? { acceptedIds: result.acceptedIds } : { error: 'x' }, result.status);
      }

      if (url.includes('/pull')) {
        const parsed = new URL(url);
        const spaceId = parsed.searchParams.get('spaceId') ?? '';
        const since = parsed.searchParams.get('since');
        const result = this.pull(spaceId, token, since);
        return jsonResponse(
          result.ok ? { spaceId, since, entities: result.entities } : { error: 'x' },
          result.status,
        );
      }

      return jsonResponse({ error: 'not found' }, 404);
    }) as typeof fetch;

    return () => {
      globalThis.fetch = original;
    };
  }
}

function bearerFrom(headers: HeadersInit | undefined): string | null {
  if (!headers) return null;
  let value: string | null = null;
  if (headers instanceof Headers) value = headers.get('Authorization');
  else if (Array.isArray(headers)) value = headers.find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? null;
  else value = (headers as Record<string, string>)['Authorization'] ?? null;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1]!.trim() : null;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
