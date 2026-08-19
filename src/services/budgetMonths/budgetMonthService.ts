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
  prisma: Pick<PrismaClient, 'budgetMonth' | 'categoryMonth'>;
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
    const unlocked = await prisma.budgetMonth.findMany({ where: { userId, locked: false } });
    if (unlocked.length === 0) {
      return { month: formatMonth(now()), locked: false };
    }
    const earliest = unlocked.reduce((min, row) => (row.month < min.month ? row : min));
    return { month: earliest.month, locked: earliest.locked };
  }

  /**
   * Locks the target month, permanently — must be the user's current
   * (earliest unlocked) month. Locking a later, pre-provisioned month
   * while an earlier one is still unlocked would break the "current is
   * always earliest unlocked" invariant every other derivation relies on.
   * No carry-forward, no next-month creation here — those are separate,
   * explicit actions the client drives afterward if the user wants them.
   */
  async function lockMonth(userId: string, month: string) {
    assertValidMonth(month);

    const budgetMonth = await prisma.budgetMonth.findUnique({ where: { userId_month: { userId, month } } });
    if (!budgetMonth) {
      throw new BudgetMonthServiceError('budget_month_not_found');
    }
    if (budgetMonth.locked) {
      throw new BudgetMonthServiceError('budget_month_already_locked');
    }

    const current = await findCurrentMonth(userId);
    if (current.month !== month) {
      throw new BudgetMonthServiceError('budget_month_not_current');
    }

    return prisma.budgetMonth.update({
      where: { id: budgetMonth.id },
      data: { locked: true, lockedAt: now() },
    });
  }

  /**
   * Hard delete, for a month a user pre-provisioned but decided not to
   * use. Blocked while any category_month row references it — a
   * recurring-expense instance always has a category_month for the same
   * month/category created atomically alongside it (see
   * ensureActiveForCategoryOnClient), so this one check covers both.
   * Locked months are permanent record, never deletable.
   */
  async function deleteBudgetMonth(userId: string, month: string): Promise<void> {
    assertValidMonth(month);

    const budgetMonth = await prisma.budgetMonth.findUnique({ where: { userId_month: { userId, month } } });
    if (!budgetMonth) {
      throw new BudgetMonthServiceError('budget_month_not_found');
    }
    if (budgetMonth.locked) {
      throw new BudgetMonthServiceError('budget_month_locked');
    }

    const existingCategoryMonth = await prisma.categoryMonth.findFirst({ where: { monthId: budgetMonth.id } });
    if (existingCategoryMonth) {
      throw new BudgetMonthServiceError('budget_month_has_activations');
    }

    try {
      await prisma.budgetMonth.delete({ where: { id: budgetMonth.id } });
    } catch (error) {
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
