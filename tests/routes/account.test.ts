import { describe, expect, it, jest } from '@jest/globals';
import fastify from 'fastify';
import { signAccessToken } from '../../src/lib/jwt.js';
import { registerAccountRoutes } from '../../src/routes/account.js';
import { AccountServiceError } from '../../src/services/account/accountService.js';

const JWT_SECRET = 'test-secret-at-least-32-bytes-long-for-hs256';

function fakeAccountService() {
  return {
    exportUserData: jest.fn(async (_userId: string) => ({
      account: {
        id: 'user-1',
        email: 'user@example.com',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        bankBalanceCheckpointCents: 0,
        bankBalanceCheckpointSetAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      categories: [],
      budgetMonths: [],
      categoryMonths: [],
      transactions: [],
      recurringExpenses: [],
      savingsFunds: [],
      savingsMovements: [],
    })),
    deleteAccount: jest.fn(async (_userId: string): Promise<void> => undefined),
  };
}

function buildTestApp(accountService: ReturnType<typeof fakeAccountService>) {
  const app = fastify({ logger: false });
  return app
    .register(async (instance) => {
      await registerAccountRoutes(instance, { accountService, jwtSecret: JWT_SECRET });
    })
    .ready()
    .then(() => app);
}

describe('GET /account/export', () => {
  it('returns the export payload for the authenticated user', async () => {
    const accountService = fakeAccountService();
    const app = await buildTestApp(accountService);
    const accessToken = await signAccessToken({ userId: 'user-1' }, JWT_SECRET);

    const response = await app.inject({
      method: 'GET',
      url: '/account/export',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(accountService.exportUserData).toHaveBeenCalledWith('user-1');
    expect(response.json().account.id).toBe('user-1');

    await app.close();
  });

  it('returns 401 without a valid access token', async () => {
    const accountService = fakeAccountService();
    const app = await buildTestApp(accountService);

    const response = await app.inject({ method: 'GET', url: '/account/export' });

    expect(response.statusCode).toBe(401);
    expect(accountService.exportUserData).not.toHaveBeenCalled();

    await app.close();
  });

  it('returns 404 if the account no longer exists', async () => {
    const accountService = fakeAccountService();
    accountService.exportUserData.mockRejectedValueOnce(new AccountServiceError('account_not_found'));
    const app = await buildTestApp(accountService);
    const accessToken = await signAccessToken({ userId: 'user-1' }, JWT_SECRET);

    const response = await app.inject({
      method: 'GET',
      url: '/account/export',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});

describe('DELETE /account', () => {
  it('deletes the account and returns 204 when confirm is true', async () => {
    const accountService = fakeAccountService();
    const app = await buildTestApp(accountService);
    const accessToken = await signAccessToken({ userId: 'user-1' }, JWT_SECRET);

    const response = await app.inject({
      method: 'DELETE',
      url: '/account',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { confirm: true },
    });

    expect(response.statusCode).toBe(204);
    expect(accountService.deleteAccount).toHaveBeenCalledWith('user-1');

    await app.close();
  });

  it('returns 401 without a valid access token', async () => {
    const accountService = fakeAccountService();
    const app = await buildTestApp(accountService);

    const response = await app.inject({
      method: 'DELETE',
      url: '/account',
      payload: { confirm: true },
    });

    expect(response.statusCode).toBe(401);
    expect(accountService.deleteAccount).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects with 400 when confirm is missing, without deleting anything', async () => {
    const accountService = fakeAccountService();
    const app = await buildTestApp(accountService);
    const accessToken = await signAccessToken({ userId: 'user-1' }, JWT_SECRET);

    const response = await app.inject({
      method: 'DELETE',
      url: '/account',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(accountService.deleteAccount).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects with 400 when confirm is false, without deleting anything', async () => {
    const accountService = fakeAccountService();
    const app = await buildTestApp(accountService);
    const accessToken = await signAccessToken({ userId: 'user-1' }, JWT_SECRET);

    const response = await app.inject({
      method: 'DELETE',
      url: '/account',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { confirm: false },
    });

    expect(response.statusCode).toBe(400);
    expect(accountService.deleteAccount).not.toHaveBeenCalled();

    await app.close();
  });

  it('returns 404 if the account no longer exists', async () => {
    const accountService = fakeAccountService();
    accountService.deleteAccount.mockRejectedValueOnce(new AccountServiceError('account_not_found'));
    const app = await buildTestApp(accountService);
    const accessToken = await signAccessToken({ userId: 'user-1' }, JWT_SECRET);

    const response = await app.inject({
      method: 'DELETE',
      url: '/account',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { confirm: true },
    });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
