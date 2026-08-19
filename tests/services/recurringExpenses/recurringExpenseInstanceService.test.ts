import { describe, expect, it } from '@jest/globals';
import { createBudgetMonthService } from '../../../src/services/budgetMonths/budgetMonthService.js';
import { createCategoryMonthService } from '../../../src/services/categories/categoryMonthService.js';
import { createCategoryService } from '../../../src/services/categories/categoryService.js';
import { createTransactionService } from '../../../src/services/categories/transactionService.js';
import { createRecurringExpenseInstanceService } from '../../../src/services/recurringExpenses/recurringExpenseInstanceService.js';
import { createRecurringExpenseTemplateService } from '../../../src/services/recurringExpenses/recurringExpenseTemplateService.js';
import { createFakePrisma } from '../categories/testFakePrisma.js';

async function setup() {
  const prisma = createFakePrisma();
  const budgetMonthService = createBudgetMonthService({ prisma: prisma as never });
  const categoryService = createCategoryService({ prisma: prisma as never });
  const categoryMonthService = createCategoryMonthService({
    prisma: prisma as never,
    budgetMonthService,
  });
  const templateService = createRecurringExpenseTemplateService({ prisma: prisma as never });
  const transactionService = createTransactionService({ prisma: prisma as never, budgetMonthService });
  const instanceService = createRecurringExpenseInstanceService({
    prisma: prisma as never,
    budgetMonthService,
    transactionService,
  });

  const housing = await categoryService.createCategory('user-1', {
    name: 'Housing',
    icon: 'home',
    color: '#000',
    budgetType: 'need',
    direction: 'expense',
  });
  const otherUsersCategory = await categoryService.createCategory('user-2', {
    name: 'Other',
    icon: 'x',
    color: '#000',
    budgetType: 'need',
    direction: 'expense',
  });

  return {
    prisma,
    budgetMonthService,
    categoryService,
    categoryMonthService,
    templateService,
    instanceService,
    housing,
    otherUsersCategory,
  };
}

