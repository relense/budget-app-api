import type { BudgetMonthService } from '../budgetMonths/budgetMonthService.js';
import { resolveBudgetMonthId } from '../budgetMonths/budgetMonthService.js';
import { assertOwnedCategory, CategoryServiceError } from './categoryService.js';
import { isValidMonthFormat } from '../../lib/monthFormat.js';
import type { PrismaClient } from '../../lib/prisma.js';
import { hasPrismaErrorCode } from '../../lib/prismaErrors.js';

export type CategoryMonthServiceErrorReason =
  | 'category_month_not_found'
  | 'category_month_already_active'
  | 'category_month_has_transactions'
  | 'category_month_budget_required'
  | 'month_locked'
  | 'invalid_budget'
  | 'invalid_month';

export class CategoryMonthServiceError extends Error {
  constructor(public readonly reason: CategoryMonthServiceErrorReason) {
    super(`CategoryMonth operation failed: ${reason}`);
    this.name = 'CategoryMonthServiceError';
  }
}

export interface CategoryMonthServiceDeps {
  prisma: Pick<PrismaClient, 'category' | 'categoryMonth' | 'transaction' | 'budgetMonth' | '$transaction'>;
  budgetMonthService: Pick<BudgetMonthService, 'resolveBudgetMonthId' | 'findBudgetMonthId'>;
}

function assertValidBudget(monthlyBudgetCents: number): void {
  if (!Number.isInteger(monthlyBudgetCents) || monthlyBudgetCents < 0) {
    throw new CategoryMonthServiceError('invalid_budget');
  }
}

function assertValidMonth(month: string): void {
  if (!isValidMonthFormat(month)) {
    throw new CategoryMonthServiceError('invalid_month');
  }
}

/**
 * When no budget is given explicitly, inherits the category's most
 * recently created category_month's budget (carry-forward / pre-
 * provisioning next month while it's already active) — or requires an
 * explicit one if this category has never been active anywhere yet.
 * "Most recently created" rather than "most recent month": the planning
 * horizon cap (current month or the one right after, never further) means
 * category_month rows are always created in chronological order in
 * practice, and this avoids an extra join to BudgetMonth just to sort by
 * month string.
 */
async function resolveBudgetForActivation(
  client: Pick<PrismaClient, 'categoryMonth'>,
  categoryId: string,
  monthlyBudgetCents: number | undefined,
): Promise<number> {
  if (monthlyBudgetCents !== undefined) {
    assertValidBudget(monthlyBudgetCents);
    return monthlyBudgetCents;
  }

  const priorActivations = await client.categoryMonth.findMany({ where: { categoryId } });
  if (priorActivations.length === 0) {
    throw new CategoryMonthServiceError('category_month_budget_required');
  }
  const mostRecent = priorActivations.reduce((latest, row) =>
    row.createdAt > latest.createdAt ? row : latest,
  );
  return mostRecent.monthlyBudgetCents;
}

/**
 * Client-parameterized core of ensureActiveForCategory — exported standalone
 * so a caller that already has its own open transaction (e.g.
 * recurringExpenseInstanceService's locked instance-creation flow) can run
 * this as part of that same transaction. No nested transaction here (Prisma
 * doesn't support nesting $transaction calls) — the bound service method
 * below supplies one for regular (non-nested) callers.
 */
export async function ensureActiveForCategoryOnClient(
  client: Pick<PrismaClient, 'category' | 'categoryMonth' | 'budgetMonth'>,
  userId: string,
  categoryId: string,
  month: string,
  monthlyBudgetCents?: number,
) {
  assertValidMonth(month);
  await assertOwnedCategory(client, userId, categoryId);

  const monthId = await resolveBudgetMonthId(client, userId, month);
  const budgetMonth = await client.budgetMonth.findUnique({ where: { id: monthId } });
  if (budgetMonth?.locked) {
    throw new CategoryMonthServiceError('month_locked');
  }

  const existing = await client.categoryMonth.findFirst({ where: { categoryId, monthId } });
  if (existing) return existing;

  const resolvedBudget = await resolveBudgetForActivation(client, categoryId, monthlyBudgetCents);

  try {
    return await client.categoryMonth.create({
      data: { userId, categoryId, monthId, monthlyBudgetCents: resolvedBudget },
    });
  } catch (error) {
    if (hasPrismaErrorCode(error, 'P2002')) {
      // Lost a race to a concurrent create for the same (categoryId,
      // monthId) — fine here, "ensure active" is idempotent by design,
      // just return the winner instead of erroring.
      const winner = await client.categoryMonth.findFirst({ where: { categoryId, monthId } });
      if (winner) return winner;
    }
    throw error;
  }
}

