import { describe, expect, it } from '@jest/globals';
import { SignJWT } from 'jose';
import { resolveBearerUserId, signAccessToken, verifyAccessToken } from '../../src/lib/jwt.js';

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

describe('resolveBearerUserId', () => {
  it('returns the userId for a well-formed Bearer header with a valid token', async () => {
    const token = await signAccessToken({ userId: 'user-123' }, SECRET);

    const result = await resolveBearerUserId({ headers: { authorization: `Bearer ${token}` } }, SECRET);

    expect(result).toBe('user-123');
  });

  it('returns null when there is no Authorization header', async () => {
    const result = await resolveBearerUserId({ headers: {} }, SECRET);

    expect(result).toBeNull();
  });

  it('returns null when the header is missing the "Bearer " prefix', async () => {
    const token = await signAccessToken({ userId: 'user-123' }, SECRET);

    const result = await resolveBearerUserId({ headers: { authorization: token } }, SECRET);

    expect(result).toBeNull();
  });

  it('returns null for a wrong-case prefix ("bearer" instead of "Bearer")', async () => {
    const token = await signAccessToken({ userId: 'user-123' }, SECRET);

    const result = await resolveBearerUserId({ headers: { authorization: `bearer ${token}` } }, SECRET);

    expect(result).toBeNull();
  });

  it('returns null for "Bearer " with an empty token', async () => {
    const result = await resolveBearerUserId({ headers: { authorization: 'Bearer ' } }, SECRET);

    expect(result).toBeNull();
  });

  it('returns null for a validly-prefixed but invalid/expired token', async () => {
    const result = await resolveBearerUserId({ headers: { authorization: 'Bearer not-a-jwt' } }, SECRET);

    expect(result).toBeNull();
  });
});
