import type { PrismaClient } from '../../lib/prisma.js';

const DEFAULT_BATCH_SIZE = 1000;

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
    where: { expiresAt: { lt: Date } } | { revoked: true },
  ): Promise<number> {
    return deleteInBatches(
      () => prisma.refreshToken.findMany({ where, select: { id: true }, take: batchSize }),
      (ids) => prisma.refreshToken.deleteMany({ where: { id: { in: ids } } }),
    );
  }

  async function cleanupExpiredAuthRecords(): Promise<AuthCleanupResult> {
    const cutoff = now();

    const otpCodesDeleted =
      (await cleanupOtpCodes({ expiresAt: { lt: cutoff } })) + (await cleanupOtpCodes({ used: true }));
    const refreshTokensDeleted =
      (await cleanupRefreshTokens({ expiresAt: { lt: cutoff } })) +
      (await cleanupRefreshTokens({ revoked: true }));

    return { otpCodesDeleted, refreshTokensDeleted };
  }

  return { cleanupExpiredAuthRecords };
}

export type AuthCleanupService = ReturnType<typeof createAuthCleanupService>;
