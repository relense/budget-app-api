import type { BudgetMonthService } from '../budgetMonths/budgetMonthService.js';
import { ensureActiveForCategoryOnClient } from '../categories/categoryMonthService.js';
import type { TransactionService } from '../categories/transactionService.js';
import {
  assertOwnedTemplate,
  assertValidTemplateInput,
  lockTemplateRow,
} from './recurringExpenseTemplateService.js';
import type { RecurringExpenseTemplateInput } from './recurringExpenseTemplateService.js';
import type { PrismaClient } from '../../lib/prisma.js';
import { hasPrismaErrorCode } from '../../lib/prismaErrors.js';

export type RecurringExpenseInstanceServiceErrorReason =
  | 'invalid_amount'
  | 'instance_not_found'
  | 'instance_already_active'
  | 'instance_has_transactions'
  | 'month_locked';

export class RecurringExpenseInstanceServiceError extends Error {
  constructor(public readonly reason: RecurringExpenseInstanceServiceErrorReason) {
    super(`RecurringExpenseInstance operation failed: ${reason}`);
    this.name = 'RecurringExpenseInstanceServiceError';
  }
}

export interface MarkRecurringPaidInput {
  amountCents: number;
  date: string;
  merchant?: string;
  note?: string;
}

export interface RecurringExpenseInstanceServiceDeps {
  prisma: Pick<
    PrismaClient,
    | 'category'
    | 'recurringExpenseTemplate'
    | 'recurringExpenseInstance'
    | 'transaction'
    | 'budgetMonth'
    | 'categoryMonth'
    | '$transaction'
    | '$queryRaw'
  >;
  budgetMonthService: Pick<BudgetMonthService, 'findBudgetMonthId'>;
  transactionService: Pick<TransactionService, 'create'>;
}

function assertValidAmount(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new RecurringExpenseInstanceServiceError('invalid_amount');
  }
}

