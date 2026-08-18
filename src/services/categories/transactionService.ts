import type { BudgetMonthService } from '../budgetMonths/budgetMonthService.js';
import { isValidMonthFormat } from '../../lib/monthFormat.js';
import type { PrismaClient } from '../../lib/prisma.js';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export interface TransactionInput {
  categoryMonthId: string;
  amountCents: number;
  date: string;
  merchant?: string;
  note?: string;
}

export type TransactionServiceErrorReason =
  | 'invalid_amount'
  | 'invalid_date'
  | 'invalid_month'
  | 'category_month_not_found'
  | 'month_locked'
  | 'date_month_mismatch'
  | 'transaction_not_found';

export class TransactionServiceError extends Error {
  constructor(public readonly reason: TransactionServiceErrorReason) {
    super(`Transaction operation failed: ${reason}`);
    this.name = 'TransactionServiceError';
  }
}

export interface TransactionServiceDeps {
  prisma: Pick<PrismaClient, 'transaction' | 'categoryMonth' | 'category' | 'budgetMonth'>;
  budgetMonthService: Pick<BudgetMonthService, 'findBudgetMonthId'>;
}

function assertValidAmount(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new TransactionServiceError('invalid_amount');
  }
}

function assertValidDateFormat(date: string): void {
  if (!DATE_REGEX.test(date)) {
    throw new TransactionServiceError('invalid_date');
  }
}

function assertValidMonth(month: string): void {
  if (!isValidMonthFormat(month)) {
    throw new TransactionServiceError('invalid_month');
  }
}

export function createTransactionService({ prisma, budgetMonthService }: TransactionServiceDeps) {
  async function loadCategoryMonthForWrite(userId: string, categoryMonthId: string, date: string) {
    const categoryMonth = await prisma.categoryMonth.findUnique({ where: { id: categoryMonthId } });
    if (!categoryMonth || categoryMonth.userId !== userId) {
      throw new TransactionServiceError('category_month_not_found');
    }

    const budgetMonth = await prisma.budgetMonth.findUnique({ where: { id: categoryMonth.monthId } });
    if (budgetMonth?.locked) {
      throw new TransactionServiceError('month_locked');
    }
    if (budgetMonth && date.slice(0, 7) !== budgetMonth.month) {
      throw new TransactionServiceError('date_month_mismatch');
    }

    const category = await prisma.category.findUnique({ where: { id: categoryMonth.categoryId } });
    if (!category) {
      throw new Error(`Data integrity error: Category ${categoryMonth.categoryId} not found`);
    }
    return { categoryMonth, direction: category.direction };
  }

  async function assertOwnedTransactionMonthNotLocked(categoryMonthId: string): Promise<void> {
    const categoryMonth = await prisma.categoryMonth.findUnique({ where: { id: categoryMonthId } });
    if (!categoryMonth) return;
    const budgetMonth = await prisma.budgetMonth.findUnique({ where: { id: categoryMonth.monthId } });
    if (budgetMonth?.locked) {
      throw new TransactionServiceError('month_locked');
    }
  }

  async function create(userId: string, input: TransactionInput) {
    assertValidAmount(input.amountCents);
    assertValidDateFormat(input.date);
    const { direction } = await loadCategoryMonthForWrite(userId, input.categoryMonthId, input.date);

    return prisma.transaction.create({
      data: {
        userId,
        categoryMonthId: input.categoryMonthId,
        amountCents: input.amountCents,
        date: new Date(input.date),
        merchant: input.merchant ?? null,
        note: input.note ?? null,
        direction,
      },
    });
  }

  async function update(userId: string, id: string, input: TransactionInput) {
    assertValidAmount(input.amountCents);
    assertValidDateFormat(input.date);

    const existing = await prisma.transaction.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      throw new TransactionServiceError('transaction_not_found');
    }

    // The transaction's current month must not be locked, regardless of
    // whether categoryMonthId is changing — a locked month's rows are
    // immutable, editing-out-of-it included.
    await assertOwnedTransactionMonthNotLocked(existing.categoryMonthId);

    const { direction } = await loadCategoryMonthForWrite(userId, input.categoryMonthId, input.date);

    return prisma.transaction.update({
      where: { id },
      data: {
        categoryMonthId: input.categoryMonthId,
        amountCents: input.amountCents,
        date: new Date(input.date),
        merchant: input.merchant ?? null,
        note: input.note ?? null,
        direction,
      },
    });
  }

  async function deleteTransaction(userId: string, id: string): Promise<void> {
    const existing = await prisma.transaction.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      throw new TransactionServiceError('transaction_not_found');
    }

    await assertOwnedTransactionMonthNotLocked(existing.categoryMonthId);

    await prisma.transaction.delete({ where: { id } });
  }

  async function list(userId: string, month: string, categoryId?: string) {
    assertValidMonth(month);

    const monthId = await budgetMonthService.findBudgetMonthId(userId, month);
    if (!monthId) return [];

    const categoryMonths = await prisma.categoryMonth.findMany({
      where: categoryId ? { userId, monthId, categoryId } : { userId, monthId },
    });
    const categoryMonthIds = categoryMonths.map((categoryMonth) => categoryMonth.id);
    if (categoryMonthIds.length === 0) return [];

    // userId filtered directly too, defense in depth — not solely reliant
    // on the categoryMonths lookup above already being user-scoped.
    const transactions = await prisma.transaction.findMany({
      where: { userId, categoryMonthId: { in: categoryMonthIds } },
    });

    return transactions.sort(
      (a, b) => b.date.getTime() - a.date.getTime() || b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  /** Batch lookup for DataLoader use — trusts the caller to have already scoped the ids to one user. */
  async function listByCategoryMonthIds(categoryMonthIds: string[]) {
    if (categoryMonthIds.length === 0) return [];
    return prisma.transaction.findMany({ where: { categoryMonthId: { in: categoryMonthIds } } });
  }

  return { create, update, deleteTransaction, list, listByCategoryMonthIds };
}

export type TransactionService = ReturnType<typeof createTransactionService>;
