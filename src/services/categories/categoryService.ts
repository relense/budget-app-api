import type { PrismaClient } from '../../lib/prisma.js';

export type BudgetType = 'preciso' | 'quero' | 'poupanca';
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

export function createCategoryService({ prisma }: CategoryServiceDeps) {
  function assertValidBudgetType(direction: Direction, budgetType?: BudgetType): void {
    if (direction === 'expense' && !budgetType) {
      throw new CategoryServiceError('budget_type_required_for_expense');
    }
  }

  async function findOwnedCategory(userId: string, id: string) {
    const category = await prisma.category.findUnique({ where: { id } });
    if (!category || category.userId !== userId || category.deletedAt) {
      throw new CategoryServiceError('category_not_found');
    }
    return category;
  }

  async function createCategory(userId: string, input: CategoryInput) {
    assertValidBudgetType(input.direction, input.budgetType);

    return prisma.category.create({
      data: {
        userId,
        name: input.name,
        icon: input.icon,
        color: input.color,
        budgetType: input.budgetType ?? null,
        direction: input.direction,
      },
    });
  }

  async function updateCategory(userId: string, id: string, input: CategoryInput) {
    const existing = await findOwnedCategory(userId, id);
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
        budgetType: input.budgetType ?? null,
        direction: input.direction,
      },
    });
  }

  async function deleteCategory(userId: string, id: string): Promise<void> {
    await findOwnedCategory(userId, id);

    const existingCategoryMonth = await prisma.categoryMonth.findFirst({ where: { categoryId: id } });
    if (existingCategoryMonth) {
      throw new CategoryServiceError('category_has_active_months');
    }

    await prisma.category.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  return { createCategory, updateCategory, deleteCategory };
}

export type CategoryService = ReturnType<typeof createCategoryService>;
