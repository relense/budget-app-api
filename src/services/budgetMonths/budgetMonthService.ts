import { formatMonth, isValidMonthFormat } from '../../lib/monthFormat.js';
import type { PrismaClient } from '../../lib/prisma.js';
import { hasPrismaErrorCode } from '../../lib/prismaErrors.js';

export type BudgetMonthServiceErrorReason =
  | 'invalid_month'
  | 'budget_month_not_found'
  | 'budget_month_already_locked'
  | 'budget_month_not_current'
  | 'budget_month_locked'
  | 'budget_month_has_activations';

export class BudgetMonthServiceError extends Error {
  constructor(public readonly reason: BudgetMonthServiceErrorReason) {
    super(`BudgetMonth operation failed: ${reason}`);
    this.name = 'BudgetMonthServiceError';
  }
}

export interface BudgetMonthServiceDeps {
  prisma: Pick<PrismaClient, 'budgetMonth' | 'categoryMonth' | '$transaction' | '$queryRaw'>;
  now?: () => Date;
}

function assertValidMonth(month: string): void {
  if (!isValidMonthFormat(month)) {
    throw new BudgetMonthServiceError('invalid_month');
  }
}

/**
 * Client-parameterized core of resolveBudgetMonthId — exported standalone so
 * a caller that already has its own open transaction (e.g.
 * recurringExpenseInstanceService's locked instance-creation flow) can run
 * this as part of that same transaction, instead of on the service's own
 * separately-bound connection where it wouldn't actually participate in the
 * caller's lock. The bound service method below is a thin wrapper around
 * this for regular (non-nested) callers.
 */
export async function resolveBudgetMonthId(
  client: Pick<PrismaClient, 'budgetMonth'>,
  userId: string,
  month: string,
): Promise<string> {
  const budgetMonth = await client.budgetMonth.upsert({
    where: { userId_month: { userId, month } },
    create: { userId, month },
    update: {},
  });
  return budgetMonth.id;
}

/**
 * Takes a row lock (SELECT ... FOR UPDATE) on one BudgetMonth — must be
 * called inside a $transaction. Exported standalone so every write path
 * that needs to check `locked` (categoryMonthService, transactionService,
 * recurringExpenseInstanceService, and lockMonth/deleteBudgetMonth below)
 * takes the *same* lock before checking it, instead of a plain read: under
 * Postgres's default READ COMMITTED isolation, a plain check-then-write has
 * no protection against a concurrent lockMonth committing in the gap
 * between the check and the write — the lock is what actually closes that,
 * same pattern as recurringExpenseTemplateService's lockTemplateRow.
 */
export async function lockBudgetMonthRow(client: Pick<PrismaClient, '$queryRaw'>, id: string): Promise<void> {
  await client.$queryRaw`SELECT id FROM budget_months WHERE id = ${id} FOR UPDATE`;
}

/**
 * Client-parameterized core of findCurrentMonth — see findCurrentMonth
 * below for the derivation rule. Standalone so lockMonth can re-derive
 * "current" from inside its own transaction, against the transactional
 * client, after taking a row lock — reading it via the service's own
 * separately-bound connection wouldn't see (or participate in) that lock.
 */
export async function findCurrentMonthOnClient(
  client: Pick<PrismaClient, 'budgetMonth'>,
  userId: string,
  now: () => Date,
): Promise<{ month: string; locked: boolean }> {
  const unlocked = await client.budgetMonth.findMany({ where: { userId, locked: false } });
  if (unlocked.length === 0) {
    return { month: formatMonth(now()), locked: false };
  }
  const earliest = unlocked.reduce((min, row) => (row.month < min.month ? row : min));
  return { month: earliest.month, locked: earliest.locked };
}

/**
 * Resolves month strings ("YYYY-MM") to the real per-user BudgetMonth row
 * every other month-scoped table (category_month, and eventually
 * recurring_expense_instances / income_sources) references via month_id.
 * Callers are responsible for validating the month format before calling —
 * this trusts its input the same way the rest of the service layer trusts
 * Zod-validated input from the route/resolver boundary.
 */
