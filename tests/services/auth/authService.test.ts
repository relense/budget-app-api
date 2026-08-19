import { describe, expect, it, jest } from '@jest/globals';
import { verifyAccessToken } from '../../../src/lib/jwt.js';
import { hashOtpCode, OTP_CODE_REGEX, verifyOtpCode } from '../../../src/lib/otp.js';
import { hashRefreshToken } from '../../../src/lib/refreshToken.js';
import { createAuthService } from '../../../src/services/auth/authService.js';
import { createFakePrisma } from './testFakePrisma.js';

const JWT_SECRET = 'test-secret-at-least-32-bytes-long-for-hs256';
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_FAILED_ATTEMPTS = 5;

function setup(now = () => new Date('2026-01-01T00:00:00.000Z')) {
  const prisma = createFakePrisma();
  const emailService = {
    sendOtpEmail: jest.fn(async (_email: string, _code: string) => undefined),
  };
  const authService = createAuthService({
    prisma: prisma as never,
    emailService,
    jwtSecret: JWT_SECRET,
    now,
  });
  return { prisma, emailService, authService, now };
}

describe('requestOtp', () => {
  it('normalizes email casing/whitespace even when called directly (not via the route)', async () => {
    const { prisma, emailService, authService } = setup();

    await authService.requestOtp('  User@Example.com  ');

    expect(prisma.otpCodes).toHaveLength(1);
    expect(prisma.otpCodes[0]!.email).toBe('user@example.com');
    const [emailedTo] = emailService.sendOtpEmail.mock.calls[0] as [string, string];
    expect(emailedTo).toBe('user@example.com');
  });

  it('stores a hashed code and emails the plaintext code to the user', async () => {
    const { prisma, emailService, authService, now } = setup();

    await authService.requestOtp('user@example.com');

    expect(prisma.otpCodes).toHaveLength(1);
    const [row] = prisma.otpCodes;
    expect(row!.email).toBe('user@example.com');
    expect(row!.expiresAt.getTime()).toBe(now().getTime() + OTP_TTL_MS);
    expect(row!.used).toBe(false);
    expect(row!.failedAttempts).toBe(0);

    expect(emailService.sendOtpEmail).toHaveBeenCalledTimes(1);
    const [emailedTo, emailedCode] = emailService.sendOtpEmail.mock.calls[0] as [string, string];
    expect(emailedTo).toBe('user@example.com');
    expect(emailedCode).toMatch(OTP_CODE_REGEX);

    await expect(verifyOtpCode(emailedCode, row!.codeHash)).resolves.toBe(true);
  });
});