describe('createTemplateForMonth', () => {
  it('creates the template, activates the category for the month, and creates the instance', async () => {
    const { prisma, instanceService, housing } = await setup();

    const { template, instance } = await instanceService.createTemplateForMonth(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );

    expect(prisma.recurringExpenseTemplates).toHaveLength(1);
    expect(prisma.categoryMonths).toHaveLength(1);
    expect(prisma.categoryMonths[0]!.monthlyBudgetCents).toBe(90000);
    expect(template.id).toBe(prisma.recurringExpenseTemplates[0]!.id);
    expect(instance.amountCents).toBe(80000);
    expect(instance.templateId).toBe(template.id);
  });

  it('reuses an already-active category_month without requiring a budget', async () => {
    const { prisma, categoryMonthService, instanceService, housing } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);

    await instanceService.createTemplateForMonth(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
    );

    expect(prisma.categoryMonths).toHaveLength(1);
    expect(prisma.categoryMonths[0]!.monthlyBudgetCents).toBe(90000);
  });

  it('throws category_month_budget_required when the category is not yet active and no budget is given, without creating an orphaned template', async () => {
    const { prisma, instanceService, housing } = await setup();

    await expect(
      instanceService.createTemplateForMonth(
        'user-1',
        { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
        '2026-08',
      ),
    ).rejects.toMatchObject({ reason: 'category_month_budget_required' });
    expect(prisma.recurringExpenseTemplates).toHaveLength(0);
  });

  it('throws month_locked without creating an orphaned template', async () => {
    const { prisma, budgetMonthService, instanceService, housing } = await setup();
    const monthId = await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');
    const budgetMonth = prisma.budgetMonths.find((bm) => bm.id === monthId);
    budgetMonth!.locked = true;

    await expect(
      instanceService.createTemplateForMonth(
        'user-1',
        { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
        '2026-08',
        90000,
      ),
    ).rejects.toMatchObject({ reason: 'month_locked' });
    expect(prisma.recurringExpenseTemplates).toHaveLength(0);
  });

  it('throws invalid_amount without creating a CategoryMonth (validates the template input before auto-activating the category)', async () => {
    const { prisma, instanceService, housing } = await setup();

    await expect(
      instanceService.createTemplateForMonth(
        'user-1',
        { name: 'Rent', amountCents: -1, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
        '2026-08',
        90000,
      ),
    ).rejects.toMatchObject({ reason: 'invalid_amount' });
    expect(prisma.recurringExpenseTemplates).toHaveLength(0);
    expect(prisma.categoryMonths).toHaveLength(0);
  });

  it('throws invalid_due_day without creating a CategoryMonth', async () => {
    const { prisma, instanceService, housing } = await setup();

    await expect(
      instanceService.createTemplateForMonth(
        'user-1',
        { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 32 },
        '2026-08',
        90000,
      ),
    ).rejects.toMatchObject({ reason: 'invalid_due_day' });
    expect(prisma.categoryMonths).toHaveLength(0);
  });

  it('throws invalid_budget_type without creating a CategoryMonth', async () => {
    const { prisma, instanceService, housing } = await setup();

    await expect(
      instanceService.createTemplateForMonth(
        'user-1',
        { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'savings' as never, dueDay: 1 },
        '2026-08',
        90000,
      ),
    ).rejects.toMatchObject({ reason: 'invalid_budget_type' });
    expect(prisma.categoryMonths).toHaveLength(0);
  });

  it('throws category_not_found for a category belonging to another user', async () => {
    const { instanceService, otherUsersCategory } = await setup();

    await expect(
      instanceService.createTemplateForMonth(
        'user-1',
        { name: 'Rent', amountCents: 80000, categoryId: otherUsersCategory.id, budgetType: 'need', dueDay: 1 },
        '2026-08',
        90000,
      ),
    ).rejects.toMatchObject({ reason: 'category_not_found' });
  });
});

describe('addRecurringExpenseToMonth', () => {
  it('creates an instance for an existing template, snapshotting its amountCents', async () => {
    const { prisma, templateService, categoryMonthService, instanceService, housing } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);
    const template = await templateService.createTemplate('user-1', {
      name: 'Electricity',
      amountCents: 6000,
      categoryId: housing.id,
      budgetType: 'want',
      dueDay: 10,
    });

    const instance = await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');

    expect(instance.amountCents).toBe(6000);
    expect(prisma.recurringExpenseInstances).toHaveLength(1);
  });

  it('locks the template row before re-reading its category — canary against reordering the fix', async () => {
    // The fake can't prove real concurrency-safety (no true row locking),
    // but it can catch a *structural* regression: an earlier version of
    // this code read the template's category before taking the lock at
    // all, which is exactly the bug a real-Postgres concurrent test caught
    // (see PROGRESS.md). This asserts the call order stays lock-then-read.
    const { prisma, categoryMonthService, templateService, instanceService, housing } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);
    const template = await templateService.createTemplate('user-1', {
      name: 'Gas',
      amountCents: 4000,
      categoryId: housing.id,
      budgetType: 'want',
      dueDay: 15,
    });

    const order: string[] = [];
    const originalQueryRaw = prisma.$queryRaw.bind(prisma);
    prisma.$queryRaw = (async (...args: Parameters<typeof originalQueryRaw>) => {
      order.push('lock');
      return originalQueryRaw(...args);
    }) as typeof prisma.$queryRaw;
    const originalFindUnique = prisma.recurringExpenseTemplate.findUnique.bind(
      prisma.recurringExpenseTemplate,
    );
    prisma.recurringExpenseTemplate.findUnique = (async (args: Parameters<typeof originalFindUnique>[0]) => {
      order.push('read');
      return originalFindUnique(args);
    }) as typeof prisma.recurringExpenseTemplate.findUnique;

    await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');

    // read = outer ownership check (before opening the transaction), then
    // lock, then read = the fresh, post-lock re-read that decides which
    // category to activate, then a second lock = ensureActiveForCategoryOnClient's
    // own lockBudgetMonthRow before it checks the month isn't locked.
    expect(order).toEqual(['read', 'lock', 'read', 'lock']);
  });

  it('auto-activates the category for the month if not already active', async () => {
    const { prisma, templateService, instanceService, housing } = await setup();
    const template = await templateService.createTemplate('user-1', {
      name: 'Electricity',
      amountCents: 6000,
      categoryId: housing.id,
      budgetType: 'want',
      dueDay: 10,
    });

    await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08', 90000);

    expect(prisma.categoryMonths).toHaveLength(1);
  });

  it('throws instance_already_active for a duplicate (template, month) pair', async () => {
    const { templateService, categoryMonthService, instanceService, housing } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);
    const template = await templateService.createTemplate('user-1', {
      name: 'Electricity',
      amountCents: 6000,
      categoryId: housing.id,
      budgetType: 'want',
      dueDay: 10,
    });
    await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');

    await expect(
      instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08'),
    ).rejects.toMatchObject({ reason: 'instance_already_active' });
  });

  it("throws template_not_found for another user's template", async () => {
    const { templateService, categoryMonthService, instanceService, housing } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);
    const template = await templateService.createTemplate('user-1', {
      name: 'Electricity',
      amountCents: 6000,
      categoryId: housing.id,
      budgetType: 'want',
      dueDay: 10,
    });

    await expect(
      instanceService.addRecurringExpenseToMonth('user-2', template.id, '2026-08'),
    ).rejects.toMatchObject({ reason: 'template_not_found' });
  });
});