export function createBudgetMonthService({ prisma, now = () => new Date() }: BudgetMonthServiceDeps) {
  async function resolveBudgetMonthIdBound(userId: string, month: string): Promise<string> {
    return resolveBudgetMonthId(prisma, userId, month);
  }

  /**
   * Read-only lookup — unlike resolveBudgetMonthId, never creates a row.
   * For read paths (e.g. listing transactions for a month), where creating
   * a BudgetMonth as a side effect of a query would be a bug.
   */
  async function findBudgetMonthId(userId: string, month: string): Promise<string | null> {
    const budgetMonth = await prisma.budgetMonth.findUnique({ where: { userId_month: { userId, month } } });
    return budgetMonth?.id ?? null;
  }

  /** Batch lookup for DataLoader use — trusts the caller to have already scoped the ids to one user. */
  async function findManyByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return prisma.budgetMonth.findMany({ where: { id: { in: ids } } });
  }

  /**
   * Derived, never persisted by this call — "current month" is always the
   * earliest unlocked BudgetMonth row for this user, by real calendar
   * order ("YYYY-MM" sorts lexicographically the same as chronologically).
   * If the user has none at all — brand new, or every existing row is
   * locked with nothing planned past it — falls back to today's real
   * calendar month. Read-only: never creates a row, same rule
   * findBudgetMonthId follows for query paths. No auto-lock cascade, no
   * automatic next-month creation — locking and planning ahead are both
   * separate, explicit user actions (see PROGRESS.md).
   */
  async function findCurrentMonth(userId: string): Promise<{ month: string; locked: boolean }> {
    return findCurrentMonthOnClient(prisma, userId, now);
  }

  /**
   * Locks the target month, permanently — must be the user's current
   * (earliest unlocked) month. Locking a later, pre-provisioned month
   * while an earlier one is still unlocked would break the "current is
   * always earliest unlocked" invariant every other derivation relies on.
   * No carry-forward, no next-month creation here — those are separate,
   * explicit actions the client drives afterward if the user wants them.
   *
   * Runs inside a transaction, taking lockBudgetMonthRow before
   * re-checking locked/current: closes both a concurrent lockMonth for
   * this same month (the second caller blocks until the first commits,
   * then correctly sees budget_month_already_locked) and — since every
   * other write path takes the identical lock before checking `locked` —
   * a write racing this call landing in what's about to become a locked
   * month.
   */
  async function lockMonth(userId: string, month: string) {
    assertValidMonth(month);

    const budgetMonth = await prisma.budgetMonth.findUnique({ where: { userId_month: { userId, month } } });
    if (!budgetMonth) {
      throw new BudgetMonthServiceError('budget_month_not_found');
    }

    return prisma.$transaction(async (tx) => {
      await lockBudgetMonthRow(tx, budgetMonth.id);

      // Re-read inside the lock — a concurrent lockMonth for this same row
      // could have committed between the check above and this lock being
      // granted.
      const current = await tx.budgetMonth.findUnique({ where: { id: budgetMonth.id } });
      if (!current) {
        throw new BudgetMonthServiceError('budget_month_not_found');
      }
      if (current.locked) {
        throw new BudgetMonthServiceError('budget_month_already_locked');
      }

      const currentMonth = await findCurrentMonthOnClient(tx, userId, now);
      if (currentMonth.month !== month) {
        throw new BudgetMonthServiceError('budget_month_not_current');
      }

      return tx.budgetMonth.update({
        where: { id: budgetMonth.id },
        data: { locked: true, lockedAt: now() },
      });
    });
  }

  /**
   * Hard delete, for a month a user pre-provisioned but decided not to
   * use. Blocked while any category_month row references it — a
   * recurring-expense instance always has a category_month for the same
   * month/category created atomically alongside it (see
   * ensureActiveForCategoryOnClient), so this pre-check covers the common
   * case; the P2003 catch below is what actually guarantees the
   * recurring-expense-instance-only edge case too (category_month removed
   * after the fact, instance left behind — removeCategoryFromMonth doesn't
   * check for a referencing instance), not the pre-check alone. Locked
   * months are permanent record, never deletable. Runs inside a
   * transaction taking lockBudgetMonthRow, same reasoning as lockMonth —
   * closes the race against a concurrent lockMonth for this same row.
   */
  async function deleteBudgetMonth(userId: string, month: string): Promise<void> {
    assertValidMonth(month);

    const budgetMonth = await prisma.budgetMonth.findUnique({ where: { userId_month: { userId, month } } });
    if (!budgetMonth) {
      throw new BudgetMonthServiceError('budget_month_not_found');
    }

    try {
      await prisma.$transaction(async (tx) => {
        await lockBudgetMonthRow(tx, budgetMonth.id);

        const current = await tx.budgetMonth.findUnique({ where: { id: budgetMonth.id } });
        if (!current) {
          throw new BudgetMonthServiceError('budget_month_not_found');
        }
        if (current.locked) {
          throw new BudgetMonthServiceError('budget_month_locked');
        }

        const existingCategoryMonth = await tx.categoryMonth.findFirst({ where: { monthId: budgetMonth.id } });
        if (existingCategoryMonth) {
          throw new BudgetMonthServiceError('budget_month_has_activations');
        }

        await tx.budgetMonth.delete({ where: { id: budgetMonth.id } });
      });
    } catch (error) {
      if (error instanceof BudgetMonthServiceError) {
        throw error;
      }
      if (hasPrismaErrorCode(error, 'P2003')) {
        throw new BudgetMonthServiceError('budget_month_has_activations');
      }
      throw error;
    }
  }

  return {
    resolveBudgetMonthId: resolveBudgetMonthIdBound,
    findBudgetMonthId,
    findManyByIds,
    findCurrentMonth,
    lockMonth,
    deleteBudgetMonth,
  };
}

export type BudgetMonthService = ReturnType<typeof createBudgetMonthService>;