export function createRecurringExpenseInstanceService({
  prisma,
  budgetMonthService,
  transactionService,
}: RecurringExpenseInstanceServiceDeps) {
  async function findOwnedInstance(userId: string, instanceId: string) {
    const instance = await prisma.recurringExpenseInstance.findUnique({ where: { id: instanceId } });
    if (!instance || instance.userId !== userId) {
      throw new RecurringExpenseInstanceServiceError('instance_not_found');
    }
    return instance;
  }

  async function assertMonthNotLocked(monthId: string): Promise<void> {
    const budgetMonth = await prisma.budgetMonth.findUnique({ where: { id: monthId } });
    if (budgetMonth?.locked) {
      throw new RecurringExpenseInstanceServiceError('month_locked');
    }
  }

  /**
   * First-time creation: makes the template, then adds it to `month`
   * (auto-activating the category if needed). Returns both records —
   * createRecurringExpenseTemplate's GraphQL return type is the template
   * itself, not the instance, per plan.md's schema sketch.
   *
   * assertValidTemplateInput (read-only) runs before the transaction opens,
   * catching invalid amountCents/dueDay/budgetType or an unowned category
   * before any write happens. Everything else — creating the template,
   * activating the category-month, creating the instance — runs inside one
   * real transaction: if activation fails (locked month, missing budget) or
   * the instance insert fails, the template creation rolls back with it, so
   * no orphaned template or category-month can be left behind by this call.
   */
  async function createTemplateForMonth(
    userId: string,
    input: RecurringExpenseTemplateInput,
    month: string,
    categoryMonthlyBudgetCents?: number,
  ) {
    await assertValidTemplateInput(prisma, userId, input);

    try {
      return await prisma.$transaction(async (tx) => {
        const template = await tx.recurringExpenseTemplate.create({
          data: {
            userId,
            name: input.name,
            amountCents: input.amountCents,
            categoryId: input.categoryId,
            budgetType: input.budgetType,
            dueDay: input.dueDay,
          },
        });
        const categoryMonth = await ensureActiveForCategoryOnClient(
          tx,
          userId,
          template.categoryId,
          month,
          categoryMonthlyBudgetCents,
        );
        const instance = await tx.recurringExpenseInstance.create({
          data: {
            userId,
            templateId: template.id,
            monthId: categoryMonth.monthId,
            amountCents: template.amountCents,
          },
        });
        return { template, instance };
      });
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2002')) {
        throw new RecurringExpenseInstanceServiceError('instance_already_active');
      }
      throw error;
    }
  }

  /**
   * Reuses an existing template, carrying it into `month` (auto-activating
   * the category if needed).
   *
   * lockTemplateRow, then re-reading the template *inside* that lock, is
   * what actually closes the race with updateTemplate's categoryId-change
   * guard (which takes the identical lock before its own check-then-write):
   * an earlier version of this read the template's categoryId *before*
   * locking anything, which meant the category-activation decision could
   * already be based on a stale value by the time the lock was taken — the
   * lock has to cover the read that decides which category to activate,
   * not just the final insert.
   */
  async function addRecurringExpenseToMonth(
    userId: string,
    templateId: string,
    month: string,
    categoryMonthlyBudgetCents?: number,
  ) {
    // Cheap ownership check first, before opening a transaction for a
    // request that's going to fail regardless.
    await assertOwnedTemplate(prisma, userId, templateId);

    try {
      return await prisma.$transaction(async (tx) => {
        await lockTemplateRow(tx, templateId);
        const template = await assertOwnedTemplate(tx, userId, templateId);
        const categoryMonth = await ensureActiveForCategoryOnClient(
          tx,
          userId,
          template.categoryId,
          month,
          categoryMonthlyBudgetCents,
        );
        return tx.recurringExpenseInstance.create({
          data: {
            userId,
            templateId: template.id,
            monthId: categoryMonth.monthId,
            amountCents: template.amountCents,
          },
        });
      });
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2002')) {
        throw new RecurringExpenseInstanceServiceError('instance_already_active');
      }
      throw error;
    }
  }

  async function updateInstance(userId: string, instanceId: string, amountCents: number) {
    assertValidAmount(amountCents);
    const instance = await findOwnedInstance(userId, instanceId);
    await assertMonthNotLocked(instance.monthId);

    return prisma.recurringExpenseInstance.update({ where: { id: instanceId }, data: { amountCents } });
  }

  async function removeFromMonth(userId: string, instanceId: string): Promise<void> {
    const instance = await findOwnedInstance(userId, instanceId);
    await assertMonthNotLocked(instance.monthId);

    const referencingTransaction = await prisma.transaction.findFirst({
      where: { recurringExpenseInstanceId: instanceId },
    });
    if (referencingTransaction) {
      throw new RecurringExpenseInstanceServiceError('instance_has_transactions');
    }

    try {
      await prisma.recurringExpenseInstance.delete({ where: { id: instanceId } });
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2003')) {
        throw new RecurringExpenseInstanceServiceError('instance_has_transactions');
      }
      throw error;
    }
  }

  /** Records a payment against an instance. May be called more than once per instance (split payments). */
  async function markRecurringPaid(userId: string, instanceId: string, input: MarkRecurringPaidInput) {
    const instance = await findOwnedInstance(userId, instanceId);
    const template = await prisma.recurringExpenseTemplate.findUnique({ where: { id: instance.templateId } });
    if (!template) {
      throw new Error(`Data integrity error: RecurringExpenseTemplate ${instance.templateId} not found`);
    }
    const categoryMonth = await prisma.categoryMonth.findUnique({
      where: { categoryId_monthId: { categoryId: template.categoryId, monthId: instance.monthId } },
    });
    if (!categoryMonth) {
      throw new Error(
        `Data integrity error: CategoryMonth not found for category ${template.categoryId} month ${instance.monthId}`,
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
      instanceId,
    );
  }

  async function listByMonth(userId: string, month: string) {
    const monthId = await budgetMonthService.findBudgetMonthId(userId, month);
    if (!monthId) return [];
    return prisma.recurringExpenseInstance.findMany({ where: { userId, monthId } });
  }

  /** Batch lookup for DataLoader use — trusts the caller to have already scoped the ids to one user. */
  async function findManyByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return prisma.recurringExpenseInstance.findMany({ where: { id: { in: ids } } });
  }

  /**
   * Sum of amountCents across every instance whose template belongs to
   * categoryId, active in monthId. No userId parameter, unlike the
   * findManyByIds-style batch functions above — safe because categoryId can
   * only ever be one this user owns (assertOwnedCategory already ran when
   * the caller resolved it, e.g. via the categoryById DataLoader), so there's
   * no separate id list here that a caller could pass unscoped.
   */
  async function sumCommittedCentsForCategoryMonth(categoryId: string, monthId: string): Promise<number> {
    const templates = await prisma.recurringExpenseTemplate.findMany({ where: { categoryId } });
    if (templates.length === 0) return 0;

    // One query per template rather than a single `templateId: { in: [...] }`
    // filter — cardinality here is a handful of recurring expenses per
    // category, not worth extending the fake/Prisma query shape for.
    const instancesByTemplate = await Promise.all(
      templates.map((template) =>
        prisma.recurringExpenseInstance.findMany({ where: { templateId: template.id, monthId } }),
      ),
    );

    return instancesByTemplate.flat().reduce((sum, instance) => sum + instance.amountCents, 0);
  }

  return {
    createTemplateForMonth,
    addRecurringExpenseToMonth,
    updateInstance,
    removeFromMonth,
    markRecurringPaid,
    listByMonth,
    findManyByIds,
    sumCommittedCentsForCategoryMonth,
  };
}

export type RecurringExpenseInstanceService = ReturnType<typeof createRecurringExpenseInstanceService>;