describe('updateInstance', () => {
  it('updates amountCents', async () => {
    const { templateService, categoryMonthService, instanceService, housing } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);
    const template = await templateService.createTemplate('user-1', {
      name: 'Gas',
      amountCents: 4000,
      categoryId: housing.id,
      budgetType: 'want',
      dueDay: 15,
    });
    const instance = await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');

    const updated = await instanceService.updateInstance('user-1', instance.id, 4500);

    expect(updated.amountCents).toBe(4500);
  });

  it('throws month_locked when the month is locked', async () => {
    const { prisma, templateService, categoryMonthService, instanceService, housing } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);
    const template = await templateService.createTemplate('user-1', {
      name: 'Gas',
      amountCents: 4000,
      categoryId: housing.id,
      budgetType: 'want',
      dueDay: 15,
    });
    const instance = await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');
    prisma.budgetMonths[0]!.locked = true;

    await expect(instanceService.updateInstance('user-1', instance.id, 4500)).rejects.toMatchObject({
      reason: 'month_locked',
    });
  });

  it.each([0, -100, 1.5])('rejects an invalid amountCents of %p', async (amountCents) => {
    const { templateService, categoryMonthService, instanceService, housing } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);
    const template = await templateService.createTemplate('user-1', {
      name: 'Gas',
      amountCents: 4000,
      categoryId: housing.id,
      budgetType: 'want',
      dueDay: 15,
    });
    const instance = await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');

    await expect(
      instanceService.updateInstance('user-1', instance.id, amountCents),
    ).rejects.toMatchObject({
      reason: 'invalid_amount',
    });
  });
});

describe('removeFromMonth', () => {
  it('hard-deletes the instance when no transactions reference it', async () => {
    const { prisma, templateService, categoryMonthService, instanceService, housing } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);
    const template = await templateService.createTemplate('user-1', {
      name: 'Gas',
      amountCents: 4000,
      categoryId: housing.id,
      budgetType: 'want',
      dueDay: 15,
    });
    const instance = await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');

    await instanceService.removeFromMonth('user-1', instance.id);

    expect(prisma.recurringExpenseInstances).toHaveLength(0);
  });

  it('throws instance_has_transactions when a transaction references it', async () => {
    const { prisma, templateService, categoryMonthService, instanceService, housing } = await setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      housing.id,
      '2026-08',
      90000,
    );
    const template = await templateService.createTemplate('user-1', {
      name: 'Gas',
      amountCents: 4000,
      categoryId: housing.id,
      budgetType: 'want',
      dueDay: 15,
    });
    const instance = await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');
    prisma.transactions.push({
      id: 'tx-1',
      userId: 'user-1',
      categoryMonthId: categoryMonth.id,
      recurringExpenseInstanceId: instance.id,
      amountCents: 4000,
      date: new Date('2026-08-15'),
      merchant: null,
      note: null,
      direction: 'expense',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(instanceService.removeFromMonth('user-1', instance.id)).rejects.toMatchObject({
      reason: 'instance_has_transactions',
    });
  });

  it('throws month_locked when the month is locked', async () => {
    const { prisma, templateService, categoryMonthService, instanceService, housing } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);
    const template = await templateService.createTemplate('user-1', {
      name: 'Gas',
      amountCents: 4000,
      categoryId: housing.id,
      budgetType: 'want',
      dueDay: 15,
    });
    const instance = await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');
    prisma.budgetMonths[0]!.locked = true;

    await expect(instanceService.removeFromMonth('user-1', instance.id)).rejects.toMatchObject({
      reason: 'month_locked',
    });
    expect(prisma.recurringExpenseInstances).toHaveLength(1);
  });
});

