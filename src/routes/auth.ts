import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyAccessToken } from '../lib/jwt.js';
import { OTP_CODE_REGEX } from '../lib/otp.js';
import type { AuthCleanupService } from '../services/auth/authCleanupService.js';
import {
  type AuthService,
  OtpVerificationError,
  RefreshTokenError,
} from '../services/auth/authService.js';

const OTP_RATE_LIMIT_MAX = 3;
const OTP_RATE_LIMIT_WINDOW = '15 minutes';

// Looser than the request-otp cap: the failedAttempts column already caps
// guesses per code at 5, this is a secondary per-IP+email backstop against
// brute-forcing across many codes/emails, not the primary defense.
const OTP_VERIFY_RATE_LIMIT_MAX = 10;
const OTP_VERIFY_RATE_LIMIT_WINDOW = '15 minutes';

function emailRateLimitKeyGenerator(request: { ip: string; body: unknown }): string {
  const body = request.body as { email?: string } | undefined;
  const normalizedEmail = (body?.email ?? '').trim().toLowerCase();
  return `${request.ip}:${normalizedEmail}`;
}

const emailSchema = z.string().trim().toLowerCase().email();

const requestOtpSchema = z.object({
  email: emailSchema,
});

const verifyOtpSchema = z.object({
  email: emailSchema,
  code: z
    .string()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(OTP_CODE_REGEX, 'code must be 6 characters (A-Z, 2-9)')),
  deviceLabel: z.string().min(1).max(100).optional(),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(1),
});

const OTP_ERROR_CODE: Record<OtpVerificationError['reason'], string> = {
  not_found: 'code_not_found',
  expired: 'code_expired',
  too_many_attempts: 'too_many_attempts',
  incorrect_code: 'incorrect_code',
};

export interface RegisterAuthRoutesOptions {
  authService: Pick<
    AuthService,
    'requestOtp' | 'verifyOtp' | 'refreshSession' | 'logout' | 'logoutAll'
  >;
  authCleanupService: Pick<AuthCleanupService, 'cleanupExpiredAuthRecords'>;
  jwtSecret: string;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  { authService, authCleanupService, jwtSecret }: RegisterAuthRoutesOptions,
): Promise<void> {
  app.post(
    '/auth/request-otp',
    {
      config: {
        rateLimit: {
          max: OTP_RATE_LIMIT_MAX,
          timeWindow: OTP_RATE_LIMIT_WINDOW,
          hook: 'preHandler',
          keyGenerator: emailRateLimitKeyGenerator,
        },
      },
    },
    async (request, reply) => {
      const parsed = requestOtpSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', issues: parsed.error.issues });
      }

      await authService.requestOtp(parsed.data.email);

      // Piggybacked here rather than only on the interval sweep (see
      // authCleanupService's doc comment / PLAN.md's "Row cleanup" note) so
      // cleanup still happens promptly during real traffic. Deliberately
      // not awaited — this is a rate-limited hot path and a batch-delete
      // backlog must never add latency to the response. Errors are logged,
      // never allowed to become an unhandled rejection.
      authCleanupService.cleanupExpiredAuthRecords().catch((error: unknown) => {
        app.log.error(error, 'Auth row cleanup failed');
      });

      return reply.status(200).send({ message: 'If that email is valid, a code has been sent.' });
    },
  );

  app.post(
    '/auth/verify-otp',
    {
      config: {
        rateLimit: {
          max: OTP_VERIFY_RATE_LIMIT_MAX,
          timeWindow: OTP_VERIFY_RATE_LIMIT_WINDOW,
          hook: 'preHandler',
          keyGenerator: emailRateLimitKeyGenerator,
        },
      },
    },
    async (request, reply) => {
      const parsed = verifyOtpSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', issues: parsed.error.issues });
      }

      try {
        const { tokens, user } = await authService.verifyOtp(parsed.data);
        return reply.status(200).send({ ...tokens, user });
      } catch (error) {
        if (error instanceof OtpVerificationError) {
          return reply.status(401).send({
            error: OTP_ERROR_CODE[error.reason],
            ...(error.attemptsRemaining !== undefined
              ? { attemptsRemaining: error.attemptsRemaining }
              : {}),
          });
        }
        throw error;
      }
    },
  );

  app.post('/auth/refresh', async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', issues: parsed.error.issues });
    }

    try {
      const tokens = await authService.refreshSession(parsed.data.refreshToken);
      return reply.status(200).send(tokens);
    } catch (error) {
      if (error instanceof RefreshTokenError) {
        return reply.status(401).send({ error: 'refresh_token_invalid' });
      }
      throw error;
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    const parsed = logoutSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', issues: parsed.error.issues });
    }

    await authService.logout(parsed.data.refreshToken);
    return reply.status(204).send();
  });

  app.post('/auth/logout-all', async (request, reply) => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
    const payload = token ? await verifyAccessToken(token, jwtSecret) : null;

    if (!payload) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    await authService.logoutAll(payload.userId);
    return reply.status(204).send();
  });
}
