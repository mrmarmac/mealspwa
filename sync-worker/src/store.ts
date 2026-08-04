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
    typeof v['spaceId'] === 'string' &&
    typeof v['updatedAt'] === 'string'
  );
}

/** Validate and narrow a parsed `/push` body. Returns null on any shape
 *  mismatch so the handler can answer 400 without trusting the input. */
export function parsePushBody(value: unknown): PushBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['spaceId'] !== 'string' || v['spaceId'].length === 0) return null;
  if (!Array.isArray(v['entities'])) return null;
  if (!v['entities'].every(isRemoteEntity)) return null;
  return { spaceId: v['spaceId'], entities: v['entities'] as RemoteEntity[] };
}
