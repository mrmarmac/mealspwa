/**
 * Pure, storage-agnostic logic for the sync worker: the last-write-wins rule,
 * the trust-on-first-use auth decision, request parsing, and hashing. Kept
 * free of any D1/Workers API so it is unit-testable under plain vitest.
 *
 * The server is deliberately "dumb": the client owns the hybrid logical clock
 * and `resolve()` runs client-side on pull, so the server only has to store
 * the latest-by-HLC row per (spaceId, id) and never re-stamp timestamps. The
 * comparison here MUST match the client's `hlcCompare` (a plain lexical string
 * compare — HLC strings are engineered so that lexical order == causal order).
 */

/** The subset of a client `Syncable` the server reads. The full entity is
 *  stored opaquely as a JSON blob; only these fields are ever inspected. */
export interface RemoteEntity {
  id: string;
  spaceId: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface PushBody {
  spaceId: string;
  entities: RemoteEntity[];
}

/**
 * Blast-radius caps. Space creation is unauthenticated (trust-on-first-use),
 * so anyone who knows the worker URL can POST /push with random spaceIds and
 * junk entities. A Cloudflare Rate Limiting rule on the route is the real
 * defense against volume; these bounds cap the damage of any single request
 * that does get through, so D1 rows/bytes and the request quota can't be run
 * up without limit. Deliberately generous — a two-person household never
 * approaches them.
 */
export const LIMITS = {
  /** Reject request bodies larger than this before parsing (Content-Length
   *  and, as a fallback, the read text length). */
  MAX_PUSH_BODY_BYTES: 1_000_000,
  /** Max entities accepted in a single push. */
  MAX_ENTITIES_PER_PUSH: 500,
  /** Max length of a spaceId (a UUID is 36 chars; this is roomy). */
  MAX_SPACE_ID_LENGTH: 200,
  /** Max length of an entity id. */
  MAX_ENTITY_ID_LENGTH: 200,
  /** Max serialized size of a single stored entity blob. */
  MAX_ENTITY_BODY_BYTES: 64_000,
  /** Max rows a single space may hold. New inserts past this are rejected;
   *  updates to existing rows still go through. */
  MAX_ROWS_PER_SPACE: 50_000,
} as const;

/**
 * Last-write-wins: write the incoming entity iff it is strictly newer than
 * what the server holds (or the server holds nothing). Identical to the
 * client's `resolve()` tie-break — a plain string `>` on the HLC. The
 * production path expresses the same rule as a SQL `WHERE excluded.updated_at
 * > entities.updated_at`; this function exists to document and test the rule.
 */
export function shouldWrite(
  currentUpdatedAt: string | undefined,
  incomingUpdatedAt: string,
): boolean {
  if (currentUpdatedAt === undefined) return true;
  return incomingUpdatedAt > currentUpdatedAt;
}

export type AuthDecision = 'register' | 'accept' | 'reject';

/**
 * Trust-on-first-use per space: the first push for an unknown space binds its
 * token; every later request must present the same token. `existingHash` is
 * the stored `sha256(token)` (or undefined if the space is unknown);
 * `presentedHash` is `sha256(bearer token)` from the request.
 */
export function authDecision(
  existingHash: string | undefined,
  presentedHash: string,
): AuthDecision {
  if (existingHash === undefined) return 'register';
  return existingHash === presentedHash ? 'accept' : 'reject';
}

/** Extract the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match ? match[1]!.trim() : null;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function isRemoteEntity(value: unknown): value is RemoteEntity {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    v['id'].length > 0 &&
    v['id'].length <= LIMITS.MAX_ENTITY_ID_LENGTH &&
    typeof v['spaceId'] === 'string' &&
    typeof v['updatedAt'] === 'string'
  );
}

/** Validate and narrow a parsed `/push` body. Returns null on any shape
 *  mismatch or exceeded cap so the handler can answer 400 without trusting
 *  the input. Length/count caps here bound the per-request blast radius. */
export function parsePushBody(value: unknown): PushBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['spaceId'] !== 'string' || v['spaceId'].length === 0) return null;
  if (v['spaceId'].length > LIMITS.MAX_SPACE_ID_LENGTH) return null;
  if (!Array.isArray(v['entities'])) return null;
  if (v['entities'].length > LIMITS.MAX_ENTITIES_PER_PUSH) return null;
  if (!v['entities'].every(isRemoteEntity)) return null;
  return { spaceId: v['spaceId'], entities: v['entities'] as RemoteEntity[] };
}
