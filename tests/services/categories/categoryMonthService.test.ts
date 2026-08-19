import { describe, expect, it } from '@jest/globals';
import { createBudgetMonthService } from '../../../src/services/budgetMonths/budgetMonthService.js';
import { createCategoryMonthService } from '../../../src/services/categories/categoryMonthService.js';
import { createCategoryService } from '../../../src/services/categories/categoryService.js';
import { createFakePrisma } from './testFakePrisma.js';

async function setup() {
  const prisma = createFakePrisma();
  const budgetMonthService = createBudgetMonthService({ prisma: prisma as never });
  const categoryService = createCategoryService({ prisma: prisma as never });
  const categoryMonthService = createCategoryMonthService({
    prisma: prisma as never,
    budgetMonthService,
  });

  const categoryA = await categoryService.createCategory('user-1', {
    name: 'Groceries',
    icon: 'cart',
    color: '#00FF00',
    budgetType: 'need',
    direction: 'expense',
  });
  const categoryB = await categoryService.createCategory('user-1', {
    name: 'Rent',
    icon: 'home',
    color: '#FF0000',
    budgetType: 'need',
    direction: 'expense',
  });
  const otherUsersCategory = await categoryService.createCategory('user-2', {
    name: 'Other User Category',
    icon: 'x',
    color: '#000000',
    budgetType: 'need',
    direction: 'expense',
  });

  return {
    prisma,
    budgetMonthService,
    categoryService,
    categoryMonthService,
    categoryA,
    categoryB,
    otherUsersCategory,
  };
}

describe('listByMonth', () => {
  it('returns category_month rows active in the given month, without creating a BudgetMonth for a month with none', async () => {
    const { prisma, categoryMonthService, categoryA, categoryB } = await setup();
    const inAugust = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      10000,
    );
    await categoryMonthService.addCategoryToMonth('user-1', categoryB.id, '2026-09', 5000);

    const result = await categoryMonthService.listByMonth('user-1', '2026-08');

    expect(result.map((cm) => cm.id)).toEqual([inAugust.id]);

    const empty = await categoryMonthService.listByMonth('user-1', '2030-01');
    expect(empty).toEqual([]);
    expect(prisma.budgetMonths.some((bm) => bm.month === '2030-01')).toBe(false);
  });

  it('rejects a malformed month string', async () => {
    const { categoryMonthService } = await setup();

    await expect(categoryMonthService.listByMonth('user-1', 'banana')).rejects.toMatchObject({
      reason: 'invalid_month',
    });
  });
});

describe('findManyByIds', () => {
  it('returns category_month rows matching the given ids', async () => {
    const { categoryMonthService, categoryA, categoryB } = await setup();
    const a = await categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 10000);
    const b = await categoryMonthService.addCategoryToMonth('user-1', categoryB.id, '2026-08', 20000);

    const result = await categoryMonthService.findManyByIds([a.id, b.id]);

    expect(result.map((cm) => cm.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('addCategoryToMonth', () => {
  it('creates a category_month row for the resolved month', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();

    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      10000,
    );

    expect(prisma.categoryMonths).toHaveLength(1);
    expect(categoryMonth).toMatchObject({
      userId: 'user-1',
      categoryId: categoryA.id,
      monthlyBudgetCents: 10000,
    });
    expect(prisma.budgetMonths).toHaveLength(1);
    expect(prisma.budgetMonths[0]!.month).toBe('2026-08');
  });

  it('throws category_not_found for a category belonging to another user, and creates no BudgetMonth row', async () => {
    const { prisma, categoryMonthService, otherUsersCategory } = await setup();

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', otherUsersCategory.id, '2026-08', 10000),
    ).rejects.toMatchObject({ reason: 'category_not_found' });

    // The ownership check must run before resolveBudgetMonthId's upsert —
    // BudgetMonth has no delete path, so a failed request must not leave
    // one behind.
    expect(prisma.budgetMonths).toHaveLength(0);
  });

  it('throws category_not_found for an unknown categoryId', async () => {
    const { categoryMonthService } = await setup();

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', 'does-not-exist', '2026-08', 10000),
    ).rejects.toMatchObject({ reason: 'category_not_found' });
  });

  it('throws category_not_found for a deleted category', async () => {
    const { categoryService, categoryMonthService, categoryA } = await setup();
    await categoryService.deleteCategory('user-1', categoryA.id);

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 10000),
    ).rejects.toMatchObject({ reason: 'category_not_found' });
  });

  it('rejects a malformed month string', async () => {
    const { categoryMonthService, categoryA } = await setup();

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026/08', 10000),
    ).rejects.toMatchObject({ reason: 'invalid_month' });
  });

  it('throws category_month_already_active for a duplicate (category, month) pair', async () => {
    const { categoryMonthService, categoryA } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 10000);

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 5000),
    ).rejects.toMatchObject({ reason: 'category_month_already_active' });
  });

  it('allows re-adding a category to a month after it was previously removed', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();
    const first = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      10000,
    );
    await categoryMonthService.removeCategoryFromMonth('user-1', first.id);

    const second = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      8000,
    );

    expect(second.id).not.toBe(first.id);
    expect(prisma.categoryMonths).toHaveLength(1);
  });

  it('throws month_locked when the target month is already locked', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();
    prisma.budgetMonths.push({
      id: 'bm-1',
      userId: 'user-1',
      month: '2026-07',
      locked: true,
      lockedAt: new Date(),
      createdAt: new Date(),
    });

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-07', 10000),
    ).rejects.toMatchObject({ reason: 'month_locked' });
    expect(prisma.categoryMonths).toHaveLength(0);
  });

  it('throws invalid_budget for a negative monthlyBudgetCents', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', -100),
    ).rejects.toMatchObject({ reason: 'invalid_budget' });
    expect(prisma.categoryMonths).toHaveLength(0);
  });

  it('throws invalid_budget for a non-integer monthlyBudgetCents', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 100.5),
    ).rejects.toMatchObject({ reason: 'invalid_budget' });
    expect(prisma.categoryMonths).toHaveLength(0);
  });
});

