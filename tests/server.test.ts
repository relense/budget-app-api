import { describe, expect, it, jest } from '@jest/globals';
import type { Env } from '../src/lib/env.js';
import { buildServer } from '../src/server.js';
import type { AuthCleanupService } from '../src/services/auth/authCleanupService.js';
import type { AuthService } from '../src/services/auth/authService.js';

const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 4000,
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/budget_app',
  CORS_ORIGIN: 'http://localhost:19006',
  JWT_SECRET: 'a'.repeat(32),
};

function fakePrisma(queryRaw: () => Promise<unknown>) {
  return { $queryRaw: queryRaw } as unknown as import('../src/lib/prisma.js').PrismaClient;
}

const authService: Pick<
  AuthService,
  'requestOtp' | 'verifyOtp' | 'refreshSession' | 'logout' | 'logoutAll'
> = {
  requestOtp: jest.fn(async () => undefined),
  verifyOtp: jest.fn(),
  refreshSession: jest.fn(),
  logout: jest.fn(async () => undefined),
  logoutAll: jest.fn(async () => undefined),
} as never;

const authCleanupService: Pick<AuthCleanupService, 'cleanupExpiredAuthRecords'> = {
  cleanupExpiredAuthRecords: jest.fn(async () => ({ otpCodesDeleted: 0, refreshTokensDeleted: 0 })),
};

describe('buildServer', () => {
  it('GET /health returns 200 when the database check succeeds', async () => {
    const app = await buildServer({
      env: testEnv,
      prisma: fakePrisma(async () => [{ 1: 1 }]),
      authService,
      authCleanupService,
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });

    await app.close();
  });

  it('GET /health returns 503 when the database check fails', async () => {
    const app = await buildServer({
      env: testEnv,
      prisma: fakePrisma(async () => {
        throw new Error('connection refused');
      }),
      authService,
      authCleanupService,
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error' });

    await app.close();
  });

  it('POST /graphql resolves Query.ping', async () => {
    const app = await buildServer({
      env: testEnv,
      prisma: fakePrisma(async () => [{ 1: 1 }]),
      authService,
      authCleanupService,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: '{ ping }' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { ping: 'pong' } });

    await app.close();
  });

  it('POST /graphql still resolves ping with a malformed Authorization header', async () => {
    const app = await buildServer({
      env: testEnv,
      prisma: fakePrisma(async () => [{ 1: 1 }]),
      authService,
      authCleanupService,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: '{ ping }' },
      headers: { authorization: 'Bearer not-a-real-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { ping: 'pong' } });

    await app.close();
  });

  it('sets CORS headers for the configured origin', async () => {
    const app = await buildServer({
      env: testEnv,
      prisma: fakePrisma(async () => [{ 1: 1 }]),
      authService,
      authCleanupService,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: testEnv.CORS_ORIGIN },
    });

    expect(response.headers['access-control-allow-origin']).toBe(testEnv.CORS_ORIGIN);

    await app.close();
  });

  it('sets baseline security headers via helmet', async () => {
    const app = await buildServer({
      env: testEnv,
      prisma: fakePrisma(async () => [{ 1: 1 }]),
      authService,
      authCleanupService,
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');

    await app.close();
  });

  it('rejects introspection queries in production', async () => {
    const app = await buildServer({
      env: { ...testEnv, NODE_ENV: 'production' },
      prisma: fakePrisma(async () => [{ 1: 1 }]),
      authService,
      authCleanupService,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: '{ __schema { queryType { name } } }' },
    });

    const body = response.json();
    expect(body.errors).toBeDefined();

    await app.close();
  });

  it('allows introspection queries outside production', async () => {
    const app = await buildServer({
      env: testEnv,
      prisma: fakePrisma(async () => [{ 1: 1 }]),
      authService,
      authCleanupService,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: '{ __schema { queryType { name } } }' },
    });

    const body = response.json();
    expect(body.errors).toBeUndefined();

    await app.close();
  });

  it('rejects a query deeper than the configured max depth (validation, not just a slow response)', async () => {
    const app = await buildServer({
      env: testEnv,
      prisma: fakePrisma(async () => [{ 1: 1 }]),
      authService,
      authCleanupService,
    });

    // SavingsFund.movements -> SavingsMovement.fund is a cycle, so nesting
    // it repeatedly builds an arbitrarily deep query with no real-world
    // equivalent — 12 levels here, past MAX_QUERY_DEPTH (10) in server.ts.
    // No Authorization header needed: depth-limit is a validation rule,
    // enforced before execution/resolvers (and auth checks inside them)
    // ever run.
    const deepQuery = `{
      savingsFunds { movements { fund { movements { fund { movements {
        fund { movements { fund { movements { fund { movements { id } } } } } }
      } } } } } }
    }`;

    const response = await app.inject({ method: 'POST', url: '/graphql', payload: { query: deepQuery } });

    const body = response.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toMatch(/exceeds maximum operation depth/i);

    await app.close();
  });
});
