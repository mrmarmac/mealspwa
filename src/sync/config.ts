/**
 * Device-local sync configuration and the join-code codec.
 *
 * The per-space capability token is the credential that authorises this device
 * against the sync worker. It is stored in the `meta` store (device-local) and
 * is deliberately NEVER a synced entity — the server only ever sees its hash,
 * and a second device receives it out-of-band via a join code, not through
 * sync. Keeping it out of `Space.settings` (which syncs) avoids that circularity.
 */
import { getMeta, setMeta } from '@/db/repo';
import type { Id } from '@/domain/primitives';

const SYNC_CONFIG_META_KEY = 'syncConfig';

export interface SyncConfig {
  /** The space this device is syncing. Must equal the active space id for the
   *  remote adapter to be selected. */
  spaceId: Id;
  /** The per-space capability token (base64url, 128-bit). */
  token: string;
  enabledAt: string;
}

export async function getSyncConfig(): Promise<SyncConfig | undefined> {
  const cfg = await getMeta<SyncConfig | null>(SYNC_CONFIG_META_KEY);
  return cfg ?? undefined;
}

export async function setSyncConfig(config: SyncConfig): Promise<void> {
  await setMeta(SYNC_CONFIG_META_KEY, config);
}

export async function clearSyncConfig(): Promise<void> {
  await setMeta<SyncConfig | null>(SYNC_CONFIG_META_KEY, null);
}

/** A fresh 128-bit capability token, base64url-encoded. */
export function generateSyncToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToBase64url(bytes);
}

export interface JoinPayload {
  v: 1;
  spaceId: Id;
  token: string;
}

/** Encode `{ spaceId, token }` as a compact, copy-pasteable join code. The
 *  sync URL is not included — both devices run the same build, so
 *  `VITE_SYNC_URL` is already present on the joining device. */
export function encodeJoinCode(spaceId: Id, token: string): string {
  const payload: JoinPayload = { v: 1, spaceId, token };
  return bytesToBase64url(new TextEncoder().encode(JSON.stringify(payload)));
}

export function decodeJoinCode(code: string): JoinPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64urlToBytes(code.trim())));
  } catch {
    throw new Error('That is not a valid join code.');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as Record<string, unknown>)['v'] !== 1 ||
    typeof (parsed as Record<string, unknown>)['spaceId'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['token'] !== 'string'
  ) {
    throw new Error('That is not a valid join code.');
  }
  const p = parsed as Record<string, unknown>;
  return { v: 1, spaceId: p['spaceId'] as Id, token: p['token'] as string };
}

// --- base64url helpers -----------------------------------------------------

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
