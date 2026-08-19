import { assertOwnedCategory } from '../categories/categoryService.js';
import type { BudgetType } from '../categories/categoryService.js';
import type { PrismaClient } from '../../lib/prisma.js';

/** Narrower than Category's BudgetType — 'savings' doesn't apply to a recurring obligation. */
export type RecurringBudgetType = 'need' | 'want';

export interface RecurringExpenseTemplateInput {
  name: string;
  amountCents: number;
  categoryId: string;
  /** Widened to accept 'savings' at the boundary — assertValidBudgetType rejects it at runtime. */
  budgetType: BudgetType;
  dueDay: number;
}

export type RecurringExpenseTemplateServiceErrorReason =
  | 'invalid_amount'
  | 'invalid_due_day'
  | 'invalid_budget_type'
  | 'template_not_found'
  | 'template_has_active_instances'
  | 'category_change_blocked';

export class RecurringExpenseTemplateServiceError extends Error {
  constructor(public readonly reason: RecurringExpenseTemplateServiceErrorReason) {
    super(`RecurringExpenseTemplate operation failed: ${reason}`);
    this.name = 'RecurringExpenseTemplateServiceError';
  }
}

export interface RecurringExpenseTemplateServiceDeps {
  prisma: Pick<
    PrismaClient,
    'category' | 'recurringExpenseTemplate' | 'recurringExpenseInstance' | '$transaction' | '$queryRaw'
  >;
}

function hasPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
  );
}

function assertValidAmount(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new RecurringExpenseTemplateServiceError('invalid_amount');
  }
}

function assertValidDueDay(dueDay: number): void {
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
    throw new RecurringExpenseTemplateServiceError('invalid_due_day');
  }
}

function assertValidBudgetType(budgetType: BudgetType): asserts budgetType is RecurringBudgetType {
  if (budgetType !== 'need' && budgetType !== 'want') {
    throw new RecurringExpenseTemplateServiceError('invalid_budget_type');
  }
}

/**
 * Public so recurringExpenseInstanceService can validate a template input
 * up front — before a separate, unrelated write (auto-activating the
 * category for a month) that must not happen if this input turns out to be
 * invalid. Read-only: does not persist anything.
 */
export async function assertValidTemplateInput(
  client: Pick<PrismaClient, 'category'>,
  userId: string,
  input: RecurringExpenseTemplateInput,
): Promise<void> {
  assertValidAmount(input.amountCents);
  assertValidDueDay(input.dueDay);
  assertValidBudgetType(input.budgetType);
  await assertOwnedCategory(client, userId, input.categoryId);
}

/** Public so recurringExpenseInstanceService can reuse the same ownership check. */
export async function assertOwnedTemplate(
  client: Pick<PrismaClient, 'recurringExpenseTemplate'>,
  userId: string,
  id: string,
) {
  const template = await client.recurringExpenseTemplate.findUnique({ where: { id } });
  if (!template || template.userId !== userId) {
    throw new RecurringExpenseTemplateServiceError('template_not_found');
  }
  return template;
}

/**
 * Takes a row lock on the template (SELECT ... FOR UPDATE) — must be called
 * inside a $transaction. Public so recurringExpenseInstanceService can take
 * the same lock before inserting an instance, so a concurrent
 * updateTemplate categoryId change and a concurrent instance creation for
 * the same template can never interleave: whichever transaction acquires
 * the lock first fully commits (or rolls back) before the other proceeds.
 * Table/column names are the raw SQL ones (@@map/@map in schema.prisma),
 * not the Prisma model names.
 */
export async function lockTemplateRow(
  tx: Pick<PrismaClient, '$queryRaw'>,
  id: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM recurring_expense_templates WHERE id = ${id} FOR UPDATE`;
}

export function createRecurringExpenseTemplateService({ prisma }: RecurringExpenseTemplateServiceDeps) {
  async function listCatalog(userId: string) {
    return prisma.recurringExpenseTemplate.findMany({ where: { userId } });
  }

  /** Batch lookup for DataLoader use — trusts the caller to have already scoped the ids to one user. */
  async function findManyByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return prisma.recurringExpenseTemplate.findMany({ where: { id: { in: ids } } });
  }

  async function createTemplate(userId: string, input: RecurringExpenseTemplateInput) {
    await assertValidTemplateInput(prisma, userId, input);

    return prisma.recurringExpenseTemplate.create({
      data: {
        userId,
        name: input.name,
        amountCents: input.amountCents,
        categoryId: input.categoryId,
        budgetType: input.budgetType,
        dueDay: input.dueDay,
      },
    });
  }

  async function updateTemplate(userId: string, id: string, input: RecurringExpenseTemplateInput) {
    const existing = await assertOwnedTemplate(prisma, userId, id);
    assertValidAmount(input.amountCents);
    assertValidDueDay(input.dueDay);
    assertValidBudgetType(input.budgetType);
    await assertOwnedCategory(prisma, userId, input.categoryId);

    const data = {
      name: input.name,
      amountCents: input.amountCents,
      categoryId: input.categoryId,
      budgetType: input.budgetType,
      dueDay: input.dueDay,
    };

    if (input.categoryId === existing.categoryId) {
      return prisma.recurringExpenseTemplate.update({ where: { id }, data });
    }

    // Instances don't snapshot their own categoryId — recurringCommittedCents
    // always looks it up via the template's *current* categoryId. Changing it
    // once an instance exists would retroactively move that instance's
    // amount out of one category's committed total and into another's for
    // months that have already happened (possibly already locked). Mirrors
    // updateCategory's direction_change_blocked guard.
    //
    // No onDelete: Restrict backstop applies here (this is an UPDATE, not a
    // delete), so the check-then-write race is closed explicitly: lock the
    // template row before checking, inside the same transaction as the
    // write. createInstanceRow takes the identical lock before inserting an
    // instance, so the two paths can never interleave.
    return prisma.$transaction(async (tx) => {
      await lockTemplateRow(tx, id);
      const existingInstance = await tx.recurringExpenseInstance.findFirst({ where: { templateId: id } });
      if (existingInstance) {
        throw new RecurringExpenseTemplateServiceError('category_change_blocked');
      }
      return tx.recurringExpenseTemplate.update({ where: { id }, data });
    });
  }

  async function deleteTemplate(userId: string, id: string): Promise<void> {
    await assertOwnedTemplate(prisma, userId, id);

    const existingInstance = await prisma.recurringExpenseInstance.findFirst({
      where: { templateId: id },
    });
    if (existingInstance) {
      throw new RecurringExpenseTemplateServiceError('template_has_active_instances');
    }

    try {
      // Hard delete now, backed by RecurringExpenseInstance.template's
      // onDelete: Restrict FK — the DB-level backstop closes the race the
      // pre-check above can't (a concurrent instance insert landing between
      // the check and this delete), same pattern as removeFromMonth.
      await prisma.recurringExpenseTemplate.delete({ where: { id } });
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2003')) {
        throw new RecurringExpenseTemplateServiceError('template_has_active_instances');
      }
      throw error;
    }
  }

  return { listCatalog, findManyByIds, createTemplate, updateTemplate, deleteTemplate };
}

export type RecurringExpenseTemplateService = ReturnType<typeof createRecurringExpenseTemplateService>;
