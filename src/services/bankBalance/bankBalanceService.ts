import type { PrismaClient } from '../../lib/prisma.js';

export type BankBalanceServiceErrorReason = 'invalid_amount';

export class BankBalanceServiceError extends Error {
  constructor(public readonly reason: BankBalanceServiceErrorReason) {
    super(`BankBalance operation failed: ${reason}`);
    this.name = 'BankBalanceServiceError';
  }
}

export interface BankBalance {
  amountCents: number;
  checkpointAmountCents: number;
  checkpointSetAt: Date;
}

export interface BankBalanceServiceDeps {
  prisma: Pick<PrismaClient, 'user' | 'transaction'>;
  now?: () => Date;
}

function assertValidCheckpointAmount(amountCents: number): void {
  // No lower bound, unlike every other money field in this schema —
  // a real bank account can overdraft, and this checkpoint is meant to
  // honestly reflect that, not floor it at 0 like Savings Funds do.
  if (!Number.isInteger(amountCents)) {
    throw new BankBalanceServiceError('invalid_amount');
  }
}

export function createBankBalanceService({ prisma, now = () => new Date() }: BankBalanceServiceDeps) {
  async function findUserOrThrow(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      // Not a client-triggerable error — userId always comes from a
      // verified JWT for an existing user, same "data integrity" throw
      // pattern used elsewhere for a loader miss that should be impossible.
      throw new Error(`Data integrity error: User ${userId} not found`);
    }
    return user;
  }

  async function computeNetSinceCheckpoint(userId: string, checkpointSetAt: Date): Promise<number> {
    const transactions = await prisma.transaction.findMany({
      where: { userId, createdAt: { gt: checkpointSetAt } },
    });
    return transactions.reduce(
      (sum, transaction) =>
        sum + (transaction.direction === 'income' ? transaction.amountCents : -transaction.amountCents),
      0,
    );
  }

  async function getBankBalance(userId: string): Promise<BankBalance> {
    const user = await findUserOrThrow(userId);
    const net = await computeNetSinceCheckpoint(userId, user.bankBalanceCheckpointSetAt);
    return {
      amountCents: user.bankBalanceCheckpointCents + net,
      checkpointAmountCents: user.bankBalanceCheckpointCents,
      checkpointSetAt: user.bankBalanceCheckpointSetAt,
    };
  }

  async function setBankBalanceCheckpoint(userId: string, amountCents: number): Promise<BankBalance> {
    assertValidCheckpointAmount(amountCents);
    await findUserOrThrow(userId);

    const checkpointSetAt = now();
    const user = await prisma.user.update({
      where: { id: userId },
      data: { bankBalanceCheckpointCents: amountCents, bankBalanceCheckpointSetAt: checkpointSetAt },
    });
    return {
      amountCents: user.bankBalanceCheckpointCents,
      checkpointAmountCents: user.bankBalanceCheckpointCents,
      checkpointSetAt: user.bankBalanceCheckpointSetAt,
    };
  }

  return { getBankBalance, setBankBalanceCheckpoint };
}

export type BankBalanceService = ReturnType<typeof createBankBalanceService>;
