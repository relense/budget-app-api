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

  async function cleanupExpiredAuthRecords(): Promise<AuthCleanupResult> {
    const cutoff = now();

    const expiredOtpCodesDeleted = await deleteInBatches(
      () =>
        prisma.otpCode.findMany({
          where: { expiresAt: { lt: cutoff } },
          select: { id: true },
          take: batchSize,
        }),
      (ids) => prisma.otpCode.deleteMany({ where: { id: { in: ids } } }),
    );
    const usedOtpCodesDeleted = await deleteInBatches(
      () =>
        prisma.otpCode.findMany({
          where: { used: true },
          select: { id: true },
          take: batchSize,
        }),
      (ids) => prisma.otpCode.deleteMany({ where: { id: { in: ids } } }),
    );

    const expiredRefreshTokensDeleted = await deleteInBatches(
      () =>
        prisma.refreshToken.findMany({
          where: { expiresAt: { lt: cutoff } },
          select: { id: true },
          take: batchSize,
        }),
      (ids) => prisma.refreshToken.deleteMany({ where: { id: { in: ids } } }),
    );
    const revokedRefreshTokensDeleted = await deleteInBatches(
      () =>
        prisma.refreshToken.findMany({
          where: { revoked: true },
          select: { id: true },
          take: batchSize,
        }),
      (ids) => prisma.refreshToken.deleteMany({ where: { id: { in: ids } } }),
    );

    return {
      otpCodesDeleted: expiredOtpCodesDeleted + usedOtpCodesDeleted,
      refreshTokensDeleted: expiredRefreshTokensDeleted + revokedRefreshTokensDeleted,
    };
  }

  return { cleanupExpiredAuthRecords };
}

export type AuthCleanupService = ReturnType<typeof createAuthCleanupService>;
