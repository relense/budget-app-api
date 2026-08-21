import type { PrismaClient } from '../../lib/prisma.js';

const DEFAULT_BATCH_SIZE = 1000;
// Comfortably longer than OTP_TTL_MS (10 min, see authService.ts) so a
// normal logout -> request-otp -> login sequence never races this cleanup:
// the just-revoked token from the logout must still exist when the next
// login's self-heal check (or a token-reuse check) runs.
const REVOKED_TOKEN_GRACE_PERIOD_MS = 60 * 60 * 1000;

export interface AuthCleanupServiceDeps {
  prisma: Pick<PrismaClient, 'otpCode' | 'refreshToken'>;
  now?: () => Date;
  batchSize?: number;
}

export interface AuthCleanupResult {
  otpCodesDeleted: number;
  refreshTokensDeleted: number;
}

export function createAuthCleanupService({
  prisma,
  now = () => new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
}: AuthCleanupServiceDeps) {
  // Deletes in bounded chunks rather than one unbounded DELETE, so a large
  // backlog doesn't hold locks on this hot-path table for a long single
  // transaction — see PLAN.md's "Row cleanup" note.
  async function deleteInBatches(
    findBatch: () => Promise<Array<{ id: string }>>,
    deleteByIds: (ids: string[]) => Promise<{ count: number }>,
  ): Promise<number> {
    let totalDeleted = 0;
    for (;;) {
      const batch = await findBatch();
      if (batch.length === 0) break;
      const { count } = await deleteByIds(batch.map((row) => row.id));
      totalDeleted += count;
      if (batch.length < batchSize) break;
    }
    return totalDeleted;
  }

  function cleanupOtpCodes(where: { expiresAt: { lt: Date } } | { used: true }): Promise<number> {
    return deleteInBatches(
      () => prisma.otpCode.findMany({ where, select: { id: true }, take: batchSize }),
      (ids) => prisma.otpCode.deleteMany({ where: { id: { in: ids } } }),
    );
  }

  function cleanupRefreshTokens(
    where: { expiresAt: { lt: Date } } | { revoked: true; revokedAt: { lt: Date } },
  ): Promise<number> {
    return deleteInBatches(
      () => prisma.refreshToken.findMany({ where, select: { id: true }, take: batchSize }),
      (ids) => prisma.refreshToken.deleteMany({ where: { id: { in: ids } } }),
    );
  }

  async function cleanupExpiredAuthRecords(): Promise<AuthCleanupResult> {
    const cutoff = now();
    const revokedCutoff = new Date(cutoff.getTime() - REVOKED_TOKEN_GRACE_PERIOD_MS);

    const otpCodesDeleted =
      (await cleanupOtpCodes({ expiresAt: { lt: cutoff } })) + (await cleanupOtpCodes({ used: true }));
    const refreshTokensDeleted =
      (await cleanupRefreshTokens({ expiresAt: { lt: cutoff } })) +
      (await cleanupRefreshTokens({ revoked: true, revokedAt: { lt: revokedCutoff } }));

    return { otpCodesDeleted, refreshTokensDeleted };
  }

  return { cleanupExpiredAuthRecords };
}

export type AuthCleanupService = ReturnType<typeof createAuthCleanupService>;
