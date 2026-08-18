import { describe, expect, it } from '@jest/globals';
import { SignJWT } from 'jose';
import { signAccessToken, verifyAccessToken } from './jwt.js';

const SECRET = 'test-secret-at-least-32-bytes-long-for-hs256';

describe('signAccessToken / verifyAccessToken', () => {
  it('round-trips the userId', async () => {
    const token = await signAccessToken({ userId: 'user-123' }, SECRET);

    const result = await verifyAccessToken(token, SECRET);

    expect(result).toEqual({ userId: 'user-123' });
  });

  it('returns null for a token signed with a different secret', async () => {
    const token = await signAccessToken({ userId: 'user-123' }, 'a-completely-different-secret');

    const result = await verifyAccessToken(token, SECRET);

    expect(result).toBeNull();
  });

  it('returns null for a malformed token', async () => {
    const result = await verifyAccessToken('not-a-jwt', SECRET);

    expect(result).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const key = new TextEncoder().encode(SECRET);
    const expiredToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-123')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);

    const result = await verifyAccessToken(expiredToken, SECRET);

    expect(result).toBeNull();
  });
});
