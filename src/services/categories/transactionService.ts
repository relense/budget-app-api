import type { BudgetMonthService } from '../budgetMonths/budgetMonthService.js';
import { lockBudgetMonthRow } from '../budgetMonths/budgetMonthService.js';
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
  prisma: Pick<
    PrismaClient,
    'transaction' | 'categoryMonth' | 'category' | 'budgetMonth' | '$transaction' | '$queryRaw'
  >;
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
  /**
   * Takes lockBudgetMonthRow before checking `locked` — must be called
   * inside a $transaction, against the transactional client. Every write
   * path below goes through this (directly or via loadCategoryMonthForWrite),
   * so a lockMonth call landing concurrently is actually serialized
   * against, not just raced with a plain read.
   */
  async function assertBudgetMonthNotLockedById(
    client: Pick<PrismaClient, 'budgetMonth' | '$queryRaw'>,
    monthId: string,
  ): Promise<void> {
    await lockBudgetMonthRow(client, monthId);
    const budgetMonth = await client.budgetMonth.findUnique({ where: { id: monthId } });
    if (budgetMonth?.locked) {
      throw new TransactionServiceError('month_locked');
    }
  }

  async function loadCategoryMonthForWrite(
    client: Pick<PrismaClient, 'categoryMonth' | 'budgetMonth' | 'category' | '$queryRaw'>,
    userId: string,
    categoryMonthId: string,
    date: string,
  ) {
    const categoryMonth = await client.categoryMonth.findUnique({ where: { id: categoryMonthId } });
    if (!categoryMonth || categoryMonth.userId !== userId) {
      throw new TransactionServiceError('category_month_not_found');
    }

    await assertBudgetMonthNotLockedById(client, categoryMonth.monthId);
    const budgetMonth = await client.budgetMonth.findUnique({ where: { id: categoryMonth.monthId } });
    if (budgetMonth && date.slice(0, 7) !== budgetMonth.month) {
      throw new TransactionServiceError('date_month_mismatch');
    }

    const category = await client.category.findUnique({ where: { id: categoryMonth.categoryId } });
    if (!category) {
      throw new Error(`Data integrity error: Category ${categoryMonth.categoryId} not found`);
    }
    return { categoryMonth, direction: category.direction };
  }

  async function assertOwnedTransactionMonthNotLocked(
    client: Pick<PrismaClient, 'categoryMonth' | 'budgetMonth' | '$queryRaw'>,
    categoryMonthId: string,
  ): Promise<void> {
    const categoryMonth = await client.categoryMonth.findUnique({ where: { id: categoryMonthId } });
    if (!categoryMonth) return;
    await assertBudgetMonthNotLockedById(client, categoryMonth.monthId);
  }

  /**
   * recurringExpenseId is deliberately not part of TransactionInput (never
   * client-settable, same reasoning as direction) — only
   * recurringExpenseService's markRecurringPaid passes it, as a third
   * argument, after resolving which recurring expense this payment is for.
   */
  async function create(userId: string, input: TransactionInput, recurringExpenseId?: string) {
    assertValidAmount(input.amountCents);
    assertValidDateFormat(input.date);

    return prisma.$transaction(async (tx) => {
      const { direction } = await loadCategoryMonthForWrite(tx, userId, input.categoryMonthId, input.date);

      return tx.transaction.create({
        data: {
          userId,
          categoryMonthId: input.categoryMonthId,
          recurringExpenseId: recurringExpenseId ?? null,
          amountCents: input.amountCents,
          date: new Date(input.date),
          merchant: input.merchant ?? null,
          note: input.note ?? null,
          direction,
        },
      });
    });
  }

  async function update(userId: string, id: string, input: TransactionInput) {
    assertValidAmount(input.amountCents);
    assertValidDateFormat(input.date);

    return prisma.$transaction(async (tx) => {
      const existing = await tx.transaction.findUnique({ where: { id } });
      if (!existing || existing.userId !== userId) {
        throw new TransactionServiceError('transaction_not_found');
      }

      // When categoryMonthId is changing to a different month, this
      // transaction ends up locking two distinct budget_months rows (the
      // transaction's current month, and the target month). Pre-lock every
      // distinct row involved in a canonical (sorted) order, regardless of
      // which is "old" and which is "new" — otherwise two concurrent
      // updates swapping a transaction between the same two months in
      // opposite directions could lock them in opposite orders and
      // deadlock (Postgres aborts one with 40P01). The checks below
      // re-lock the same rows via assertOwnedTransactionMonthNotLocked/
      // loadCategoryMonthForWrite — harmless, a transaction can re-acquire
      // a row lock it already holds.
      const existingCategoryMonth = await tx.categoryMonth.findUnique({
        where: { id: existing.categoryMonthId },
      });
      const targetCategoryMonth = await tx.categoryMonth.findUnique({
        where: { id: input.categoryMonthId },
      });
      const monthIdsToLock = new Set<string>();
      if (existingCategoryMonth) monthIdsToLock.add(existingCategoryMonth.monthId);
      // Ownership-gated: unlike existingCategoryMonth (already implied
      // owned — it came off a transaction row whose userId was just
      // checked above), input.categoryMonthId is client-supplied and
      // unverified at this point. Without this check, an unowned/guessed
      // id would still contribute its budget_months row to the pre-lock
      // step below — taking a real row lock against another tenant's data
      // before loadCategoryMonthForWrite's ownership check ever runs.
      if (targetCategoryMonth && targetCategoryMonth.userId === userId) {
        monthIdsToLock.add(targetCategoryMonth.monthId);
      }
      for (const monthId of Array.from(monthIdsToLock).sort()) {
        await lockBudgetMonthRow(tx, monthId);
      }

      // The transaction's current month must not be locked, regardless of
      // whether categoryMonthId is changing — a locked month's rows are
      // immutable, editing-out-of-it included.
      await assertOwnedTransactionMonthNotLocked(tx, existing.categoryMonthId);

      const { direction } = await loadCategoryMonthForWrite(tx, userId, input.categoryMonthId, input.date);

      return tx.transaction.update({
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
    });
  }

  async function deleteTransaction(userId: string, id: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.transaction.findUnique({ where: { id } });
      if (!existing || existing.userId !== userId) {
        throw new TransactionServiceError('transaction_not_found');
      }

      await assertOwnedTransactionMonthNotLocked(tx, existing.categoryMonthId);

      await tx.transaction.delete({ where: { id } });
    });
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

  /** Batch lookup for DataLoader use — trusts the caller to have already scoped the ids to one user. */
  async function listByRecurringExpenseIds(recurringExpenseIds: string[]) {
    if (recurringExpenseIds.length === 0) return [];
    return prisma.transaction.findMany({
      where: { recurringExpenseId: { in: recurringExpenseIds } },
    });
  }

  return {
    create,
    update,
    deleteTransaction,
    list,
    listByCategoryMonthIds,
    listByRecurringExpenseIds,
  };
}

export type TransactionService = ReturnType<typeof createTransactionService>;
