/**
 * Meals sync Worker.
 *
 *   POST /push   { spaceId, entities: Syncable[] }   Authorization: Bearer <token>
 *     -> { acceptedIds: string[] }
 *   GET  /pull?spaceId=<id>&since=<hlc>              Authorization: Bearer <token>
 *     -> { spaceId, since, entities: Syncable[] }
 *
 * A deliberately "dumb" backend for the app's already-built CRDT layer: it
 * stores the latest-by-HLC row per (spaceId, id) and serves deltas by HLC. It
 * NEVER re-stamps timestamps — clients own the hybrid logical clock, and a
 * client will reject a server-invented future HLC (see MAX_SKEW_MS client
 * side). Conflict resolution is the same last-write-wins the client runs on
 * pull; the server's per-row LWW upsert is just an optimisation so the table
 * only ever holds the newest version.
 *
 * Storage is Cloudflare D1 (the repo's first stateful binding). This is a
 * SEPARATE worker from the recipe fetcher, which is deliberately stateless —
 * anything needing storage does not belong there.
 *
 * See sync-worker/README.md for deploy steps and the (honest) threat model of
 * the per-space capability token.
 */
import {
  authDecision,
  bearerToken,
  LIMITS,
  parsePushBody,
  sha256Hex,
  type RemoteEntity,
} from './store';

// --- Minimal D1 typings ----------------------------------------------------
// The subset this worker uses. Wrangler provides the real runtime; these exist
// only so `tsc`/editors understand `env.DB` without pulling in a dependency.
interface D1Result<T> {
  results: T[];
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}
interface Env {
  DB: D1Database;
}

