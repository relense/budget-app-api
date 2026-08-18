import { describe, expect, it } from '@jest/globals';
import { generateRefreshToken, hashRefreshToken } from './refreshToken.js';

describe('generateRefreshToken', () => {
  it('returns a 64-character hex string (32 random bytes)', () => {
    const token = generateRefreshToken();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a different token on each call', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();

    expect(a).not.toBe(b);
  });
});

describe('hashRefreshToken', () => {
  it('is deterministic for the same input', () => {
    const token = generateRefreshToken();

    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
  });

  it('produces different hashes for different tokens', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();

    expect(hashRefreshToken(a)).not.toBe(hashRefreshToken(b));
  });
});
