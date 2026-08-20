import type { PrismaClient } from '../../lib/prisma.js';
import { hasPrismaErrorCode } from '../../lib/prismaErrors.js';

export type AccountServiceErrorReason = 'account_not_found';

export class AccountServiceError extends Error {
  constructor(public readonly reason: AccountServiceErrorReason) {
    super(`Account operation failed: ${reason}`);
    this.name = 'AccountServiceError';
  }
}

export interface AccountServiceDeps {
  prisma: Pick<
    PrismaClient,
    | 'user'
    | 'category'
    | 'categoryMonth'
    | 'budgetMonth'
    | 'transaction'
    | 'recurringExpense'
    | 'savingsFund'
    | 'savingsMovement'
    | 'otpCode'
    | '$transaction'
  >;
}

export function createAccountService({ prisma }: AccountServiceDeps) {
  async function findAccount(client: Pick<PrismaClient, 'user'>, userId: string) {
    const user = await client.user.findUnique({ where: { id: userId } });
    if (!user) throw new AccountServiceError('account_not_found');
    return user;
  }

  // RepeatableRead so every findMany below sees the same snapshot — plain
  // READ COMMITTED (Postgres's default) would let a concurrent write (e.g.
  // deleteAccount, or an ordinary create) interleave between these reads,
  // returning a mix of pre- and post-write state across tables.
  async function exportUserData(userId: string) {
    return prisma.$transaction(
      async (tx) => {
        const user = await findAccount(tx, userId);

        const [
          categories,
          budgetMonths,
          categoryMonths,
          transactions,
          recurringExpenses,
          savingsFunds,
          savingsMovements,
        ] = await Promise.all([
          tx.category.findMany({ where: { userId } }),
          tx.budgetMonth.findMany({ where: { userId } }),
          tx.categoryMonth.findMany({ where: { userId } }),
          tx.transaction.findMany({ where: { userId } }),
          tx.recurringExpense.findMany({ where: { userId } }),
          tx.savingsFund.findMany({ where: { userId } }),
          tx.savingsMovement.findMany({ where: { userId } }),
        ]);

        return {
          account: {
            id: user.id,
            email: user.email,
            createdAt: user.createdAt,
            bankBalanceCheckpointCents: user.bankBalanceCheckpointCents,
            bankBalanceCheckpointSetAt: user.bankBalanceCheckpointSetAt,
          },
          categories,
          budgetMonths,
          categoryMonths,
          transactions,
          recurringExpenses,
          savingsFunds,
          savingsMovements,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  // Deletion order matters: none of these tables have a real FK back to
  // User (userId is an application-scoped column only, see PLAN.md's GDPR
  // note), but they *do* have Restrict FKs to each other, so children must
  // go before parents — transactions/movements before the category-months,
  // recurring-expenses, and funds they reference; those before the
  // categories and budget-months *they* reference. otp_codes are keyed by
  // email, not userId, so they're cleaned up separately. The user row goes
  // last (its only real FK relation, refresh_tokens, cascades on delete).
  async function deleteAccount(userId: string): Promise<void> {
    const user = await findAccount(prisma, userId);

    await prisma.$transaction(async (tx) => {
      await tx.savingsMovement.deleteMany({ where: { userId } });
      await tx.transaction.deleteMany({ where: { userId } });
      await tx.savingsFund.deleteMany({ where: { userId } });
      await tx.recurringExpense.deleteMany({ where: { userId } });
      await tx.categoryMonth.deleteMany({ where: { userId } });
      await tx.category.deleteMany({ where: { userId } });
      await tx.budgetMonth.deleteMany({ where: { userId } });
      await tx.otpCode.deleteMany({ where: { email: user.email } });

      // Two concurrent DELETE /account calls for the same user (double
      // submit, or a client retry after a timed-out-but-succeeded first
      // request) both pass the findAccount check above; whichever loses
      // the race hits this delete after the row's already gone. Mapped to
      // the same typed error findAccount would have thrown, rather than
      // letting Prisma's raw P2025 through — same "pre-check plus DB-level
      // backstop" pattern this codebase already uses elsewhere (e.g.
      // savingsMovementService's update/delete P2025 catch).
      try {
        await tx.user.delete({ where: { id: userId } });
      } catch (error) {
        if (hasPrismaErrorCode(error, 'P2025')) {
          throw new AccountServiceError('account_not_found');
        }
        throw error;
      }
    });
  }

  return { exportUserData, deleteAccount };
}

export type AccountService = ReturnType<typeof createAccountService>;
