import type { BudgetMonthService } from '../budgetMonths/budgetMonthService.js';
import { CategoryServiceError } from './categoryService.js';
import { isValidMonthFormat } from '../../lib/monthFormat.js';
import type { PrismaClient } from '../../lib/prisma.js';

export type CategoryMonthServiceErrorReason =
  | 'category_month_not_found'
  | 'category_month_already_active'
  | 'category_month_has_transactions'
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

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
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
    monthlyBudgetCents: number,
  ) {
    assertValidBudget(monthlyBudgetCents);
    assertValidMonth(month);

    const monthId = await budgetMonthService.resolveBudgetMonthId(userId, month);
    await assertMonthNotLocked(monthId);

    try {
      // The ownership check and the insert run in one transaction so a
      // concurrent delete of this same category can't land in the gap
      // between "verified owned and not deleted" and "row created" — that
      // gap would otherwise let a category_month get created for a
      // category that's already soft-deleted, breaking deleteCategory's
      // invariant that a deleted category never has category_month rows.
      return await prisma.$transaction(async (tx) => {
        const category = await tx.category.findUnique({ where: { id: categoryId } });
        if (!category || category.userId !== userId || category.deletedAt) {
          throw new CategoryServiceError('category_not_found');
        }

        return tx.categoryMonth.create({
          data: { userId, categoryId, monthId, monthlyBudgetCents },
        });
      });
    } catch (error) {
      if (error instanceof CategoryServiceError) {
        throw error;
      }
      if (isUniqueConstraintError(error)) {
        throw new CategoryMonthServiceError('category_month_already_active');
      }
      throw error;
    }
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

    await prisma.categoryMonth.delete({ where: { id: categoryMonthId } });
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
    removeCategoryFromMonth,
    updateCategoryMonthBudget,
  };
}

export type CategoryMonthService = ReturnType<typeof createCategoryMonthService>;
