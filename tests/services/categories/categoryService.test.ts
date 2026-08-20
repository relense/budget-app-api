import { describe, expect, it, jest } from '@jest/globals';
import { createCategoryService } from '../../../src/services/categories/categoryService.js';
import { createFakePrisma } from './testFakePrisma.js';

function setup() {
  const prisma = createFakePrisma();
  const categoryService = createCategoryService({ prisma: prisma as never });
  return { prisma, categoryService };
}

describe('createCategory', () => {
  it('creates an expense category with a budgetType', async () => {
    const { prisma, categoryService } = setup();

    const category = await categoryService.createCategory('user-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });

    expect(prisma.categories).toHaveLength(1);
    expect(category).toMatchObject({
      userId: 'user-1',
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });
  });

  it('creates an income category without a budgetType', async () => {
    const { categoryService } = setup();

    const category = await categoryService.createCategory('user-1', {
      name: 'Salary',
      icon: 'wallet',
      color: '#0000FF',
      direction: 'income',
    });

    expect(category.budgetType).toBeNull();
  });

  it('discards a client-supplied budgetType on an income category rather than storing it', async () => {
    const { categoryService } = setup();

    const category = await categoryService.createCategory('user-1', {
      name: 'Salary',
      icon: 'wallet',
      color: '#0000FF',
      budgetType: 'savings',
      direction: 'income',
    });

    expect(category.budgetType).toBeNull();
  });

  it('rejects an expense category with no budgetType', async () => {
    const { prisma, categoryService } = setup();

    await expect(
      categoryService.createCategory('user-1', {
        name: 'Rent',
        icon: 'home',
        color: '#FF0000',
        direction: 'expense',
      }),
    ).rejects.toMatchObject({ reason: 'budget_type_required_for_expense' });

    expect(prisma.categories).toHaveLength(0);
  });
});

describe('listCatalog', () => {
  it("excludes a deleted category and another user's categories", async () => {
    const { categoryService } = setup();
    const mine = await categoryService.createCategory('user-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });
    await categoryService.createCategory('user-2', {
      name: 'Rent',
      icon: 'home',
      color: '#FF0000',
      budgetType: 'need',
      direction: 'expense',
    });
    const deleted = await categoryService.createCategory('user-1', {
      name: 'Old',
      icon: 'x',
      color: '#000000',
      budgetType: 'need',
      direction: 'expense',
    });
    await categoryService.deleteCategory('user-1', deleted.id);

    const result = await categoryService.listCatalog('user-1');

    expect(result.map((c) => c.id)).toEqual([mine.id]);
  });
});

describe('findManyByIds', () => {
  it('returns categories matching the given ids', async () => {
    const { categoryService } = setup();
    const a = await categoryService.createCategory('user-1', {
      name: 'A',
      icon: 'a',
      color: '#111111',
      budgetType: 'need',
      direction: 'expense',
    });
    const b = await categoryService.createCategory('user-1', {
      name: 'B',
      icon: 'b',
      color: '#222222',
      budgetType: 'need',
      direction: 'expense',
    });
    await categoryService.createCategory('user-1', {
      name: 'C',
      icon: 'c',
      color: '#333333',
      budgetType: 'need',
      direction: 'expense',
    });

    const result = await categoryService.findManyByIds([a.id, b.id]);

    expect(result.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('updateCategory', () => {
  it('updates catalog fields', async () => {
    const { categoryService } = setup();
    const category = await categoryService.createCategory('user-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });

    const updated = await categoryService.updateCategory('user-1', category.id, {
      name: 'Food',
      icon: 'cart-2',
      color: '#00AA00',
      budgetType: 'want',
      direction: 'expense',
    });

    expect(updated).toMatchObject({ name: 'Food', icon: 'cart-2', color: '#00AA00', budgetType: 'want' });
  });

  it('throws category_not_found for another user\'s category', async () => {
    const { categoryService } = setup();
    const category = await categoryService.createCategory('user-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });

    await expect(
      categoryService.updateCategory('user-2', category.id, {
        name: 'Food',
        icon: 'cart',
        color: '#00FF00',
        budgetType: 'need',
        direction: 'expense',
      }),
    ).rejects.toMatchObject({ reason: 'category_not_found' });
  });

  it('allows a direction change when no transactions reference the category', async () => {
    const { categoryService } = setup();
    const category = await categoryService.createCategory('user-1', {
      name: 'Misc',
      icon: 'tag',
      color: '#FFFFFF',
      budgetType: 'need',
      direction: 'expense',
    });

    const updated = await categoryService.updateCategory('user-1', category.id, {
      name: 'Misc',
      icon: 'tag',
      color: '#FFFFFF',
      budgetType: 'savings',
      direction: 'income',
    });

    expect(updated.direction).toBe('income');
    expect(updated.budgetType).toBeNull();
  });

  it('blocks a direction change when a transaction references the category', async () => {
    const { prisma, categoryService } = setup();
    const category = await categoryService.createCategory('user-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });
    prisma.categoryMonths.push({
      id: 'cm-1',
      userId: 'user-1',
      categoryId: category.id,
      monthId: 'month-1',
      monthlyBudgetCents: 10000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.transactions.push({
      id: 'tx-1',
      userId: 'user-1',
      categoryMonthId: 'cm-1',
      recurringExpenseId: null,
      amountCents: 500,
      date: new Date('2026-08-01'),
      merchant: null,
      note: null,
      direction: 'expense',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      categoryService.updateCategory('user-1', category.id, {
        name: 'Groceries',
        icon: 'cart',
        color: '#00FF00',
        direction: 'income',
      }),
    ).rejects.toMatchObject({ reason: 'direction_change_blocked' });
  });

  it('blocks a direction change when a never-paid recurring expense references the category', async () => {
    // A brand-new recurring expense has zero Transactions yet, so the
    // transaction-based check above wouldn't have caught this on its own —
    // markRecurringPaid derives its Transaction's direction from the
    // category, so flipping it here would silently mislabel the next
    // payment as income.
    const { prisma, categoryService } = setup();
    const category = await categoryService.createCategory('user-1', {
      name: 'Housing',
      icon: 'home',
      color: '#000000',
      budgetType: 'need',
      direction: 'expense',
    });
    prisma.recurringExpenses.push({
      id: 're-1',
      userId: 'user-1',
      categoryId: category.id,
      monthId: 'month-1',
      name: 'Rent',
      amountCents: 80000,
      budgetType: 'need',
      dueDay: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      categoryService.updateCategory('user-1', category.id, {
        name: 'Housing',
        icon: 'home',
        color: '#000000',
        direction: 'income',
      }),
    ).rejects.toMatchObject({ reason: 'direction_change_blocked' });
  });

  it('allows non-direction edits even when the category has transactions', async () => {
    const { prisma, categoryService } = setup();
    const category = await categoryService.createCategory('user-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });
    prisma.categoryMonths.push({
      id: 'cm-1',
      userId: 'user-1',
      categoryId: category.id,
      monthId: 'month-1',
      monthlyBudgetCents: 10000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.transactions.push({
      id: 'tx-1',
      userId: 'user-1',
      categoryMonthId: 'cm-1',
      recurringExpenseId: null,
      amountCents: 500,
      date: new Date('2026-08-01'),
      merchant: null,
      note: null,
      direction: 'expense',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const updated = await categoryService.updateCategory('user-1', category.id, {
      name: 'Food',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'want',
      direction: 'expense',
    });

    expect(updated.name).toBe('Food');
  });
});

describe('deleteCategory', () => {
  it('hard-deletes a category with no category_month rows', async () => {
    const { prisma, categoryService } = setup();
    const category = await categoryService.createCategory('user-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });

    await categoryService.deleteCategory('user-1', category.id);

    expect(prisma.categories).toHaveLength(0);
  });

  it('throws category_has_active_months when a category_month row exists', async () => {
    const { prisma, categoryService } = setup();
    const category = await categoryService.createCategory('user-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });
    prisma.categoryMonths.push({
      id: 'cm-1',
      userId: 'user-1',
      categoryId: category.id,
      monthId: 'month-1',
      monthlyBudgetCents: 10000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(categoryService.deleteCategory('user-1', category.id)).rejects.toMatchObject({
      reason: 'category_has_active_months',
    });
    expect(prisma.categories).toHaveLength(1);
  });

  it('throws category_has_active_months (not a raw FK error) when a category_month is created between the check and the delete', async () => {
    const { prisma, categoryService } = setup();
    const category = await categoryService.createCategory('user-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });

    // Simulate the race: the "no active months" check reports none (as if
    // it ran a moment before the concurrent insert), but a category_month
    // lands right after — the fake's delete() enforces onDelete: Restrict
    // just like the real DB, so this exercises the same path a concurrent
    // request would hit.
    prisma.categoryMonth.findFirst = (async () => {
      prisma.categoryMonths.push({
        id: 'cm-race',
        userId: 'user-1',
        categoryId: category.id,
        monthId: 'month-race',
        monthlyBudgetCents: 10000,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return null;
    }) as typeof prisma.categoryMonth.findFirst;

    await expect(categoryService.deleteCategory('user-1', category.id)).rejects.toMatchObject({
      reason: 'category_has_active_months',
    });
    expect(prisma.categories).toHaveLength(1);
  });

  it('throws category_has_active_months when a recurring expense references the category, even with no category_month row', async () => {
    const { prisma, categoryService } = setup();
    const category = await categoryService.createCategory('user-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });
    // No category_month row for this category — the pre-check alone
    // wouldn't catch this. Reachable in practice: the category_month a
    // recurring expense activated can be removed later while the recurring
    // expense row itself is kept.
    prisma.recurringExpenses.push({
      id: 'recurring-1',
      userId: 'user-1',
      monthId: 'month-1',
      name: 'Rent',
      amountCents: 80000,
      categoryId: category.id,
      budgetType: 'need',
      dueDay: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(categoryService.deleteCategory('user-1', category.id)).rejects.toMatchObject({
      reason: 'category_has_active_months',
    });
    expect(prisma.categories).toHaveLength(1);
  });

  it('throws category_not_found for another user\'s category', async () => {
    const { categoryService } = setup();
    const category = await categoryService.createCategory('user-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });

    await expect(categoryService.deleteCategory('user-2', category.id)).rejects.toMatchObject({
      reason: 'category_not_found',
    });
  });
});

describe('row locking', () => {
  it('locks the category row (via $queryRaw ... FOR UPDATE) on updateCategory', async () => {
    const { prisma, categoryService } = setup();
    const category = await categoryService.createCategory('user-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });
    const queryRawSpy = jest.fn(prisma.$queryRaw);
    prisma.$queryRaw = queryRawSpy as typeof prisma.$queryRaw;

    await categoryService.updateCategory('user-1', category.id, {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });

    expect(queryRawSpy).toHaveBeenCalledTimes(1);
    const [strings, lockedId] = queryRawSpy.mock.calls[0] as [TemplateStringsArray, string];
    const sql = strings.join('');
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('categories');
    expect(lockedId).toBe(category.id);
  });
});