describe('listByMonth', () => {
  it('returns instances active in the given month, without creating a BudgetMonth for a month with none', async () => {
    const { prisma, templateService, categoryMonthService, instanceService, housing } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);
    const template = await templateService.createTemplate('user-1', {
      name: 'Gas',
      amountCents: 4000,
      categoryId: housing.id,
      budgetType: 'want',
      dueDay: 15,
    });
    const instance = await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');

    const result = await instanceService.listByMonth('user-1', '2026-08');

    expect(result.map((i) => i.id)).toEqual([instance.id]);

    const empty = await instanceService.listByMonth('user-1', '2030-01');
    expect(empty).toEqual([]);
    expect(prisma.budgetMonths.some((bm) => bm.month === '2030-01')).toBe(false);
  });

  it("excludes another user's instances active in the same month", async () => {
    const {
      categoryService,
      templateService,
      categoryMonthService,
      instanceService,
      housing,
    } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);
    const template = await templateService.createTemplate('user-1', {
      name: 'Gas',
      amountCents: 4000,
      categoryId: housing.id,
      budgetType: 'want',
      dueDay: 15,
    });
    const mine = await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');

    const theirCategory = await categoryService.createCategory('user-2', {
      name: 'Their housing',
      icon: 'home',
      color: '#000',
      budgetType: 'need',
      direction: 'expense',
    });
    await categoryMonthService.addCategoryToMonth('user-2', theirCategory.id, '2026-08', 90000);
    const theirTemplate = await templateService.createTemplate('user-2', {
      name: 'Their gas',
      amountCents: 3000,
      categoryId: theirCategory.id,
      budgetType: 'want',
      dueDay: 15,
    });
    await instanceService.addRecurringExpenseToMonth('user-2', theirTemplate.id, '2026-08');

    const result = await instanceService.listByMonth('user-1', '2026-08');

    expect(result.map((i) => i.id)).toEqual([mine.id]);
  });
});

describe('findManyByIds', () => {
  it('returns instances matching the given ids', async () => {
    const { templateService, categoryMonthService, instanceService, housing } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);
    const template = await templateService.createTemplate('user-1', {
      name: 'Gas',
      amountCents: 4000,
      categoryId: housing.id,
      budgetType: 'want',
      dueDay: 15,
    });
    const a = await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');
    const b = await instanceService.addRecurringExpenseToMonth(
      'user-1',
      template.id,
      '2026-09',
      90000,
    );

    const result = await instanceService.findManyByIds([a.id, b.id]);

    expect(result.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('returns an empty array for an empty id list', async () => {
    const { instanceService } = await setup();

    const result = await instanceService.findManyByIds([]);

    expect(result).toEqual([]);
  });
});

describe('sumCommittedCentsForCategoryMonth', () => {
  it('sums amountCents across every active instance under that category and month', async () => {
    const { categoryMonthService, templateService, instanceService, housing } = await setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      housing.id,
      '2026-08',
      90000,
    );
    const rent = await templateService.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: housing.id,
      budgetType: 'need',
      dueDay: 1,
    });
    const gas = await templateService.createTemplate('user-1', {
      name: 'Gas',
      amountCents: 4000,
      categoryId: housing.id,
      budgetType: 'want',
      dueDay: 15,
    });
    await instanceService.addRecurringExpenseToMonth('user-1', rent.id, '2026-08');
    await instanceService.addRecurringExpenseToMonth('user-1', gas.id, '2026-08');

    const sum = await instanceService.sumCommittedCentsForCategoryMonth(
      housing.id,
      categoryMonth.monthId,
    );

    expect(sum).toBe(84000);
  });

  it('returns 0 when no instances exist for that category and month', async () => {
    const { instanceService, housing } = await setup();

    const sum = await instanceService.sumCommittedCentsForCategoryMonth(housing.id, 'month-none');

    expect(sum).toBe(0);
  });
});