describe('ensureActiveForCategory', () => {
  it('creates a new category_month when none exists, using the given budget', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();

    const result = await categoryMonthService.ensureActiveForCategory(
      'user-1',
      categoryA.id,
      '2026-08',
      50000,
    );

    expect(result.monthlyBudgetCents).toBe(50000);
    expect(prisma.categoryMonths).toHaveLength(1);
  });

  it('returns the existing category_month instead of erroring when already active, no budget needed', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();
    const first = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      50000,
    );

    const result = await categoryMonthService.ensureActiveForCategory('user-1', categoryA.id, '2026-08');

    expect(result.id).toBe(first.id);
    expect(prisma.categoryMonths).toHaveLength(1);
  });

  it('throws category_month_budget_required when creating fresh with no budget given', async () => {
    const { categoryMonthService, categoryA } = await setup();

    await expect(
      categoryMonthService.ensureActiveForCategory('user-1', categoryA.id, '2026-08'),
    ).rejects.toMatchObject({ reason: 'category_month_budget_required' });
  });

  it('throws category_not_found for a category belonging to another user', async () => {
    const { categoryMonthService, otherUsersCategory } = await setup();

    await expect(
      categoryMonthService.ensureActiveForCategory('user-1', otherUsersCategory.id, '2026-08', 50000),
    ).rejects.toMatchObject({ reason: 'category_not_found' });
  });

  it('throws month_locked when the target month is already locked', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();
    prisma.budgetMonths.push({
      id: 'bm-1',
      userId: 'user-1',
      month: '2026-07',
      locked: true,
      lockedAt: new Date(),
      createdAt: new Date(),
    });

    await expect(
      categoryMonthService.ensureActiveForCategory('user-1', categoryA.id, '2026-07', 50000),
    ).rejects.toMatchObject({ reason: 'month_locked' });
  });

  it('rejects a malformed month string', async () => {
    const { categoryMonthService, categoryA } = await setup();

    await expect(
      categoryMonthService.ensureActiveForCategory('user-1', categoryA.id, 'banana', 50000),
    ).rejects.toMatchObject({ reason: 'invalid_month' });
  });
});

describe('removeCategoryFromMonth', () => {
  it('hard-deletes the row when no transactions reference it', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      10000,
    );

    await categoryMonthService.removeCategoryFromMonth('user-1', categoryMonth.id);

    expect(prisma.categoryMonths).toHaveLength(0);
  });

  it('throws category_month_has_transactions when a transaction references it', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      10000,
    );
    prisma.transactions.push({
      id: 'tx-1',
      userId: 'user-1',
      categoryMonthId: categoryMonth.id,
      recurringExpenseInstanceId: null,
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

  it('throws category_month_has_transactions (not a raw FK error) when a transaction is created between the check and the delete', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      10000,
    );

    // Simulate the race: the "no referencing transaction" check reports
    // none (as if it ran a moment before the concurrent insert), but a
    // transaction lands in the table right after — the fake's delete()
    // enforces onDelete: Restrict just like the real DB, so this
    // exercises the same path a concurrent request would hit.
    prisma.transaction.findFirst = (async () => {
      prisma.transactions.push({
        id: 'tx-race',
        userId: 'user-1',
        categoryMonthId: categoryMonth.id,
        recurringExpenseInstanceId: null,
        amountCents: 500,
        date: new Date('2026-08-05'),
        merchant: null,
        note: null,
        direction: 'expense',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return null;
    }) as typeof prisma.transaction.findFirst;

    await expect(
      categoryMonthService.removeCategoryFromMonth('user-1', categoryMonth.id),
    ).rejects.toMatchObject({ reason: 'category_month_has_transactions' });
    expect(prisma.categoryMonths).toHaveLength(1);
  });

  it('throws month_locked when the month has since been locked', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      10000,
    );
    prisma.budgetMonths[0]!.locked = true;

    await expect(
      categoryMonthService.removeCategoryFromMonth('user-1', categoryMonth.id),
    ).rejects.toMatchObject({ reason: 'month_locked' });
    expect(prisma.categoryMonths).toHaveLength(1);
  });

  it("throws category_month_not_found for another user's row", async () => {
    const { categoryMonthService, categoryA } = await setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
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
    const { categoryMonthService, categoryA } = await setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
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
    const { prisma, categoryMonthService, categoryA } = await setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      10000,
    );
    prisma.budgetMonths[0]!.locked = true;

    await expect(
      categoryMonthService.updateCategoryMonthBudget('user-1', categoryMonth.id, 12000),
    ).rejects.toMatchObject({ reason: 'month_locked' });
  });

  it('throws invalid_budget for a negative monthlyBudgetCents', async () => {
    const { categoryMonthService, categoryA } = await setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      10000,
    );

    await expect(
      categoryMonthService.updateCategoryMonthBudget('user-1', categoryMonth.id, -1),
    ).rejects.toMatchObject({ reason: 'invalid_budget' });
  });

  it('throws invalid_budget for a non-integer monthlyBudgetCents', async () => {
    const { categoryMonthService, categoryA } = await setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      10000,
    );

    await expect(
      categoryMonthService.updateCategoryMonthBudget('user-1', categoryMonth.id, 12000.75),
    ).rejects.toMatchObject({ reason: 'invalid_budget' });
  });
});
