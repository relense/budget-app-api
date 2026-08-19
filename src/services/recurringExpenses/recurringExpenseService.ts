import { addMonths } from '../../lib/monthFormat.js';
import type { PrismaClient } from '../../lib/prisma.js';
import { hasPrismaErrorCode } from '../../lib/prismaErrors.js';
import { withSavepoint } from '../../lib/prismaSavepoint.js';
import type { BudgetMonthService } from '../budgetMonths/budgetMonthService.js';
import { lockBudgetMonthRow } from '../budgetMonths/budgetMonthService.js';
import { assertOwnedCategory } from '../categories/categoryService.js';
import type { BudgetType } from '../categories/categoryService.js';
import { ensureActiveForCategoryOnClient } from '../categories/categoryMonthService.js';
import type { TransactionService } from '../categories/transactionService.js';

/** Narrower than Category's BudgetType — 'savings' doesn't apply to a recurring obligation. */
export type RecurringBudgetType = 'need' | 'want';

export interface RecurringExpenseInput {
  name: string;
  amountCents: number;
  categoryId: string;
  /** Widened to accept 'savings' at the boundary — assertValidBudgetType rejects it at runtime. */
  budgetType: BudgetType;
  dueDay: number;
}

export interface MarkRecurringPaidInput {
  amountCents: number;
  date: string;
  merchant?: string;
  note?: string;
}

export type RecurringExpenseServiceErrorReason =
  | 'invalid_amount'
  | 'invalid_due_day'
  | 'invalid_budget_type'
  | 'invalid_category_direction'
  | 'recurring_expense_not_found'
  | 'duplicate_name'
  | 'recurring_expense_has_transactions'
  | 'month_locked';

export class RecurringExpenseServiceError extends Error {
  constructor(public readonly reason: RecurringExpenseServiceErrorReason) {
    super(`RecurringExpense operation failed: ${reason}`);
    this.name = 'RecurringExpenseServiceError';
  }
}

export interface RecurringExpenseServiceDeps {
  prisma: Pick<
    PrismaClient,
    | 'category'
    | 'categoryMonth'
    | 'recurringExpense'
    | 'transaction'
    | 'budgetMonth'
    | '$transaction'
    | '$queryRaw'
  >;
  budgetMonthService: Pick<BudgetMonthService, 'findBudgetMonthId'>;
  transactionService: Pick<TransactionService, 'create'>;
  now?: () => Date;
}

function assertValidAmount(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new RecurringExpenseServiceError('invalid_amount');
  }
}

function assertValidDueDay(dueDay: number): void {
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
    throw new RecurringExpenseServiceError('invalid_due_day');
  }
}

function assertValidBudgetType(budgetType: BudgetType): asserts budgetType is RecurringBudgetType {
  if (budgetType !== 'need' && budgetType !== 'want') {
    throw new RecurringExpenseServiceError('invalid_budget_type');
  }
}

/**
 * Read-only. Validates a RecurringExpenseInput's own fields plus its
 * category (owned, expense-direction — an income category has no meaning
 * here, since markRecurringPaid derives the resulting transaction's
 * direction from it). Run before any write so an invalid input can't leave
 * a partial category-activation behind.
 */
async function assertValidInput(
  client: Pick<PrismaClient, 'category'>,
  userId: string,
  input: RecurringExpenseInput,
): Promise<void> {
  assertValidAmount(input.amountCents);
  assertValidDueDay(input.dueDay);
  assertValidBudgetType(input.budgetType);
  const category = await assertOwnedCategory(client, userId, input.categoryId);
  if (category.direction !== 'expense') {
    throw new RecurringExpenseServiceError('invalid_category_direction');
  }
}

async function findOwnedRecurringExpense(
  client: Pick<PrismaClient, 'recurringExpense'>,
  userId: string,
  id: string,
) {
  const row = await client.recurringExpense.findUnique({ where: { id } });
  if (!row || row.userId !== userId) {
    throw new RecurringExpenseServiceError('recurring_expense_not_found');
  }
  return row;
}

