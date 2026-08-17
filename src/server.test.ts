import { describe, expect, it } from '@jest/globals';
import type { Env } from './lib/env.js';
import { buildServer } from './server.js';

const testEnv: Env = {
  NODE_ENV: 'test',
  PORT: 4000,
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/budget_app',
  CORS_ORIGIN: 'http://localhost:19006',
};

function fakePrisma(queryRaw: () => Promise<unknown>) {
  return { $queryRaw: queryRaw } as unknown as import('./lib/prisma.js').PrismaClient;
}

describe('buildServer', () => {
  it('GET /health returns 200 when the database check succeeds', async () => {
    const app = await buildServer({ env: testEnv, prisma: fakePrisma(async () => [{ 1: 1 }]) });

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
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error' });

    await app.close();
  });

  it('POST /graphql resolves Query.ping', async () => {
    const app = await buildServer({ env: testEnv, prisma: fakePrisma(async () => [{ 1: 1 }]) });

    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: '{ ping }' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { ping: 'pong' } });

    await app.close();
  });

  it('sets CORS headers for the configured origin', async () => {
    const app = await buildServer({ env: testEnv, prisma: fakePrisma(async () => [{ 1: 1 }]) });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: testEnv.CORS_ORIGIN },
    });

    expect(response.headers['access-control-allow-origin']).toBe(testEnv.CORS_ORIGIN);

    await app.close();
  });

  it('sets baseline security headers via helmet', async () => {
    const app = await buildServer({ env: testEnv, prisma: fakePrisma(async () => [{ 1: 1 }]) });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');

    await app.close();
  });

  it('rejects introspection queries in production', async () => {
    const app = await buildServer({
      env: { ...testEnv, NODE_ENV: 'production' },
      prisma: fakePrisma(async () => [{ 1: 1 }]),
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
    const app = await buildServer({ env: testEnv, prisma: fakePrisma(async () => [{ 1: 1 }]) });

    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query: '{ __schema { queryType { name } } }' },
    });

    const body = response.json();
    expect(body.errors).toBeUndefined();

    await app.close();
  });
});
