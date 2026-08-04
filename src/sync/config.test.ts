import { describe, expect, it } from 'vitest';
import { decodeJoinCode, encodeJoinCode, generateSyncToken } from './config';

describe('join code codec', () => {
  it('round-trips a spaceId and token', () => {
    const code = encodeJoinCode('space-abc', 'tok-123');
    expect(decodeJoinCode(code)).toEqual({ v: 1, spaceId: 'space-abc', token: 'tok-123' });
  });

  it('round-trips values with unicode and url-unsafe characters', () => {
    const token = 'a+b/c= día';
    const code = encodeJoinCode('space/xyz', token);
    // The code itself is url-safe base64 (no +, /, or =).
    expect(code).not.toMatch(/[+/=]/);
    expect(decodeJoinCode(code)).toEqual({ v: 1, spaceId: 'space/xyz', token });
  });

  it('tolerates surrounding whitespace when decoding', () => {
    const code = encodeJoinCode('s', 't');
    expect(decodeJoinCode(`  ${code}\n`)).toEqual({ v: 1, spaceId: 's', token: 't' });
  });

  it('rejects garbage', () => {
    expect(() => decodeJoinCode('not-a-real-code!!!')).toThrow();
    expect(() => decodeJoinCode('')).toThrow();
  });
});

describe('generateSyncToken', () => {
  it('produces a url-safe token that differs each call', () => {
    const a = generateSyncToken();
    const b = generateSyncToken();
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/[+/=]/);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });
});
