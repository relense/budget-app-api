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
    'category' | 'recurringExpenseTemplate' | 'recurringExpenseInstance' | '$transaction'
  >;
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

/** Public so recurringExpenseInstanceService can reuse the same ownership check. */
export async function assertOwnedTemplate(
  client: Pick<PrismaClient, 'recurringExpenseTemplate'>,
  userId: string,
  id: string,
) {
  const template = await client.recurringExpenseTemplate.findUnique({ where: { id } });
  if (!template || template.userId !== userId || template.deletedAt) {
    throw new RecurringExpenseTemplateServiceError('template_not_found');
  }
  return template;
}

export function createRecurringExpenseTemplateService({ prisma }: RecurringExpenseTemplateServiceDeps) {
  async function listCatalog(userId: string) {
    return prisma.recurringExpenseTemplate.findMany({ where: { userId, deletedAt: null } });
  }

  /** Batch lookup for DataLoader use — trusts the caller to have already scoped the ids to one user. */
  async function findManyByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return prisma.recurringExpenseTemplate.findMany({ where: { id: { in: ids } } });
  }

  async function createTemplate(userId: string, input: RecurringExpenseTemplateInput) {
    assertValidAmount(input.amountCents);
    assertValidDueDay(input.dueDay);
    assertValidBudgetType(input.budgetType);
    await assertOwnedCategory(prisma, userId, input.categoryId);

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

    // Instances don't snapshot their own categoryId — recurringCommittedCents
    // always looks it up via the template's *current* categoryId. Changing it
    // once an instance exists would retroactively move that instance's
    // amount out of one category's committed total and into another's for
    // months that have already happened (possibly already locked). Mirrors
    // updateCategory's direction_change_blocked guard.
    if (input.categoryId !== existing.categoryId) {
      const existingInstance = await prisma.recurringExpenseInstance.findFirst({
        where: { templateId: id },
      });
      if (existingInstance) {
        throw new RecurringExpenseTemplateServiceError('category_change_blocked');
      }
    }

    return prisma.recurringExpenseTemplate.update({
      where: { id },
      data: {
        name: input.name,
        amountCents: input.amountCents,
        categoryId: input.categoryId,
        budgetType: input.budgetType,
        dueDay: input.dueDay,
      },
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

    // Re-checked inside the transaction, right before the write: this is a
    // soft delete (no onDelete: Restrict FK to catch a concurrent instance
    // insert the way removeFromMonth's hard delete does), so without this
    // re-check a race could leave a soft-deleted template with a live
    // instance still pointing at it.
    await prisma.$transaction(async (tx) => {
      const raceInstance = await tx.recurringExpenseInstance.findFirst({ where: { templateId: id } });
      if (raceInstance) {
        throw new RecurringExpenseTemplateServiceError('template_has_active_instances');
      }
      await tx.recurringExpenseTemplate.update({ where: { id }, data: { deletedAt: new Date() } });
    });
  }

  return { listCatalog, findManyByIds, createTemplate, updateTemplate, deleteTemplate };
}

export type RecurringExpenseTemplateService = ReturnType<typeof createRecurringExpenseTemplateService>;
