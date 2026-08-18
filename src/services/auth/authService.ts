import type { EmailService } from '../../lib/email.js';
import { signAccessToken } from '../../lib/jwt.js';
import { generateOtpCode, hashOtpCode, verifyOtpCode } from '../../lib/otp.js';
import type { PrismaClient } from '../../lib/prisma.js';
import { generateRefreshToken, hashRefreshToken } from '../../lib/refreshToken.js';

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_FAILED_ATTEMPTS = 5;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
  prisma: Pick<PrismaClient, 'otpCode' | 'user' | 'refreshToken' | '$transaction'>;
  emailService: EmailService;
  jwtSecret: string;
  now?: () => Date;
}

export function createAuthService({
  prisma,
  emailService,
  jwtSecret,
  now = () => new Date(),
}: AuthServiceDeps) {
  async function requestOtp(email: string): Promise<void> {
    const code = generateOtpCode();
    const codeHash = await hashOtpCode(code);
    const expiresAt = new Date(now().getTime() + OTP_TTL_MS);

    await prisma.otpCode.create({ data: { email, codeHash, expiresAt } });
    await emailService.sendOtpEmail(email, code);
  }

  async function verifyOtp(input: VerifyOtpInput): Promise<{ tokens: AuthTokens; user: AuthUser }> {
    const { email, code, deviceLabel } = input;

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

    const { user } = await prisma.$transaction(async (tx) => {
      await tx.otpCode.update({ where: { id: otp.id }, data: { used: true } });

      const user = await tx.user.upsert({
        where: { email },
        create: { email },
        update: {},
      });

      await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: refreshTokenHash,
          deviceLabel: deviceLabel ?? null,
          expiresAt: refreshExpiresAt,
        },
      });

      return { user };
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
      await tx.refreshToken.update({ where: { id: existing.id }, data: { revoked: true } });
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
