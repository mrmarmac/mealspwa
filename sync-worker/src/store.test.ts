import { describe, expect, it } from 'vitest';
import {
  authDecision,
  bearerToken,
  parsePushBody,
  sha256Hex,
  shouldWrite,
  type RemoteEntity,
} from './store';

describe('shouldWrite (last-write-wins)', () => {
  it('writes when the server holds nothing', () => {
    expect(shouldWrite(undefined, '000000000000001-0001-a')).toBe(true);
  });

  it('writes only a strictly-newer HLC', () => {
    const older = '000000000000001-0001-a';
    const newer = '000000000000002-0000-a';
    expect(shouldWrite(older, newer)).toBe(true);
    expect(shouldWrite(newer, older)).toBe(false);
  });

  it('does not write an equal HLC (incumbent wins ties)', () => {
    const hlc = '000000000000001-0001-a';
    expect(shouldWrite(hlc, hlc)).toBe(false);
  });

  it('breaks ties by the trailing clientId, matching the client', () => {
    // Same epoch + counter; clientId is the final segment, so lexical order
    // decides — exactly as the client's hlcCompare does.
    const a = '000000000000001-0001-aaaa';
    const b = '000000000000001-0001-bbbb';
    expect(shouldWrite(a, b)).toBe(true);
    expect(shouldWrite(b, a)).toBe(false);
  });
});

describe('authDecision (trust-on-first-use)', () => {
  it('registers an unknown space', () => {
    expect(authDecision(undefined, 'hash')).toBe('register');
  });
  it('accepts a matching token', () => {
    expect(authDecision('hash', 'hash')).toBe('accept');
  });
  it('rejects a mismatched token', () => {
    expect(authDecision('hash', 'other')).toBe('reject');
  });
});

describe('bearerToken', () => {
  it('parses a Bearer header', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
    expect(bearerToken('bearer abc123')).toBe('abc123');
  });
  it('returns null for missing or malformed headers', () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken('abc123')).toBeNull();
    expect(bearerToken('Basic abc123')).toBeNull();
  });
});

describe('sha256Hex', () => {
  it('produces the known SHA-256 of the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  it('is stable and 64 hex chars', async () => {
    const h = await sha256Hex('a-secret-token');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex('a-secret-token')).toBe(h);
  });
});

describe('parsePushBody', () => {
  const entity: RemoteEntity = { id: 'r1', spaceId: 's1', updatedAt: '000-0-a' };

  it('accepts a well-formed body', () => {
    expect(parsePushBody({ spaceId: 's1', entities: [entity] })).toEqual({
      spaceId: 's1',
      entities: [entity],
    });
  });
  it('accepts an empty entities array', () => {
    expect(parsePushBody({ spaceId: 's1', entities: [] })).toEqual({
      spaceId: 's1',
      entities: [],
    });
  });
  it('rejects a missing/blank spaceId', () => {
    expect(parsePushBody({ entities: [] })).toBeNull();
    expect(parsePushBody({ spaceId: '', entities: [] })).toBeNull();
  });
  it('rejects entities that are not shaped like Syncables', () => {
    expect(parsePushBody({ spaceId: 's1', entities: [{ id: 'r1' }] })).toBeNull();
    expect(parsePushBody({ spaceId: 's1', entities: 'nope' })).toBeNull();
  });
  it('rejects non-objects', () => {
    expect(parsePushBody(null)).toBeNull();
    expect(parsePushBody('nope')).toBeNull();
  });
});
