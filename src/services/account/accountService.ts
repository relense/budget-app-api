import type { PrismaClient } from '../../lib/prisma.js';

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
  async function exportUserData(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AccountServiceError('account_not_found');

    const [
      categories,
      budgetMonths,
      categoryMonths,
      transactions,
      recurringExpenses,
      savingsFunds,
      savingsMovements,
    ] = await Promise.all([
      prisma.category.findMany({ where: { userId } }),
      prisma.budgetMonth.findMany({ where: { userId } }),
      prisma.categoryMonth.findMany({ where: { userId } }),
      prisma.transaction.findMany({ where: { userId } }),
      prisma.recurringExpense.findMany({ where: { userId } }),
      prisma.savingsFund.findMany({ where: { userId } }),
      prisma.savingsMovement.findMany({ where: { userId } }),
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
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AccountServiceError('account_not_found');

    await prisma.$transaction(async (tx) => {
      await tx.savingsMovement.deleteMany({ where: { userId } });
      await tx.transaction.deleteMany({ where: { userId } });
      await tx.savingsFund.deleteMany({ where: { userId } });
      await tx.recurringExpense.deleteMany({ where: { userId } });
      await tx.categoryMonth.deleteMany({ where: { userId } });
      await tx.category.deleteMany({ where: { userId } });
      await tx.budgetMonth.deleteMany({ where: { userId } });
      await tx.otpCode.deleteMany({ where: { email: user.email } });
      await tx.user.delete({ where: { id: userId } });
    });
  }

  return { exportUserData, deleteAccount };
}

export type AccountService = ReturnType<typeof createAccountService>;