// --- CORS ------------------------------------------------------------------
// Restricted to the Pages origin this app is deployed at, plus localhost for
// dev. Mirrors the recipe-fetcher worker, but also allows the Authorization
// header (this endpoint is authenticated) and the POST method.
const ALLOWED_ORIGIN_EXACT = new Set(['https://mrmarmac.github.io']);
const ALLOWED_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function isAllowedOrigin(origin: string | null): origin is string {
  if (!origin) return false;
  return ALLOWED_ORIGIN_EXACT.has(origin) || ALLOWED_ORIGIN_PATTERN.test(origin);
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
  if (isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function errorResponse(status: number, error: string, origin: string | null): Response {
  // Only ever our own short, fixed strings — never a storage/internal detail.
  return jsonResponse({ error }, status, origin);
}

// --- Auth ------------------------------------------------------------------

async function tokenHashFor(request: Request): Promise<string | null> {
  const token = bearerToken(request.headers.get('Authorization'));
  return token ? sha256Hex(token) : null;
}

async function storedTokenHash(env: Env, spaceId: string): Promise<string | undefined> {
  const row = await env.DB.prepare('SELECT token_hash FROM spaces WHERE space_id = ?1')
    .bind(spaceId)
    .first<{ token_hash: string }>();
  return row?.token_hash ?? undefined;
}

/** Current number of stored rows for a space (for the per-space row cap). */
async function spaceRowCount(env: Env, spaceId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM entities WHERE space_id = ?1')
    .bind(spaceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Of the given ids, which already exist as rows in the space. Used to
 *  distinguish new inserts (which count against MAX_ROWS_PER_SPACE) from
 *  updates to existing rows (which don't grow the table). */
async function existingIds(env: Env, spaceId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map((_, i) => `?${i + 2}`).join(', ');
  const rows = await env.DB.prepare(
    `SELECT id FROM entities WHERE space_id = ?1 AND id IN (${placeholders})`,
  )
    .bind(spaceId, ...ids)
    .all<{ id: string }>();
  return new Set(rows.results.map((r) => r.id));
}

// --- Handlers --------------------------------------------------------------

const UPSERT_SQL =
  'INSERT INTO entities (space_id, id, updated_at, body) VALUES (?1, ?2, ?3, ?4) ' +
  'ON CONFLICT(space_id, id) DO UPDATE SET updated_at = excluded.updated_at, body = excluded.body ' +
  'WHERE excluded.updated_at > entities.updated_at';

async function handlePush(request: Request, env: Env, origin: string | null): Promise<Response> {
  const presentedHash = await tokenHashFor(request);
  if (!presentedHash) return errorResponse(401, 'Missing bearer token', origin);

  // Cheap up-front reject for oversized bodies: trust Content-Length if the
  // client sent an honest one, then re-check against the actual bytes read so
  // a lying/absent header can't slip a huge payload past the cap.
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > LIMITS.MAX_PUSH_BODY_BYTES) {
    return errorResponse(413, 'Push body too large', origin);
  }
  const text = await request.text();
  if (text.length > LIMITS.MAX_PUSH_BODY_BYTES) {
    return errorResponse(413, 'Push body too large', origin);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return errorResponse(400, 'Malformed JSON body', origin);
  }
  const body = parsePushBody(raw);
  if (!body) return errorResponse(400, 'Invalid push body', origin);

  const decision = authDecision(await storedTokenHash(env, body.spaceId), presentedHash);
  if (decision === 'reject') return errorResponse(401, 'Bad token for this space', origin);
  if (decision === 'register') {
    await env.DB.prepare(
      'INSERT INTO spaces (space_id, token_hash, created_at) VALUES (?1, ?2, ?3) ' +
        'ON CONFLICT(space_id) DO NOTHING',
    )
      .bind(body.spaceId, presentedHash, new Date().toISOString())
      .run();
    // Guard against a concurrent registration binding a different token.
    if ((await storedTokenHash(env, body.spaceId)) !== presentedHash) {
      return errorResponse(401, 'Bad token for this space', origin);
    }
  }

  // Only entities that actually belong to this space; ignore any smuggled in
  // under a different spaceId rather than trusting the row's own field.
  const owned: RemoteEntity[] = body.entities.filter((e) => e.spaceId === body.spaceId);

  // Serialize once, and reject the whole push if any single blob is oversized
  // — one giant entity is the cheap way to bloat a space past the row cap.
  const serialized = new Map<string, string>();
  for (const e of owned) {
    const blob = JSON.stringify(e);
    if (blob.length > LIMITS.MAX_ENTITY_BODY_BYTES) {
      return errorResponse(413, 'Entity too large', origin);
    }
    serialized.set(e.id, blob);
  }

  // Per-space row cap: updates to rows that already exist are always fine
  // (they don't grow the table), but inserting new ids past the cap is not.
  if (owned.length > 0) {
    const present = await existingIds(
      env,
      body.spaceId,
      owned.map((e) => e.id),
    );
    const newInserts = owned.filter((e) => !present.has(e.id)).length;
    if (newInserts > 0) {
      const room = LIMITS.MAX_ROWS_PER_SPACE - (await spaceRowCount(env, body.spaceId));
      if (newInserts > room) {
        return errorResponse(413, 'Space is full', origin);
      }
    }

    const statements = owned.map((e) =>
      env.DB.prepare(UPSERT_SQL).bind(body.spaceId, e.id, e.updatedAt, serialized.get(e.id)!),
    );
    await env.DB.batch(statements);
  }

  // Accept every owned id regardless of whether it won the LWW compare, so the
  // client's outbox drains (an older-losing push is still "handled").
  return jsonResponse({ acceptedIds: owned.map((e) => e.id) }, 200, origin);
}

async function handlePull(request: Request, env: Env, origin: string | null): Promise<Response> {
  const presentedHash = await tokenHashFor(request);
  if (!presentedHash) return errorResponse(401, 'Missing bearer token', origin);

  const url = new URL(request.url);
  const spaceId = url.searchParams.get('spaceId');
  if (!spaceId) return errorResponse(400, 'Missing "spaceId" query parameter', origin);
  const since = url.searchParams.get('since') ?? '';

  const existing = await storedTokenHash(env, spaceId);
  // Unknown space => nothing has ever been pushed; there is nothing to serve
  // and no bound token to check against, so return an empty (authenticated-
  // shaped) packet rather than leaking whether the space exists.
  if (existing !== undefined && existing !== presentedHash) {
    return errorResponse(401, 'Bad token for this space', origin);
  }

  const rows = await env.DB.prepare(
    "SELECT body FROM entities WHERE space_id = ?1 AND (?2 = '' OR updated_at > ?2) ORDER BY updated_at",
  )
    .bind(spaceId, since)
    .all<{ body: string }>();

  const entities: unknown[] = [];
  for (const row of rows.results) {
    try {
      entities.push(JSON.parse(row.body));
    } catch {
      // A corrupt row must not sink the whole pull — skip it.
    }
  }

  return jsonResponse({ spaceId, since: since === '' ? null : since, entities }, 200, origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method === 'POST' && pathname === '/push') {
      return handlePush(request, env, origin);
    }
    if (request.method === 'GET' && pathname === '/pull') {
      return handlePull(request, env, origin);
    }
    return errorResponse(404, 'Not found', origin);
  },
};
