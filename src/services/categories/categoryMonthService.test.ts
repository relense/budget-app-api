import { describe, expect, it } from '@jest/globals';
import { createBudgetMonthService } from '../budgetMonths/budgetMonthService.js';
import { createCategoryMonthService } from './categoryMonthService.js';
import { createFakePrisma } from './testFakePrisma.js';

function setup() {
  const prisma = createFakePrisma();
  const budgetMonthService = createBudgetMonthService({ prisma: prisma as never });
  const categoryMonthService = createCategoryMonthService({
    prisma: prisma as never,
    budgetMonthService,
  });
  return { prisma, budgetMonthService, categoryMonthService };
}

describe('addCategoryToMonth', () => {
  it('creates a category_month row for the resolved month', async () => {
    const { prisma, categoryMonthService } = setup();

    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      'cat-1',
      '2026-08',
      10000,
    );

    expect(prisma.categoryMonths).toHaveLength(1);
    expect(categoryMonth).toMatchObject({
      userId: 'user-1',
      categoryId: 'cat-1',
      monthlyBudgetCents: 10000,
    });
    expect(prisma.budgetMonths).toHaveLength(1);
    expect(prisma.budgetMonths[0]!.month).toBe('2026-08');
  });

  it('throws category_month_already_active for a duplicate (category, month) pair', async () => {
    const { categoryMonthService } = setup();
    await categoryMonthService.addCategoryToMonth('user-1', 'cat-1', '2026-08', 10000);

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', 'cat-1', '2026-08', 5000),
    ).rejects.toMatchObject({ reason: 'category_month_already_active' });
  });

  it('allows re-adding a category to a month after it was previously removed', async () => {
    const { prisma, categoryMonthService } = setup();
    const first = await categoryMonthService.addCategoryToMonth('user-1', 'cat-1', '2026-08', 10000);
    await categoryMonthService.removeCategoryFromMonth('user-1', first.id);

    const second = await categoryMonthService.addCategoryToMonth('user-1', 'cat-1', '2026-08', 8000);

    expect(second.id).not.toBe(first.id);
    expect(prisma.categoryMonths).toHaveLength(1);
  });

  it('throws month_locked when the target month is already locked', async () => {
    const { prisma, categoryMonthService } = setup();
    prisma.budgetMonths.push({
      id: 'bm-1',
      userId: 'user-1',
      month: '2026-07',
      locked: true,
      lockedAt: new Date(),
      createdAt: new Date(),
    });

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', 'cat-1', '2026-07', 10000),
    ).rejects.toMatchObject({ reason: 'month_locked' });
    expect(prisma.categoryMonths).toHaveLength(0);
  });

  it('throws invalid_budget for a negative monthlyBudgetCents', async () => {
    const { prisma, categoryMonthService } = setup();

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', 'cat-1', '2026-08', -100),
    ).rejects.toMatchObject({ reason: 'invalid_budget' });
    expect(prisma.categoryMonths).toHaveLength(0);
  });
});

describe('removeCategoryFromMonth', () => {
  it('hard-deletes the row when no transactions reference it', async () => {
    const { prisma, categoryMonthService } = setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      'cat-1',
      '2026-08',
      10000,
    );

    await categoryMonthService.removeCategoryFromMonth('user-1', categoryMonth.id);

    expect(prisma.categoryMonths).toHaveLength(0);
  });

  it('throws category_month_has_transactions when a transaction references it', async () => {
    const { prisma, categoryMonthService } = setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      'cat-1',
      '2026-08',
      10000,
    );
    prisma.transactions.push({
      id: 'tx-1',
      userId: 'user-1',
      categoryMonthId: categoryMonth.id,
      amountCents: 500,
      date: new Date('2026-08-05'),
      merchant: null,
      note: null,
      direction: 'expense',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      categoryMonthService.removeCategoryFromMonth('user-1', categoryMonth.id),
    ).rejects.toMatchObject({ reason: 'category_month_has_transactions' });
    expect(prisma.categoryMonths).toHaveLength(1);
  });

  it('throws month_locked when the month has since been locked', async () => {
    const { prisma, categoryMonthService } = setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      'cat-1',
      '2026-08',
      10000,
    );
    prisma.budgetMonths[0]!.locked = true;

    await expect(
      categoryMonthService.removeCategoryFromMonth('user-1', categoryMonth.id),
    ).rejects.toMatchObject({ reason: 'month_locked' });
    expect(prisma.categoryMonths).toHaveLength(1);
  });

  it('throws category_month_not_found for another user\'s row', async () => {
    const { categoryMonthService } = setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      'cat-1',
      '2026-08',
      10000,
    );

    await expect(
      categoryMonthService.removeCategoryFromMonth('user-2', categoryMonth.id),
    ).rejects.toMatchObject({ reason: 'category_month_not_found' });
  });
});

describe('updateCategoryMonthBudget', () => {
  it('updates monthlyBudgetCents', async () => {
    const { categoryMonthService } = setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      'cat-1',
      '2026-08',
      10000,
    );

    const updated = await categoryMonthService.updateCategoryMonthBudget(
      'user-1',
      categoryMonth.id,
      12000,
    );

    expect(updated.monthlyBudgetCents).toBe(12000);
  });

  it('throws month_locked when the month is locked', async () => {
    const { prisma, categoryMonthService } = setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      'cat-1',
      '2026-08',
      10000,
    );
    prisma.budgetMonths[0]!.locked = true;

    await expect(
      categoryMonthService.updateCategoryMonthBudget('user-1', categoryMonth.id, 12000),
    ).rejects.toMatchObject({ reason: 'month_locked' });
  });

  it('throws invalid_budget for a negative monthlyBudgetCents', async () => {
    const { categoryMonthService } = setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      'cat-1',
      '2026-08',
      10000,
    );

    await expect(
      categoryMonthService.updateCategoryMonthBudget('user-1', categoryMonth.id, -1),
    ).rejects.toMatchObject({ reason: 'invalid_budget' });
  });
});
