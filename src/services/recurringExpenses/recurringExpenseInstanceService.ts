import type { BudgetMonthService } from '../budgetMonths/budgetMonthService.js';
import type { CategoryMonthService } from '../categories/categoryMonthService.js';
import { assertOwnedTemplate } from './recurringExpenseTemplateService.js';
import type {
  RecurringExpenseTemplateInput,
  RecurringExpenseTemplateService,
} from './recurringExpenseTemplateService.js';
import type { PrismaClient } from '../../lib/prisma.js';

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

export interface RecurringExpenseInstanceServiceDeps {
  prisma: Pick<
    PrismaClient,
    'recurringExpenseTemplate' | 'recurringExpenseInstance' | 'transaction' | 'budgetMonth'
  >;
  budgetMonthService: Pick<BudgetMonthService, 'findBudgetMonthId'>;
  categoryMonthService: Pick<CategoryMonthService, 'ensureActiveForCategory'>;
  templateService: Pick<RecurringExpenseTemplateService, 'createTemplate'>;
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
    throw new RecurringExpenseInstanceServiceError('invalid_amount');
  }
}

export function createRecurringExpenseInstanceService({
  prisma,
  budgetMonthService,
  categoryMonthService,
  templateService,
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

  async function createInstanceForTemplate(
    userId: string,
    templateId: string,
    categoryId: string,
    templateAmountCents: number,
    month: string,
    categoryMonthlyBudgetCents: number | undefined,
  ) {
    const categoryMonth = await categoryMonthService.ensureActiveForCategory(
      userId,
      categoryId,
      month,
      categoryMonthlyBudgetCents,
    );

    try {
      return await prisma.recurringExpenseInstance.create({
        data: {
          userId,
          templateId,
          monthId: categoryMonth.monthId,
          amountCents: templateAmountCents,
        },
      });
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2002')) {
        throw new RecurringExpenseInstanceServiceError('instance_already_active');
      }
      throw error;
    }
  }

  /** First-time creation: makes the template, then adds it to `month` (auto-activating the category if needed). */
  async function createTemplateForMonth(
    userId: string,
    input: RecurringExpenseTemplateInput,
    month: string,
    categoryMonthlyBudgetCents?: number,
  ) {
    const template = await templateService.createTemplate(userId, input);
    return createInstanceForTemplate(
      userId,
      template.id,
      template.categoryId,
      template.amountCents,
      month,
      categoryMonthlyBudgetCents,
    );
  }

  /** Reuses an existing template, carrying it into `month` (auto-activating the category if needed). */
  async function addRecurringExpenseToMonth(
    userId: string,
    templateId: string,
    month: string,
    categoryMonthlyBudgetCents?: number,
  ) {
    const template = await assertOwnedTemplate(prisma, userId, templateId);
    return createInstanceForTemplate(
      userId,
      template.id,
      template.categoryId,
      template.amountCents,
      month,
      categoryMonthlyBudgetCents,
    );
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

  /** Sum of amountCents across every instance whose template belongs to categoryId, active in monthId. */
  async function sumCommittedCentsForCategoryMonth(categoryId: string, monthId: string): Promise<number> {
    const templates = await prisma.recurringExpenseTemplate.findMany({
      where: { categoryId, deletedAt: null },
    });
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
    listByMonth,
    findManyByIds,
    sumCommittedCentsForCategoryMonth,
  };
}

export type RecurringExpenseInstanceService = ReturnType<typeof createRecurringExpenseInstanceService>;