export function createCategoryMonthService({ prisma, budgetMonthService }: CategoryMonthServiceDeps) {
  async function findOwnedCategoryMonth(userId: string, categoryMonthId: string) {
    const categoryMonth = await prisma.categoryMonth.findUnique({ where: { id: categoryMonthId } });
    if (!categoryMonth || categoryMonth.userId !== userId) {
      throw new CategoryMonthServiceError('category_month_not_found');
    }
    return categoryMonth;
  }

  async function assertMonthNotLocked(monthId: string): Promise<void> {
    const budgetMonth = await prisma.budgetMonth.findUnique({ where: { id: monthId } });
    if (budgetMonth?.locked) {
      throw new CategoryMonthServiceError('month_locked');
    }
  }

  async function listByMonth(userId: string, month: string) {
    assertValidMonth(month);

    const monthId = await budgetMonthService.findBudgetMonthId(userId, month);
    if (!monthId) return [];
    return prisma.categoryMonth.findMany({ where: { userId, monthId } });
  }

  /** Batch lookup for DataLoader use — trusts the caller to have already scoped the ids to one user. */
  async function findManyByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return prisma.categoryMonth.findMany({ where: { id: { in: ids } } });
  }

  async function addCategoryToMonth(
    userId: string,
    categoryId: string,
    month: string,
    monthlyBudgetCents?: number,
  ) {
    if (monthlyBudgetCents !== undefined) assertValidBudget(monthlyBudgetCents);
    assertValidMonth(month);

    // Checked before resolveBudgetMonthId deliberately: that call upserts a
    // permanent BudgetMonth row with no delete path, so a bad categoryId
    // must fail before it, not after — otherwise every failed attempt
    // leaves a corrupt-but-permanent row behind.
    await assertOwnedCategory(prisma, userId, categoryId);

    const monthId = await budgetMonthService.resolveBudgetMonthId(userId, month);
    await assertMonthNotLocked(monthId);

    try {
      // Re-checked inside the transaction, against the transactional
      // client, right before the insert: narrows (does not fully close,
      // since this is a plain read with no row lock under Postgres's
      // default READ COMMITTED isolation) the window where a concurrent
      // delete of this same category could otherwise land between the
      // check above and the write, leaving a category_month row that
      // references an already-soft-deleted category.
      return await prisma.$transaction(async (tx) => {
        await assertOwnedCategory(tx, userId, categoryId);
        const resolvedBudget = await resolveBudgetForActivation(tx, categoryId, monthlyBudgetCents);

        return tx.categoryMonth.create({
          data: { userId, categoryId, monthId, monthlyBudgetCents: resolvedBudget },
        });
      });
    } catch (error) {
      if (error instanceof CategoryServiceError) {
        throw error;
      }
      if (hasPrismaErrorCode(error, 'P2002')) {
        throw new CategoryMonthServiceError('category_month_already_active');
      }
      throw error;
    }
  }

  /**
   * Idempotent, unlike addCategoryToMonth: returns the existing category_month
   * if the category is already active that month, only creates one (and only
   * then requires an explicit budget — never derived from anything) if it
   * isn't. For callers (recurring expenses) where "already active" is a
   * success case, not an error — see plan.md's step 4 design notes.
   */
  async function ensureActiveForCategory(
    userId: string,
    categoryId: string,
    month: string,
    monthlyBudgetCents?: number,
  ) {
    return prisma.$transaction((tx) =>
      ensureActiveForCategoryOnClient(tx, userId, categoryId, month, monthlyBudgetCents),
    );
  }

  async function removeCategoryFromMonth(userId: string, categoryMonthId: string): Promise<void> {
    const categoryMonth = await findOwnedCategoryMonth(userId, categoryMonthId);
    await assertMonthNotLocked(categoryMonth.monthId);

    const referencingTransaction = await prisma.transaction.findFirst({
      where: { categoryMonthId },
    });
    if (referencingTransaction) {
      throw new CategoryMonthServiceError('category_month_has_transactions');
    }

    try {
      await prisma.categoryMonth.delete({ where: { id: categoryMonthId } });
    } catch (error) {
      // A transaction can be created concurrently, after the check above
      // but before this delete lands — the onDelete: Restrict FK catches
      // it at the DB level. Map that to the same typed error the check
      // above would have thrown, rather than letting a raw Prisma error
      // through (which toGraphQLError doesn't know how to give a clean
      // extensions.code for).
      if (hasPrismaErrorCode(error, 'P2003')) {
        throw new CategoryMonthServiceError('category_month_has_transactions');
      }
      throw error;
    }
  }

  async function updateCategoryMonthBudget(
    userId: string,
    categoryMonthId: string,
    monthlyBudgetCents: number,
  ) {
    assertValidBudget(monthlyBudgetCents);

    const categoryMonth = await findOwnedCategoryMonth(userId, categoryMonthId);
    await assertMonthNotLocked(categoryMonth.monthId);

    return prisma.categoryMonth.update({
      where: { id: categoryMonthId },
      data: { monthlyBudgetCents },
    });
  }

  return {
    listByMonth,
    findManyByIds,
    addCategoryToMonth,
    ensureActiveForCategory,
    removeCategoryFromMonth,
    updateCategoryMonthBudget,
  };
}

export type CategoryMonthService = ReturnType<typeof createCategoryMonthService>;
