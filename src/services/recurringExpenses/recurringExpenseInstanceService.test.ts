import { describe, expect, it } from '@jest/globals';
import { createBudgetMonthService } from '../budgetMonths/budgetMonthService.js';
import { createCategoryMonthService } from '../categories/categoryMonthService.js';
import { createCategoryService } from '../categories/categoryService.js';
import { createTransactionService } from '../categories/transactionService.js';
import { createRecurringExpenseInstanceService } from './recurringExpenseInstanceService.js';
import { createRecurringExpenseTemplateService } from './recurringExpenseTemplateService.js';
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
    categoryMonthService,
    templateService,
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

    const instance = await instanceService.createTemplateForMonth(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );

    expect(prisma.recurringExpenseTemplates).toHaveLength(1);
    expect(prisma.categoryMonths).toHaveLength(1);
    expect(prisma.categoryMonths[0]!.monthlyBudgetCents).toBe(90000);
    expect(instance.amountCents).toBe(80000);
    expect(instance.templateId).toBe(prisma.recurringExpenseTemplates[0]!.id);
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

  it('throws category_month_budget_required when the category is not yet active and no budget is given', async () => {
    const { instanceService, housing } = await setup();

    await expect(
      instanceService.createTemplateForMonth(
        'user-1',
        { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
        '2026-08',
      ),
    ).rejects.toMatchObject({ reason: 'category_month_budget_required' });
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

  it('rejects a non-positive amountCents', async () => {
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

    await expect(instanceService.updateInstance('user-1', instance.id, 0)).rejects.toMatchObject({
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
});
