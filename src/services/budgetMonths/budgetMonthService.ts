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

  return { resolveBudgetMonthId };
}

export type BudgetMonthService = ReturnType<typeof createBudgetMonthService>;
