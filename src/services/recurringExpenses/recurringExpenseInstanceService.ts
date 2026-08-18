import type { BudgetMonthService } from '../budgetMonths/budgetMonthService.js';
import type { CategoryMonthService } from '../categories/categoryMonthService.js';
import type { TransactionService } from '../categories/transactionService.js';
import { assertOwnedTemplate, assertValidTemplateInput } from './recurringExpenseTemplateService.js';
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
  >;
  budgetMonthService: Pick<BudgetMonthService, 'findBudgetMonthId'>;
  categoryMonthService: Pick<CategoryMonthService, 'ensureActiveForCategory'>;
  templateService: Pick<RecurringExpenseTemplateService, 'createTemplate'>;
  transactionService: Pick<TransactionService, 'create'>;
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

  async function createInstanceRow(userId: string, templateId: string, monthId: string, amountCents: number) {
    try {
      return await prisma.recurringExpenseInstance.create({
        data: { userId, templateId, monthId, amountCents },
      });
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2002')) {
        throw new RecurringExpenseInstanceServiceError('instance_already_active');
      }
      throw error;
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
    return createInstanceRow(userId, templateId, categoryMonth.monthId, templateAmountCents);
  }

  /**
   * First-time creation: makes the template, then adds it to `month`
   * (auto-activating the category if needed). Returns both records —
   * createRecurringExpenseTemplate's GraphQL return type is the template
   * itself, not the instance, per plan.md's schema sketch.
   *
   * Ordering matters here, in two steps:
   *  1. Validate the template's own input (assertValidTemplateInput — a
   *     read-only check, writes nothing) *before* any write happens at all.
   *     Catches invalid amountCents/dueDay/budgetType or an unowned category
   *     up front, so none of them can leave a write behind.
   *  2. Only then call ensureActiveForCategory (which, on first activation,
   *     genuinely persists a CategoryMonth) *before* creating the template
   *     row — so a locked target month or a missing
   *     categoryMonthlyBudgetCents fails before the template is committed,
   *     rather than after.
   * Residual risk: templateService.createTemplate could still fail for a
   * non-deterministic reason (e.g. a dropped connection) after
   * ensureActiveForCategory has already committed a new CategoryMonth —
   * these two writes aren't in one transaction (they're issued by
   * separately-constructed services, each bound to its own prisma client).
   * Accepted for now: every deterministic/reachable-from-bad-input failure
   * mode is closed by step 1; this narrows the remaining window to a true
   * infra failure, not something a client can trigger with input alone.
   */
  async function createTemplateForMonth(
    userId: string,
    input: RecurringExpenseTemplateInput,
    month: string,
    categoryMonthlyBudgetCents?: number,
  ) {
    await assertValidTemplateInput(prisma, userId, input);
    const categoryMonth = await categoryMonthService.ensureActiveForCategory(
      userId,
      input.categoryId,
      month,
      categoryMonthlyBudgetCents,
    );
    const template = await templateService.createTemplate(userId, input);
    const instance = await createInstanceRow(userId, template.id, categoryMonth.monthId, template.amountCents);
    return { template, instance };
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
    markRecurringPaid,
    listByMonth,
    findManyByIds,
    sumCommittedCentsForCategoryMonth,
  };
}

export type RecurringExpenseInstanceService = ReturnType<typeof createRecurringExpenseInstanceService>;
