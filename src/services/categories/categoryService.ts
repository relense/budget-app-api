import type { PrismaClient } from '../../lib/prisma.js';
import { hasPrismaErrorCode } from '../../lib/prismaErrors.js';

export type BudgetType = 'need' | 'want' | 'savings';
export type Direction = 'expense' | 'income';

export interface CategoryInput {
  name: string;
  icon: string;
  color: string;
  budgetType?: BudgetType;
  direction: Direction;
}

export type CategoryServiceErrorReason =
  | 'budget_type_required_for_expense'
  | 'category_not_found'
  | 'direction_change_blocked'
  | 'category_has_active_months';

export class CategoryServiceError extends Error {
  constructor(public readonly reason: CategoryServiceErrorReason) {
    super(`Category operation failed: ${reason}`);
    this.name = 'CategoryServiceError';
  }
}

export interface CategoryServiceDeps {
  prisma: Pick<PrismaClient, 'category' | 'categoryMonth' | 'transaction'>;
}

/**
 * The single ownership-check implementation, shared by categoryService
 * (bound to its own prisma) and categoryMonthService (which needs to run
 * it against a transactional client too, so it can't just call a method
 * pre-bound to a different client) — parameterized on the client instead
 * of duplicated per caller.
 */
export async function assertOwnedCategory(
  client: Pick<PrismaClient, 'category'>,
  userId: string,
  id: string,
) {
  const category = await client.category.findUnique({ where: { id } });
  if (!category || category.userId !== userId) {
    throw new CategoryServiceError('category_not_found');
  }
  return category;
}

/**
 * Standalone so callers that build a CategoryInput outside the normal
 * createCategory/updateCategory flow (e.g. authService seeding the default
 * catalog on signup) can validate against the same rule instead of
 * silently drifting from it if this rule ever changes.
 */
export function assertValidBudgetType(direction: Direction, budgetType?: BudgetType): void {
  if (direction === 'expense' && !budgetType) {
    throw new CategoryServiceError('budget_type_required_for_expense');
  }
}

export function createCategoryService({ prisma }: CategoryServiceDeps) {
  /** budgetType isn't meaningful for income categories — normalize it away rather than trust the caller. */
  function normalizeBudgetType(direction: Direction, budgetType?: BudgetType): BudgetType | null {
    return direction === 'income' ? null : (budgetType ?? null);
  }

  async function listCatalog(userId: string) {
    return prisma.category.findMany({ where: { userId } });
  }

  /** Batch lookup for DataLoader use — trusts the caller to have already scoped the ids to one user. */
  async function findManyByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return prisma.category.findMany({ where: { id: { in: ids } } });
  }

  async function createCategory(userId: string, input: CategoryInput) {
    assertValidBudgetType(input.direction, input.budgetType);

    return prisma.category.create({
      data: {
        userId,
        name: input.name,
        icon: input.icon,
        color: input.color,
        budgetType: normalizeBudgetType(input.direction, input.budgetType),
        direction: input.direction,
      },
    });
  }

  async function updateCategory(userId: string, id: string, input: CategoryInput) {
    const existing = await assertOwnedCategory(prisma, userId, id);
    assertValidBudgetType(input.direction, input.budgetType);

    if (input.direction !== existing.direction) {
      const categoryMonths = await prisma.categoryMonth.findMany({ where: { categoryId: id } });
      const categoryMonthIds = categoryMonths.map((categoryMonth) => categoryMonth.id);
      const referencingTransaction =
        categoryMonthIds.length > 0
          ? await prisma.transaction.findFirst({
              where: { categoryMonthId: { in: categoryMonthIds } },
            })
          : null;

      if (referencingTransaction) {
        throw new CategoryServiceError('direction_change_blocked');
      }
    }

    return prisma.category.update({
      where: { id },
      data: {
        name: input.name,
        icon: input.icon,
        color: input.color,
        budgetType: normalizeBudgetType(input.direction, input.budgetType),
        direction: input.direction,
      },
    });
  }

  async function deleteCategory(userId: string, id: string): Promise<void> {
    await assertOwnedCategory(prisma, userId, id);

    const existingCategoryMonth = await prisma.categoryMonth.findFirst({ where: { categoryId: id } });
    if (existingCategoryMonth) {
      throw new CategoryServiceError('category_has_active_months');
    }

    try {
      // Hard delete now, backed by CategoryMonth.category's and
      // RecurringExpense.category's onDelete: Restrict FKs — the DB-level
      // backstop closes the race the pre-check above can't (a concurrent
      // category_month or recurring-expense insert landing between the
      // check and this delete).
      await prisma.category.delete({ where: { id } });
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2003')) {
        throw new CategoryServiceError('category_has_active_months');
      }
      throw error;
    }
  }

  return {
    listCatalog,
    findManyByIds,
    createCategory,
    updateCategory,
    deleteCategory,
  };
}

export type CategoryService = ReturnType<typeof createCategoryService>;