export function createRecurringExpenseService({
  prisma,
  budgetMonthService,
  transactionService,
  now = () => new Date(),
}: RecurringExpenseServiceDeps) {
  /**
   * Takes lockBudgetMonthRow before checking `locked` — must be called
   * inside a $transaction. Closes the race a plain read would leave open
   * against a concurrent lockMonth, same pattern as
   * categoryMonthService/transactionService.
   */
  async function assertMonthNotLockedOnClient(
    client: Pick<PrismaClient, 'budgetMonth' | '$queryRaw'>,
    monthId: string,
  ): Promise<void> {
    await lockBudgetMonthRow(client, monthId);
    const budgetMonth = await client.budgetMonth.findUnique({ where: { id: monthId } });
    if (budgetMonth?.locked) {
      throw new RecurringExpenseServiceError('month_locked');
    }
  }

  /**
   * Copies every recurring expense from the previous calendar month into a
   * brand-new one — the automatic carry-forward decided in docs/PLAN.md's
   * Data Model section (no per-item opt-in, unlike category/budget
   * carry-forward). Called once, right after createRecurringExpense or
   * categoryMonthService.addCategoryToMonth detects it just created a
   * month's BudgetMonth row for the first time — see either call site for
   * why this isn't nested inside their own transaction (Prisma doesn't
   * support nesting $transaction calls; this owns its own atomicity
   * boundary instead).
   *
   * Silently no-ops if the previous month doesn't exist (nothing to copy)
   * or — an extremely narrow race, the new month getting locked in the gap
   * between its own creation and this call running — the target month is
   * already locked: the action that triggered this (already succeeded)
   * shouldn't fail because of a missed carry-forward.
   */
  async function seedNewMonth(userId: string, month: string, monthId: string): Promise<void> {
    const previousMonthId = await budgetMonthService.findBudgetMonthId(userId, addMonths(month, -1));
    if (!previousMonthId) return;

    const previousItems = await prisma.recurringExpense.findMany({
      where: { userId, monthId: previousMonthId },
    });
    if (previousItems.length === 0) return;

    await prisma.$transaction(async (tx) => {
      await lockBudgetMonthRow(tx, monthId);
      const budgetMonth = await tx.budgetMonth.findUnique({ where: { id: monthId } });
      if (budgetMonth?.locked) return;

      for (const item of previousItems) {
        const { categoryMonth } = await ensureActiveForCategoryOnClient(
          tx,
          userId,
          item.categoryId,
          month,
          undefined,
          now,
        );
        // Under withSavepoint, not a plain try/catch — a name collision
        // here (e.g. against something explicitly created moments earlier
        // by the very call that triggered this seed) needs the loop to
        // keep querying tx for the next item, which a caught-but-unwound
        // Postgres error would otherwise block for the rest of this
        // transaction. See withSavepoint's doc comment.
        const attempt = await withSavepoint(tx, 'seed_recurring_expense', () =>
          tx.recurringExpense.create({
            data: {
              userId,
              monthId: categoryMonth.monthId,
              categoryId: item.categoryId,
              name: item.name,
              amountCents: item.amountCents,
              budgetType: item.budgetType,
              dueDay: item.dueDay,
            },
          }),
        );
        if (!attempt.ok && !hasPrismaErrorCode(attempt.error, 'P2002')) {
          throw attempt.error;
        }
      }
    });
  }

  /**
   * First-time creation "for" a month — no template to reuse, unlike the
   * superseded design (see docs/PLAN.md). Auto-activates the category for
   * this month if it isn't already (categoryMonthlyBudgetCents required
   * only then, never derived from amountCents — see the Data Model note).
   * If this call is also the one that creates the month itself, carries
   * every recurring expense from the previous month forward into it too —
   * seedNewMonth runs after this transaction commits, not nested inside it.
   */
  async function createRecurringExpense(
    userId: string,
    input: RecurringExpenseInput,
    month: string,
    categoryMonthlyBudgetCents?: number,
  ) {
    await assertValidInput(prisma, userId, input);

    let monthWasCreated = false;
    let monthId = '';
    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const { categoryMonth, monthWasCreated: wasCreated } = await ensureActiveForCategoryOnClient(
          tx,
          userId,
          input.categoryId,
          month,
          categoryMonthlyBudgetCents,
          now,
        );
        monthWasCreated = wasCreated;
        monthId = categoryMonth.monthId;

        return tx.recurringExpense.create({
          data: {
            userId,
            monthId: categoryMonth.monthId,
            categoryId: input.categoryId,
            name: input.name,
            amountCents: input.amountCents,
            budgetType: input.budgetType,
            dueDay: input.dueDay,
          },
        });
      });
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2002')) {
        throw new RecurringExpenseServiceError('duplicate_name');
      }
      throw error;
    }

    // Best-effort, not allowed to fail the create above — that already
    // succeeded and is what's returned. A transient error here just means
    // the new month's other recurring expenses need adding manually,
    // same reasoning as categoryMonthService.addCategoryToMonth's
    // onNewBudgetMonth call (pr-reviewer flagged the missing try/catch).
    if (monthWasCreated) {
      try {
        await seedNewMonth(userId, month, monthId);
      } catch {
        // Swallowed deliberately — see comment above.
      }
    }

    return created;
  }

  /**
   * A flat edit — name/category/budgetType/dueDay/amountCents together, on
   * exactly this one row/month. No propagation question (see docs/PLAN.md):
   * it never touches any other month's row. Changing categoryId
   * auto-activates the new category for this same month if it isn't
   * already (inherits budget the same way creation does — no budget
   * parameter here, matching docs/PLAN.md's decided mutation shape; if the
   * new category has never had a budget anywhere, that's surfaced as the
   * same category_month_budget_required error activation always throws).
   */
  async function updateRecurringExpense(userId: string, id: string, input: RecurringExpenseInput) {
    // Ownership of the row being edited checked before validating the new
    // input — same ordering as the superseded updateTemplate had, so a
    // wrong-user request surfaces recurring_expense_not_found rather than
    // leaking whether some other user's category id happens to be valid.
    const existing = await findOwnedRecurringExpense(prisma, userId, id);
    await assertValidInput(prisma, userId, input);

    try {
      return await prisma.$transaction(async (tx) => {
        await assertMonthNotLockedOnClient(tx, existing.monthId);
        const budgetMonth = await tx.budgetMonth.findUnique({ where: { id: existing.monthId } });
        if (!budgetMonth) {
          throw new Error(`Data integrity error: BudgetMonth ${existing.monthId} not found`);
        }
        await ensureActiveForCategoryOnClient(tx, userId, input.categoryId, budgetMonth.month, undefined, now);
        return tx.recurringExpense.update({
          where: { id },
          data: {
            name: input.name,
            amountCents: input.amountCents,
            categoryId: input.categoryId,
            budgetType: input.budgetType,
            dueDay: input.dueDay,
          },
        });
      });
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2002')) {
        throw new RecurringExpenseServiceError('duplicate_name');
      }
      throw error;
    }
  }

  async function removeFromMonth(userId: string, id: string): Promise<void> {
    const existing = await findOwnedRecurringExpense(prisma, userId, id);

    try {
      await prisma.$transaction(async (tx) => {
        await assertMonthNotLockedOnClient(tx, existing.monthId);

        const referencingTransaction = await tx.transaction.findFirst({
          where: { recurringExpenseId: id },
        });
        if (referencingTransaction) {
          throw new RecurringExpenseServiceError('recurring_expense_has_transactions');
        }

        await tx.recurringExpense.delete({ where: { id } });
      });
    } catch (error) {
      if (error instanceof RecurringExpenseServiceError) {
        throw error;
      }
      if (hasPrismaErrorCode(error, 'P2003')) {
        throw new RecurringExpenseServiceError('recurring_expense_has_transactions');
      }
      throw error;
    }
  }

  /** Records a payment against a recurring expense. May be called more than once (split payments). */
  async function markRecurringPaid(userId: string, id: string, input: MarkRecurringPaidInput) {
    const existing = await findOwnedRecurringExpense(prisma, userId, id);
    const categoryMonth = await prisma.categoryMonth.findUnique({
      where: { categoryId_monthId: { categoryId: existing.categoryId, monthId: existing.monthId } },
    });
    if (!categoryMonth) {
      throw new Error(
        `Data integrity error: CategoryMonth not found for category ${existing.categoryId} month ${existing.monthId}`,
      );
    }

    return transactionService.create(
      userId,
      {
        categoryMonthId: categoryMonth.id,
        amountCents: input.amountCents,
        date: input.date,
        merchant: input.merchant,
        note: input.note,
      },
      id,
    );
  }

  async function listByMonth(userId: string, month: string) {
    const monthId = await budgetMonthService.findBudgetMonthId(userId, month);
    if (!monthId) return [];
    return prisma.recurringExpense.findMany({ where: { userId, monthId } });
  }

  /** Batch lookup for DataLoader use — trusts the caller to have already scoped the ids to one user. */
  async function findManyByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return prisma.recurringExpense.findMany({ where: { id: { in: ids } } });
  }

  /**
   * Sum of amountCents across every recurring expense active under
   * categoryId for monthId. No userId parameter, unlike the
   * findManyByIds-style batch functions above — safe because categoryId can
   * only ever be one this user owns (assertOwnedCategory already ran when
   * the caller resolved it, e.g. via the categoryById DataLoader), so
   * there's no separate id list here that a caller could pass unscoped.
   */
  async function sumCommittedCentsForCategoryMonth(categoryId: string, monthId: string): Promise<number> {
    const items = await prisma.recurringExpense.findMany({ where: { categoryId, monthId } });
    return items.reduce((sum, item) => sum + item.amountCents, 0);
  }

  return {
    createRecurringExpense,
    updateRecurringExpense,
    removeFromMonth,
    markRecurringPaid,
    listByMonth,
    findManyByIds,
    sumCommittedCentsForCategoryMonth,
    seedNewMonth,
  };
}

export type RecurringExpenseService = ReturnType<typeof createRecurringExpenseService>;