describe('markRecurringPaid', () => {
  it('creates a transaction linked to the instance, auto-resolving the categoryMonthId', async () => {
    const { prisma, categoryMonthService, templateService, instanceService, housing } = await setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      housing.id,
      '2026-08',
      90000,
    );
    const template = await templateService.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: housing.id,
      budgetType: 'need',
      dueDay: 1,
    });
    const instance = await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');

    const transaction = await instanceService.markRecurringPaid('user-1', instance.id, {
      amountCents: 80000,
      date: '2026-08-01',
      merchant: 'Landlord',
    });

    expect(transaction).toMatchObject({
      userId: 'user-1',
      categoryMonthId: categoryMonth.id,
      recurringExpenseInstanceId: instance.id,
      amountCents: 80000,
      merchant: 'Landlord',
      direction: 'expense',
    });
    expect(prisma.transactions).toHaveLength(1);
  });

  it('allows a second call against the same instance (split payments)', async () => {
    const { categoryMonthService, templateService, instanceService, housing } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);
    const template = await templateService.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: housing.id,
      budgetType: 'need',
      dueDay: 1,
    });
    const instance = await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');

    const first = await instanceService.markRecurringPaid('user-1', instance.id, {
      amountCents: 40000,
      date: '2026-08-01',
    });
    const second = await instanceService.markRecurringPaid('user-1', instance.id, {
      amountCents: 40000,
      date: '2026-08-15',
    });

    expect(first.id).not.toBe(second.id);
    expect(first.recurringExpenseInstanceId).toBe(instance.id);
    expect(second.recurringExpenseInstanceId).toBe(instance.id);
  });

  it('throws instance_not_found for another user\'s instance', async () => {
    const { categoryMonthService, templateService, instanceService, housing } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);
    const template = await templateService.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: housing.id,
      budgetType: 'need',
      dueDay: 1,
    });
    const instance = await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');

    await expect(
      instanceService.markRecurringPaid('user-2', instance.id, {
        amountCents: 80000,
        date: '2026-08-01',
      }),
    ).rejects.toMatchObject({ reason: 'instance_not_found' });
  });

  it('rejects when the month is locked', async () => {
    const { prisma, categoryMonthService, templateService, instanceService, housing } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);
    const template = await templateService.createTemplate('user-1', {
      name: 'Rent',
      amountCents: 80000,
      categoryId: housing.id,
      budgetType: 'need',
      dueDay: 1,
    });
    const instance = await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');
    prisma.budgetMonths[0]!.locked = true;

    await expect(
      instanceService.markRecurringPaid('user-1', instance.id, {
        amountCents: 80000,
        date: '2026-08-01',
      }),
    ).rejects.toMatchObject({ reason: 'month_locked' });
  });

  it.each([0, -100, 1.5])(
    'rejects an invalid amountCents of %p (delegated to transactionService.create)',
    async (amountCents) => {
      const { categoryMonthService, templateService, instanceService, housing } = await setup();
      await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);
      const template = await templateService.createTemplate('user-1', {
        name: 'Rent',
        amountCents: 80000,
        categoryId: housing.id,
        budgetType: 'need',
        dueDay: 1,
      });
      const instance = await instanceService.addRecurringExpenseToMonth('user-1', template.id, '2026-08');

      await expect(
        instanceService.markRecurringPaid('user-1', instance.id, {
          amountCents,
          date: '2026-08-01',
        }),
      ).rejects.toMatchObject({ reason: 'invalid_amount' });
    },
  );
});