describe('verifyOtp', () => {
  it('normalizes email casing/whitespace even when called directly (not via the route)', async () => {
    const { prisma, authService } = setup();
    prisma.otpCodes.push({
      id: 'otp-1',
      email: 'user@example.com',
      codeHash: await hashOtpCode('123456'),
      expiresAt: new Date('2026-01-01T00:10:00.000Z'),
      used: false,
      failedAttempts: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const result = await authService.verifyOtp({
      email: '  User@Example.com  ',
      code: '123456',
    });

    expect(result.user.email).toBe('user@example.com');
    expect(prisma.users).toHaveLength(1);
    expect(prisma.users[0]!.email).toBe('user@example.com');
  });

  it('throws not_found when no code was ever requested', async () => {
    const { authService } = setup();

    await expect(
      authService.verifyOtp({ email: 'nobody@example.com', code: '123456' }),
    ).rejects.toMatchObject({
      reason: 'not_found',
    });
  });

  it('throws not_found when the latest code was already used', async () => {
    const { prisma, authService } = setup();
    prisma.otpCodes.push({
      id: 'otp-1',
      email: 'user@example.com',
      codeHash: await hashOtpCode('123456'),
      expiresAt: new Date('2026-01-01T00:10:00.000Z'),
      used: true,
      failedAttempts: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(
      authService.verifyOtp({ email: 'user@example.com', code: '123456' }),
    ).rejects.toMatchObject({ reason: 'not_found' });
  });

  it('throws expired when the code has expired', async () => {
    const { prisma, authService } = setup(() => new Date('2026-01-01T00:11:00.000Z'));
    prisma.otpCodes.push({
      id: 'otp-1',
      email: 'user@example.com',
      codeHash: await hashOtpCode('123456'),
      expiresAt: new Date('2026-01-01T00:10:00.000Z'),
      used: false,
      failedAttempts: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(
      authService.verifyOtp({ email: 'user@example.com', code: '123456' }),
    ).rejects.toMatchObject({ reason: 'expired' });
  });

  it('throws too_many_attempts without checking the code when already at the cap', async () => {
    const { prisma, authService } = setup();
    prisma.otpCodes.push({
      id: 'otp-1',
      email: 'user@example.com',
      codeHash: await hashOtpCode('123456'),
      expiresAt: new Date('2026-01-01T00:10:00.000Z'),
      used: false,
      failedAttempts: OTP_MAX_FAILED_ATTEMPTS,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(
      authService.verifyOtp({ email: 'user@example.com', code: '123456' }),
    ).rejects.toMatchObject({ reason: 'too_many_attempts' });
  });

  it('throws incorrect_code with attempts remaining and increments failedAttempts', async () => {
    const { prisma, authService } = setup();
    prisma.otpCodes.push({
      id: 'otp-1',
      email: 'user@example.com',
      codeHash: await hashOtpCode('123456'),
      expiresAt: new Date('2026-01-01T00:10:00.000Z'),
      used: false,
      failedAttempts: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(
      authService.verifyOtp({ email: 'user@example.com', code: '000000' }),
    ).rejects.toMatchObject({
      reason: 'incorrect_code',
      attemptsRemaining: OTP_MAX_FAILED_ATTEMPTS - 1,
    });

    expect(prisma.otpCodes[0]!.failedAttempts).toBe(1);
  });

  it('increments failedAttempts atomically, even if a concurrent attempt lands first', async () => {
    const { prisma, authService } = setup();
    prisma.otpCodes.push({
      id: 'otp-1',
      email: 'user@example.com',
      codeHash: await hashOtpCode('123456'),
      expiresAt: new Date('2026-01-01T00:10:00.000Z'),
      used: false,
      failedAttempts: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    // Simulate a concurrent failed attempt's write landing between this
    // call's read of failedAttempts and its own update call. A naive
    // read-then-write (`failedAttempts: otp.failedAttempts + 1`) would
    // stomp the concurrent write and lose an attempt; an atomic increment
    // must not.
    const originalUpdate = prisma.otpCode.update.bind(prisma.otpCode);
    let firstCall = true;
    prisma.otpCode.update = (async (args: Parameters<typeof originalUpdate>[0]) => {
      if (firstCall) {
        firstCall = false;
        prisma.otpCodes[0]!.failedAttempts += 1;
      }
      return originalUpdate(args);
    }) as typeof originalUpdate;

    await expect(
      authService.verifyOtp({ email: 'user@example.com', code: '000000' }),
    ).rejects.toMatchObject({
      reason: 'incorrect_code',
      attemptsRemaining: OTP_MAX_FAILED_ATTEMPTS - 2,
    });

    expect(prisma.otpCodes[0]!.failedAttempts).toBe(2);
  });

  it('throws too_many_attempts (not incorrect_code) on the attempt that hits the cap', async () => {
    const { prisma, authService } = setup();
    prisma.otpCodes.push({
      id: 'otp-1',
      email: 'user@example.com',
      codeHash: await hashOtpCode('123456'),
      expiresAt: new Date('2026-01-01T00:10:00.000Z'),
      used: false,
      failedAttempts: OTP_MAX_FAILED_ATTEMPTS - 1,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(
      authService.verifyOtp({ email: 'user@example.com', code: '000000' }),
    ).rejects.toMatchObject({ reason: 'too_many_attempts' });

    expect(prisma.otpCodes[0]!.failedAttempts).toBe(OTP_MAX_FAILED_ATTEMPTS);
  });

  it('on success: marks the code used, creates the user, issues tokens', async () => {
    const { prisma, authService, now } = setup();
    prisma.otpCodes.push({
      id: 'otp-1',
      email: 'new@example.com',
      codeHash: await hashOtpCode('123456'),
      expiresAt: new Date('2026-01-01T00:10:00.000Z'),
      used: false,
      failedAttempts: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const result = await authService.verifyOtp({
      email: 'new@example.com',
      code: '123456',
      deviceLabel: "Miguel's iPhone",
    });

    expect(prisma.otpCodes[0]!.used).toBe(true);
    expect(prisma.users).toHaveLength(1);
    expect(prisma.users[0]!.email).toBe('new@example.com');

    expect(result.user).toEqual({ id: prisma.users[0]!.id, email: 'new@example.com' });

    const payload = await verifyAccessToken(result.tokens.accessToken, JWT_SECRET);
    expect(payload).toEqual({ userId: prisma.users[0]!.id });

    expect(prisma.refreshTokens).toHaveLength(1);
    const tokenRow = prisma.refreshTokens[0]!;
    expect(tokenRow.userId).toBe(prisma.users[0]!.id);
    expect(tokenRow.deviceLabel).toBe("Miguel's iPhone");
    expect(tokenRow.tokenHash).toBe(hashRefreshToken(result.tokens.refreshToken));
    expect(tokenRow.expiresAt.getTime()).toBe(now().getTime() + 30 * 24 * 60 * 60 * 1000);
  });

  it('reuses the existing user on a second login (no duplicate user row)', async () => {
    const { prisma, authService } = setup();
    prisma.users.push({ id: 'existing-user', email: 'user@example.com' });
    prisma.otpCodes.push({
      id: 'otp-1',
      email: 'user@example.com',
      codeHash: await hashOtpCode('123456'),
      expiresAt: new Date('2026-01-01T00:10:00.000Z'),
      used: false,
      failedAttempts: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const result = await authService.verifyOtp({ email: 'user@example.com', code: '123456' });

    expect(prisma.users).toHaveLength(1);
    expect(result.user.id).toBe('existing-user');
  });
});

describe('refreshSession', () => {
  it('throws not_found for an unknown token', async () => {
    const { authService } = setup();

    await expect(authService.refreshSession('unknown-token')).rejects.toMatchObject({
      reason: 'not_found',
    });
  });

  it('throws revoked for a revoked token', async () => {
    const { prisma, authService } = setup();
    prisma.refreshTokens.push({
      id: 'rt-1',
      userId: 'user-1',
      tokenHash: hashRefreshToken('valid-token'),
      deviceLabel: null,
      expiresAt: new Date('2026-02-01T00:00:00.000Z'),
      revoked: true,
    });

    await expect(authService.refreshSession('valid-token')).rejects.toMatchObject({
      reason: 'revoked',
    });
  });

  it('throws expired for an expired token', async () => {
    const { prisma, authService } = setup(() => new Date('2026-02-02T00:00:00.000Z'));
    prisma.refreshTokens.push({
      id: 'rt-1',
      userId: 'user-1',
      tokenHash: hashRefreshToken('valid-token'),
      deviceLabel: null,
      expiresAt: new Date('2026-02-01T00:00:00.000Z'),
      revoked: false,
    });

    await expect(authService.refreshSession('valid-token')).rejects.toMatchObject({
      reason: 'expired',
    });
  });

  it('does not rotate if the token was concurrently revoked between the check and the rotation write', async () => {
    const { prisma, authService } = setup();
    prisma.refreshTokens.push({
      id: 'rt-1',
      userId: 'user-1',
      tokenHash: hashRefreshToken('valid-token'),
      deviceLabel: null,
      expiresAt: new Date('2026-02-01T00:00:00.000Z'),
      revoked: false,
    });

    // Simulate a concurrent request winning the race: it revokes the row
    // right before this call's own atomic revoke-conditional-on-not-revoked
    // write runs. A non-atomic check-then-update (reading `revoked` once,
    // then unconditionally writing) would miss this and rotate anyway.
    const originalUpdateMany = prisma.refreshToken.updateMany.bind(prisma.refreshToken);
    prisma.refreshToken.updateMany = (async (
      args: Parameters<typeof originalUpdateMany>[0],
    ) => {
      prisma.refreshTokens[0]!.revoked = true;
      return originalUpdateMany(args);
    }) as typeof originalUpdateMany;

    await expect(authService.refreshSession('valid-token')).rejects.toMatchObject({
      reason: 'revoked',
    });

    expect(prisma.refreshTokens).toHaveLength(1);
  });

  it('rotates: revokes the old token and issues a new access + refresh token pair', async () => {
    const { prisma, authService, now } = setup();
    prisma.refreshTokens.push({
      id: 'rt-1',
      userId: 'user-1',
      tokenHash: hashRefreshToken('valid-token'),
      deviceLabel: "Miguel's iPhone",
      expiresAt: new Date('2026-02-01T00:00:00.000Z'),
      revoked: false,
    });

    const result = await authService.refreshSession('valid-token');

    expect(prisma.refreshTokens[0]!.revoked).toBe(true);
    expect(prisma.refreshTokens).toHaveLength(2);

    const newRow = prisma.refreshTokens[1]!;
    expect(newRow.tokenHash).toBe(hashRefreshToken(result.refreshToken));
    expect(newRow.userId).toBe('user-1');
    expect(newRow.deviceLabel).toBe("Miguel's iPhone");
    expect(newRow.revoked).toBe(false);
    expect(newRow.expiresAt.getTime()).toBe(now().getTime() + 30 * 24 * 60 * 60 * 1000);

    const payload = await verifyAccessToken(result.accessToken, JWT_SECRET);
    expect(payload).toEqual({ userId: 'user-1' });

    // the old (rotated-out) token must no longer work
    await expect(authService.refreshSession('valid-token')).rejects.toMatchObject({
      reason: 'revoked',
    });
  });
});

describe('logout', () => {
  it('revokes only the matching refresh token', async () => {
    const { prisma, authService } = setup();
    prisma.refreshTokens.push(
      {
        id: 'rt-1',
        userId: 'user-1',
        tokenHash: hashRefreshToken('token-a'),
        deviceLabel: null,
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
        revoked: false,
      },
      {
        id: 'rt-2',
        userId: 'user-1',
        tokenHash: hashRefreshToken('token-b'),
        deviceLabel: null,
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
        revoked: false,
      },
    );

    await authService.logout('token-a');

    expect(prisma.refreshTokens[0]!.revoked).toBe(true);
    expect(prisma.refreshTokens[1]!.revoked).toBe(false);
  });
});

describe('logoutAll', () => {
  it('revokes every refresh token for the user, leaving other users untouched', async () => {
    const { prisma, authService } = setup();
    prisma.refreshTokens.push(
      {
        id: 'rt-1',
        userId: 'user-1',
        tokenHash: hashRefreshToken('token-a'),
        deviceLabel: null,
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
        revoked: false,
      },
      {
        id: 'rt-2',
        userId: 'user-1',
        tokenHash: hashRefreshToken('token-b'),
        deviceLabel: null,
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
        revoked: false,
      },
      {
        id: 'rt-3',
        userId: 'user-2',
        tokenHash: hashRefreshToken('token-c'),
        deviceLabel: null,
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
        revoked: false,
      },
    );

    await authService.logoutAll('user-1');

    expect(prisma.refreshTokens[0]!.revoked).toBe(true);
    expect(prisma.refreshTokens[1]!.revoked).toBe(true);
    expect(prisma.refreshTokens[2]!.revoked).toBe(false);
  });
});
