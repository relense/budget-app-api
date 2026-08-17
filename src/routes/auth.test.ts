import { describe, expect, it, jest } from '@jest/globals';
import fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { signAccessToken } from '../lib/jwt.js';
import { OtpVerificationError, RefreshTokenError } from '../services/auth/authService.js';
import { registerAuthRoutes } from './auth.js';

const JWT_SECRET = 'test-secret-at-least-32-bytes-long-for-hs256';

function fakeAuthService() {
  return {
    requestOtp: jest.fn(async (_email: string): Promise<void> => undefined),
    verifyOtp: jest.fn(
      async (_input: {
        email: string;
        code: string;
        deviceLabel?: string;
      }): Promise<{
        tokens: { accessToken: string; refreshToken: string };
        user: { id: string; email: string };
      }> => ({
        tokens: { accessToken: 'access-token', refreshToken: 'refresh-token' },
        user: { id: 'user-1', email: 'user@example.com' },
      }),
    ),
    refreshSession: jest.fn(
      async (_token: string): Promise<{ accessToken: string; refreshToken: string }> => ({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      }),
    ),
    logout: jest.fn(async (_token: string): Promise<void> => undefined),
    logoutAll: jest.fn(async (_userId: string): Promise<void> => undefined),
  };
}

function buildTestApp(authService: ReturnType<typeof fakeAuthService>) {
  const app = fastify({ logger: false });
  return app
    .register(rateLimit, { global: false })
    .register(async (instance) => {
      await registerAuthRoutes(instance, { authService, jwtSecret: JWT_SECRET });
    })
    .ready()
    .then(() => app);
}

describe('POST /auth/request-otp', () => {
  it('accepts a valid email and returns 200', async () => {
    const authService = fakeAuthService();
    const app = await buildTestApp(authService);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      payload: { email: 'user@example.com' },
    });

    expect(response.statusCode).toBe(200);
    expect(authService.requestOtp).toHaveBeenCalledWith('user@example.com');

    await app.close();
  });

  it('rejects an invalid email with 400', async () => {
    const authService = fakeAuthService();
    const app = await buildTestApp(authService);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      payload: { email: 'not-an-email' },
    });

    expect(response.statusCode).toBe(400);
    expect(authService.requestOtp).not.toHaveBeenCalled();

    await app.close();
  });

  it('rate-limits after 3 requests for the same IP + email within the window', async () => {
    const authService = fakeAuthService();
    const app = await buildTestApp(authService);

    for (let i = 0; i < 3; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/request-otp',
        payload: { email: 'user@example.com' },
      });
      expect(response.statusCode).toBe(200);
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      payload: { email: 'user@example.com' },
    });
    expect(limited.statusCode).toBe(429);

    await app.close();
  });

  it('does not rate-limit a different email from the same IP', async () => {
    const authService = fakeAuthService();
    const app = await buildTestApp(authService);

    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/auth/request-otp',
        payload: { email: 'user@example.com' },
      });
    }

    const response = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      payload: { email: 'someone-else@example.com' },
    });
    expect(response.statusCode).toBe(200);

    await app.close();
  });
});

describe('POST /auth/verify-otp', () => {
  it('returns tokens and user on success', async () => {
    const authService = fakeAuthService();
    const app = await buildTestApp(authService);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { email: 'user@example.com', code: '123456', deviceLabel: "Miguel's iPhone" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      user: { id: 'user-1', email: 'user@example.com' },
    });
    expect(authService.verifyOtp).toHaveBeenCalledWith({
      email: 'user@example.com',
      code: '123456',
      deviceLabel: "Miguel's iPhone",
    });

    await app.close();
  });

  it('rejects a malformed code with 400', async () => {
    const authService = fakeAuthService();
    const app = await buildTestApp(authService);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { email: 'user@example.com', code: '12' },
    });

    expect(response.statusCode).toBe(400);
    expect(authService.verifyOtp).not.toHaveBeenCalled();

    await app.close();
  });

  it.each([
    ['not_found', 'code_not_found'],
    ['expired', 'code_expired'],
    ['too_many_attempts', 'too_many_attempts'],
    ['incorrect_code', 'incorrect_code'],
  ] as const)(
    'maps OtpVerificationError(%s) to 401 with error=%s',
    async (reason, expectedError) => {
      const authService = fakeAuthService();
      authService.verifyOtp.mockRejectedValueOnce(new OtpVerificationError(reason, 3));
      const app = await buildTestApp(authService);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/verify-otp',
        payload: { email: 'user@example.com', code: '123456' },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe(expectedError);

      await app.close();
    },
  );
});

describe('POST /auth/refresh', () => {
  it('returns new tokens on success', async () => {
    const authService = fakeAuthService();
    const app = await buildTestApp(authService);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: 'a-refresh-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
    expect(authService.refreshSession).toHaveBeenCalledWith('a-refresh-token');

    await app.close();
  });

  it.each([
    ['not_found', 'refresh_token_invalid'],
    ['revoked', 'refresh_token_invalid'],
    ['expired', 'refresh_token_invalid'],
  ] as const)('maps RefreshTokenError(%s) to 401', async (reason, _expectedError) => {
    const authService = fakeAuthService();
    authService.refreshSession.mockRejectedValueOnce(new RefreshTokenError(reason));
    const app = await buildTestApp(authService);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: 'bad-token' },
    });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});

describe('POST /auth/logout', () => {
  it('revokes the given token and returns 204', async () => {
    const authService = fakeAuthService();
    const app = await buildTestApp(authService);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: 'a-refresh-token' },
    });

    expect(response.statusCode).toBe(204);
    expect(authService.logout).toHaveBeenCalledWith('a-refresh-token');

    await app.close();
  });
});

describe('POST /auth/logout-all', () => {
  it('revokes every token for the authenticated user and returns 204', async () => {
    const authService = fakeAuthService();
    const app = await buildTestApp(authService);
    const accessToken = await signAccessToken({ userId: 'user-1' }, JWT_SECRET);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout-all',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(204);
    expect(authService.logoutAll).toHaveBeenCalledWith('user-1');

    await app.close();
  });

  it('returns 401 without a valid access token', async () => {
    const authService = fakeAuthService();
    const app = await buildTestApp(authService);

    const response = await app.inject({ method: 'POST', url: '/auth/logout-all' });

    expect(response.statusCode).toBe(401);
    expect(authService.logoutAll).not.toHaveBeenCalled();

    await app.close();
  });
});
