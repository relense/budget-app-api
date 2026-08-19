import type { PrismaClient } from '../../lib/prisma.js';

export interface BudgetMonthServiceDeps {
  prisma: Pick<PrismaClient, 'budgetMonth'>;
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
export function createBudgetMonthService({ prisma }: BudgetMonthServiceDeps) {
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

  return { resolveBudgetMonthId: resolveBudgetMonthIdBound, findBudgetMonthId, findManyByIds };
}

export type BudgetMonthService = ReturnType<typeof createBudgetMonthService>;
