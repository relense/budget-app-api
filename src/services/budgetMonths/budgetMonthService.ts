import type { PrismaClient } from '../../lib/prisma.js';

export interface BudgetMonthServiceDeps {
  prisma: Pick<PrismaClient, 'budgetMonth'>;
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
  async function resolveBudgetMonthId(userId: string, month: string): Promise<string> {
    const budgetMonth = await prisma.budgetMonth.upsert({
      where: { userId_month: { userId, month } },
      create: { userId, month },
      update: {},
    });
    return budgetMonth.id;
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

  return { resolveBudgetMonthId, findBudgetMonthId };
}

export type BudgetMonthService = ReturnType<typeof createBudgetMonthService>;
