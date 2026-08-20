import { describe, expect, it, jest } from '@jest/globals';
import { createAuthCleanupService } from '../../../src/services/auth/authCleanupService.js';
import { createFakePrisma, type FakeOtpCode, type FakeRefreshToken } from './testFakePrisma.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function otpCode(overrides: Partial<FakeOtpCode> = {}): FakeOtpCode {
  return {
    id: overrides.id ?? `otp-${Math.random()}`,
    email: 'user@example.com',
    codeHash: 'hash',
    expiresAt: new Date('2026-01-01T00:10:00.000Z'),
    used: false,
    failedAttempts: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function refreshToken(overrides: Partial<FakeRefreshToken> = {}): FakeRefreshToken {
  return {
    id: overrides.id ?? `rt-${Math.random()}`,
    userId: 'user-1',
    tokenHash: 'hash',
    deviceLabel: null,
    expiresAt: new Date('2026-02-01T00:00:00.000Z'),
    revoked: false,
    ...overrides,
  };
}

function setup(batchSize?: number) {
  const prisma = createFakePrisma();
  const cleanupService = createAuthCleanupService({
    prisma: prisma as never,
    now: () => NOW,
    ...(batchSize !== undefined ? { batchSize } : {}),
  });
  return { prisma, cleanupService };
}

describe('cleanupExpiredAuthRecords', () => {
  it('deletes expired otp codes and leaves unexpired ones alone', async () => {
    const { prisma, cleanupService } = setup();
    prisma.otpCodes.push(
      otpCode({ id: 'expired', expiresAt: new Date('2025-12-31T23:00:00.000Z') }),
      otpCode({ id: 'still-valid', expiresAt: new Date('2026-01-01T00:10:00.000Z') }),
    );

    const result = await cleanupService.cleanupExpiredAuthRecords();

    expect(prisma.otpCodes.map((row) => row.id)).toEqual(['still-valid']);
    expect(result.otpCodesDeleted).toBe(1);
  });

  it('deletes used otp codes even when not yet expired', async () => {
    const { prisma, cleanupService } = setup();
    prisma.otpCodes.push(
      otpCode({ id: 'used', used: true, expiresAt: new Date('2026-01-01T00:10:00.000Z') }),
      otpCode({ id: 'unused', used: false, expiresAt: new Date('2026-01-01T00:10:00.000Z') }),
    );

    const result = await cleanupService.cleanupExpiredAuthRecords();

    expect(prisma.otpCodes.map((row) => row.id)).toEqual(['unused']);
    expect(result.otpCodesDeleted).toBe(1);
  });

  it('deletes expired refresh tokens and leaves unexpired ones alone', async () => {
    const { prisma, cleanupService } = setup();
    prisma.refreshTokens.push(
      refreshToken({ id: 'expired', expiresAt: new Date('2025-12-31T23:00:00.000Z') }),
      refreshToken({ id: 'still-valid', expiresAt: new Date('2026-02-01T00:00:00.000Z') }),
    );

    const result = await cleanupService.cleanupExpiredAuthRecords();

    expect(prisma.refreshTokens.map((row) => row.id)).toEqual(['still-valid']);
    expect(result.refreshTokensDeleted).toBe(1);
  });

  it('deletes revoked refresh tokens even when not yet expired', async () => {
    const { prisma, cleanupService } = setup();
    prisma.refreshTokens.push(
      refreshToken({ id: 'revoked', revoked: true }),
      refreshToken({ id: 'active', revoked: false }),
    );

    const result = await cleanupService.cleanupExpiredAuthRecords();

    expect(prisma.refreshTokens.map((row) => row.id)).toEqual(['active']);
    expect(result.refreshTokensDeleted).toBe(1);
  });

  it('leaves valid, unused/unrevoked rows alone entirely', async () => {
    const { prisma, cleanupService } = setup();
    prisma.otpCodes.push(otpCode({ id: 'keep' }));
    prisma.refreshTokens.push(refreshToken({ id: 'keep' }));

    const result = await cleanupService.cleanupExpiredAuthRecords();

    expect(prisma.otpCodes).toHaveLength(1);
    expect(prisma.refreshTokens).toHaveLength(1);
    expect(result).toEqual({ otpCodesDeleted: 0, refreshTokensDeleted: 0 });
  });

  it('does not double-count a row that matches both delete conditions at once', async () => {
    const { prisma, cleanupService } = setup();
    prisma.otpCodes.push(
      otpCode({
        id: 'expired-and-used',
        used: true,
        expiresAt: new Date('2025-12-31T23:00:00.000Z'),
      }),
    );
    prisma.refreshTokens.push(
      refreshToken({
        id: 'expired-and-revoked',
        revoked: true,
        expiresAt: new Date('2025-12-31T23:00:00.000Z'),
      }),
    );

    const result = await cleanupService.cleanupExpiredAuthRecords();

    expect(prisma.otpCodes).toHaveLength(0);
    expect(prisma.refreshTokens).toHaveLength(0);
    expect(result).toEqual({ otpCodesDeleted: 1, refreshTokensDeleted: 1 });
  });

  it('deletes every eligible row across multiple batches, not just the first batch', async () => {
    const { prisma, cleanupService } = setup(2);
    for (let i = 0; i < 5; i += 1) {
      prisma.otpCodes.push(
        otpCode({ id: `expired-${i}`, expiresAt: new Date('2025-12-31T23:00:00.000Z') }),
      );
    }

    const result = await cleanupService.cleanupExpiredAuthRecords();

    expect(prisma.otpCodes).toHaveLength(0);
    expect(result.otpCodesDeleted).toBe(5);
  });

  it('terminates correctly when the eligible count is an exact multiple of batchSize', async () => {
    const { prisma, cleanupService } = setup(2);
    const findManySpy = jest.spyOn(prisma.otpCode, 'findMany');
    for (let i = 0; i < 4; i += 1) {
      prisma.otpCodes.push(
        otpCode({ id: `expired-${i}`, expiresAt: new Date('2025-12-31T23:00:00.000Z') }),
      );
    }

    const result = await cleanupService.cleanupExpiredAuthRecords();

    expect(prisma.otpCodes).toHaveLength(0);
    expect(result.otpCodesDeleted).toBe(4);
    // A full batch (length === batchSize) must trigger one more round-trip
    // to confirm nothing's left, rather than assuming it was the last page:
    // 3 calls to drain the 4 expired rows (2, 2, 0), plus 1 more for the
    // separate "used" pass finding nothing.
    expect(findManySpy).toHaveBeenCalledTimes(4);
  });

  it('terminates correctly with batchSize 1', async () => {
    const { prisma, cleanupService } = setup(1);
    const findManySpy = jest.spyOn(prisma.otpCode, 'findMany');
    prisma.otpCodes.push(
      otpCode({ id: 'expired-a', expiresAt: new Date('2025-12-31T23:00:00.000Z') }),
      otpCode({ id: 'expired-b', expiresAt: new Date('2025-12-31T23:00:00.000Z') }),
    );

    const result = await cleanupService.cleanupExpiredAuthRecords();

    expect(prisma.otpCodes).toHaveLength(0);
    expect(result.otpCodesDeleted).toBe(2);
    // 3 calls to drain the 2 rows one at a time (1, 1, 0), plus 1 more for
    // the separate "used" pass finding nothing.
    expect(findManySpy).toHaveBeenCalledTimes(4);
  });
});
