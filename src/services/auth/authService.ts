import type { EmailService } from '../../lib/email.js';
import { signAccessToken } from '../../lib/jwt.js';
import { generateOtpCode, hashOtpCode, verifyOtpCode } from '../../lib/otp.js';
import type { PrismaClient } from '../../lib/prisma.js';
import { generateRefreshToken, hashRefreshToken } from '../../lib/refreshToken.js';
import { DEFAULT_CATEGORIES } from './defaultCategories.js';

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_FAILED_ATTEMPTS = 5;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// The HTTP routes already normalize email via a shared Zod schema, but
// normalize again here so this invariant holds for any caller (a future
// GraphQL resolver, a script) and doesn't depend on caller discipline.
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type OtpVerificationReason =
  'not_found' | 'expired' | 'too_many_attempts' | 'incorrect_code';

export class OtpVerificationError extends Error {
  constructor(
    public readonly reason: OtpVerificationReason,
    public readonly attemptsRemaining?: number,
  ) {
    super(`OTP verification failed: ${reason}`);
    this.name = 'OtpVerificationError';
  }
}

export type RefreshTokenErrorReason = 'not_found' | 'expired' | 'revoked';

export class RefreshTokenError extends Error {
  constructor(public readonly reason: RefreshTokenErrorReason) {
    super(`Refresh token invalid: ${reason}`);
    this.name = 'RefreshTokenError';
  }
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthUser {
  id: string;
  email: string;
}

export interface VerifyOtpInput {
  email: string;
  code: string;
  deviceLabel?: string;
}

export interface AuthServiceDeps {
  prisma: Pick<PrismaClient, 'otpCode' | 'user' | 'category' | 'refreshToken' | '$transaction'>;
  emailService: EmailService;
  jwtSecret: string;
  now?: () => Date;
}

function hasPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
  );
}

export function createAuthService({
  prisma,
  emailService,
  jwtSecret,
  now = () => new Date(),
}: AuthServiceDeps) {
  async function requestOtp(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const code = generateOtpCode();
    const codeHash = await hashOtpCode(code);
    const expiresAt = new Date(now().getTime() + OTP_TTL_MS);

    await prisma.otpCode.create({ data: { email, codeHash, expiresAt } });
    await emailService.sendOtpEmail(email, code);
  }

  async function verifyOtp(input: VerifyOtpInput): Promise<{ tokens: AuthTokens; user: AuthUser }> {
    const email = normalizeEmail(input.email);
    const { code, deviceLabel } = input;

    const otp = await prisma.otpCode.findFirst({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp || otp.used) {
      throw new OtpVerificationError('not_found');
    }

    if (otp.expiresAt.getTime() < now().getTime()) {
      throw new OtpVerificationError('expired');
    }

    if (otp.failedAttempts >= OTP_MAX_FAILED_ATTEMPTS) {
      throw new OtpVerificationError('too_many_attempts');
    }

    const isValid = await verifyOtpCode(code, otp.codeHash);

    if (!isValid) {
      const updated = await prisma.otpCode.update({
        where: { id: otp.id },
        data: { failedAttempts: { increment: 1 } },
      });

      if (updated.failedAttempts >= OTP_MAX_FAILED_ATTEMPTS) {
        throw new OtpVerificationError('too_many_attempts');
      }

      throw new OtpVerificationError(
        'incorrect_code',
        OTP_MAX_FAILED_ATTEMPTS - updated.failedAttempts,
      );
    }

    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const refreshExpiresAt = new Date(now().getTime() + REFRESH_TOKEN_TTL_MS);

    // Explicit create-then-detect-conflict instead of upsert: upsert can't
    // tell a genuine first-time signup apart from a returning login (both
    // take the same code path), and that distinction is exactly what
    // decides whether the default category catalog gets seeded below.
    //
    // Deliberately run as standalone statements, not inside the
    // $transaction below: a failed statement poisons the rest of a
    // Postgres transaction (25P02, "current transaction is aborted") until
    // it's rolled back, so a caught unique-constraint error here couldn't
    // be recovered from with a findUnique on the same tx — confirmed
    // against real Postgres, not just the fake. The accepted tradeoff: if
    // the process crashes between this create and the transaction below
    // committing, a user could in principle end up without a category
    // catalog — narrow, matches this codebase's existing risk tolerance
    // (e.g. requestOtp's insert + email send aren't atomic either).
    let user;
    let isNewUser = false;
    try {
      user = await prisma.user.create({ data: { email } });
      isNewUser = true;
    } catch (error) {
      if (!hasPrismaErrorCode(error, 'P2002')) throw error;
      const existing = await prisma.user.findUnique({ where: { email } });
      if (!existing) throw error;
      user = existing;
    }

    await prisma.$transaction(async (tx) => {
      await tx.otpCode.update({ where: { id: otp.id }, data: { used: true } });

      if (isNewUser) {
        await tx.category.createMany({
          data: DEFAULT_CATEGORIES.map((category) => ({ ...category, userId: user.id })),
        });
      }

      await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: refreshTokenHash,
          deviceLabel: deviceLabel ?? null,
          expiresAt: refreshExpiresAt,
        },
      });
    });

    const accessToken = await signAccessToken({ userId: user.id }, jwtSecret);

    return {
      tokens: { accessToken, refreshToken },
      user: { id: user.id, email: user.email },
    };
  }

  async function refreshSession(token: string): Promise<AuthTokens> {
    const tokenHash = hashRefreshToken(token);
    const existing = await prisma.refreshToken.findFirst({ where: { tokenHash } });

    if (!existing) {
      throw new RefreshTokenError('not_found');
    }
    if (existing.revoked) {
      throw new RefreshTokenError('revoked');
    }
    if (existing.expiresAt.getTime() < now().getTime()) {
      throw new RefreshTokenError('expired');
    }

    const newRefreshToken = generateRefreshToken();
    const newRefreshTokenHash = hashRefreshToken(newRefreshToken);
    const newExpiresAt = new Date(now().getTime() + REFRESH_TOKEN_TTL_MS);

    await prisma.$transaction(async (tx) => {
      // Conditional on revoked: false so two concurrent refreshes of the
      // same token can't both pass the check above and both rotate it —
      // only the request that wins this atomic write proceeds.
      const revokeResult = await tx.refreshToken.updateMany({
        where: { id: existing.id, revoked: false },
        data: { revoked: true },
      });

      if (revokeResult.count === 0) {
        throw new RefreshTokenError('revoked');
      }

      await tx.refreshToken.create({
        data: {
          userId: existing.userId,
          tokenHash: newRefreshTokenHash,
          deviceLabel: existing.deviceLabel,
          expiresAt: newExpiresAt,
        },
      });
    });

    const accessToken = await signAccessToken({ userId: existing.userId }, jwtSecret);

    return { accessToken, refreshToken: newRefreshToken };
  }

  async function logout(token: string): Promise<void> {
    const tokenHash = hashRefreshToken(token);
    await prisma.refreshToken.updateMany({ where: { tokenHash }, data: { revoked: true } });
  }

  async function logoutAll(userId: string): Promise<void> {
    await prisma.refreshToken.updateMany({ where: { userId }, data: { revoked: true } });
  }

  return { requestOtp, verifyOtp, refreshSession, logout, logoutAll };
}

export type AuthService = ReturnType<typeof createAuthService>;
