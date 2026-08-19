import { describe, expect, it } from '@jest/globals';
import { createBudgetMonthService } from '../../../src/services/budgetMonths/budgetMonthService.js';
import { createCategoryMonthService } from '../../../src/services/categories/categoryMonthService.js';
import { createCategoryService } from '../../../src/services/categories/categoryService.js';
import { createFakePrisma } from './testFakePrisma.js';
import { createTransactionService } from '../../../src/services/categories/transactionService.js';

// Fixed rather than the real clock — setup() activates categories in
// 2026-08, and now that the one-month planning horizon is enforced
// server-side (relative to "today"), leaving this on the real clock would
// make every test in this file silently start failing once wall-clock time
// drifts past 2026-09, for reasons unrelated to any actual code change.
async function setup(now: () => Date = () => new Date('2026-08-15T00:00:00.000Z')) {
  const prisma = createFakePrisma();
  const budgetMonthService = createBudgetMonthService({ prisma: prisma as never });
  const categoryService = createCategoryService({ prisma: prisma as never });
  const categoryMonthService = createCategoryMonthService({
    prisma: prisma as never,
    budgetMonthService,
    now,
  });
  const transactionService = createTransactionService({
    prisma: prisma as never,
    budgetMonthService,
  });

  const expenseCategory = await categoryService.createCategory('user-1', {
    name: 'Groceries',
    icon: 'cart',
    color: '#00FF00',
    budgetType: 'need',
    direction: 'expense',
  });
  const incomeCategory = await categoryService.createCategory('user-1', {
    name: 'Salary',
    icon: 'wallet',
    color: '#0000FF',
    direction: 'income',
  });
  const expenseCategoryMonth = await categoryMonthService.addCategoryToMonth(
    'user-1',
    expenseCategory.id,
    '2026-08',
    50000,
  );
  const incomeCategoryMonth = await categoryMonthService.addCategoryToMonth(
    'user-1',
    incomeCategory.id,
    '2026-08',
    0,
  );

  return {
    prisma,
    budgetMonthService,
    categoryService,
    categoryMonthService,
    transactionService,
    expenseCategory,
    incomeCategory,
    expenseCategoryMonth,
    incomeCategoryMonth,
  };
}

describe('create', () => {
  it('creates a transaction, deriving direction from the category', async () => {
    const { transactionService, expenseCategoryMonth } = await setup();

    const transaction = await transactionService.create('user-1', {
      categoryMonthId: expenseCategoryMonth.id,
      amountCents: 2500,
      date: '2026-08-15',
      merchant: 'Store',
      note: 'weekly shop',
    });

    expect(transaction).toMatchObject({
      userId: 'user-1',
      categoryMonthId: expenseCategoryMonth.id,
      amountCents: 2500,
      merchant: 'Store',
      note: 'weekly shop',
      direction: 'expense',
    });
    expect(transaction.recurringExpenseInstanceId).toBeNull();
  });

  it('stamps recurringExpenseInstanceId when given (internal use — markRecurringPaid)', async () => {
    const { transactionService, expenseCategoryMonth } = await setup();

    const transaction = await transactionService.create(
      'user-1',
      { categoryMonthId: expenseCategoryMonth.id, amountCents: 2500, date: '2026-08-15' },
      'instance-1',
    );

    expect(transaction.recurringExpenseInstanceId).toBe('instance-1');
  });

  it('derives income direction from an income category', async () => {
    const { transactionService, incomeCategoryMonth } = await setup();

    const transaction = await transactionService.create('user-1', {
      categoryMonthId: incomeCategoryMonth.id,
      amountCents: 300000,
      date: '2026-08-01',
    });

    expect(transaction.direction).toBe('income');
  });

  it('rejects a non-positive amountCents', async () => {
    const { transactionService, expenseCategoryMonth } = await setup();

    await expect(
      transactionService.create('user-1', {
        categoryMonthId: expenseCategoryMonth.id,
        amountCents: 0,
        date: '2026-08-15',
      }),
    ).rejects.toMatchObject({ reason: 'invalid_amount' });
  });

  it('rejects a malformed date', async () => {
    const { transactionService, expenseCategoryMonth } = await setup();

    await expect(
      transactionService.create('user-1', {
        categoryMonthId: expenseCategoryMonth.id,
        amountCents: 100,
        date: '2026/08/15',
      }),
    ).rejects.toMatchObject({ reason: 'invalid_date' });
  });

  it('rejects a date whose month does not match the categoryMonth', async () => {
    const { transactionService, expenseCategoryMonth } = await setup();

    await expect(
      transactionService.create('user-1', {
        categoryMonthId: expenseCategoryMonth.id,
        amountCents: 100,
        date: '2026-09-01',
      }),
    ).rejects.toMatchObject({ reason: 'date_month_mismatch' });
  });

  it('rejects an unowned categoryMonthId', async () => {
    const { transactionService, expenseCategoryMonth } = await setup();

    await expect(
      transactionService.create('user-2', {
        categoryMonthId: expenseCategoryMonth.id,
        amountCents: 100,
        date: '2026-08-15',
      }),
    ).rejects.toMatchObject({ reason: 'category_month_not_found' });
  });

  it('rejects creating against a locked month', async () => {
    const { prisma, transactionService, expenseCategoryMonth } = await setup();
    prisma.budgetMonths[0]!.locked = true;

    await expect(
      transactionService.create('user-1', {
        categoryMonthId: expenseCategoryMonth.id,
        amountCents: 100,
        date: '2026-08-15',
      }),
    ).rejects.toMatchObject({ reason: 'month_locked' });
  });
});

describe('update', () => {
  it('updates fields and re-derives direction if the category changes', async () => {
    const { transactionService, expenseCategoryMonth, incomeCategoryMonth } = await setup();
    const transaction = await transactionService.create('user-1', {
      categoryMonthId: expenseCategoryMonth.id,
      amountCents: 2500,
      date: '2026-08-15',
    });

    const updated = await transactionService.update('user-1', transaction.id, {
      categoryMonthId: incomeCategoryMonth.id,
      amountCents: 2500,
      date: '2026-08-15',
    });

    expect(updated.categoryMonthId).toBe(incomeCategoryMonth.id);
    expect(updated.direction).toBe('income');
  });

  it('rejects updating a transaction that currently sits in a locked month', async () => {
    const { prisma, transactionService, expenseCategoryMonth } = await setup();
    const transaction = await transactionService.create('user-1', {
      categoryMonthId: expenseCategoryMonth.id,
      amountCents: 2500,
      date: '2026-08-15',
    });
    prisma.budgetMonths[0]!.locked = true;

    await expect(
      transactionService.update('user-1', transaction.id, {
        categoryMonthId: expenseCategoryMonth.id,
        amountCents: 3000,
        date: '2026-08-15',
      }),
    ).rejects.toMatchObject({ reason: 'month_locked' });
  });

  it('rejects a transaction_not_found for another user\'s transaction', async () => {
    const { transactionService, expenseCategoryMonth } = await setup();
    const transaction = await transactionService.create('user-1', {
      categoryMonthId: expenseCategoryMonth.id,
      amountCents: 2500,
      date: '2026-08-15',
    });

    await expect(
      transactionService.update('user-2', transaction.id, {
        categoryMonthId: expenseCategoryMonth.id,
        amountCents: 2500,
        date: '2026-08-15',
      }),
    ).rejects.toMatchObject({ reason: 'transaction_not_found' });
  });

  it("rejects moving a transaction to another user's categoryMonthId, without taking a lock on their budget_months row", async () => {
    const { prisma, transactionService, categoryMonthService, categoryService, expenseCategoryMonth } =
      await setup();
    const otherUsersCategory = await categoryService.createCategory('user-2', {
      name: 'Other',
      icon: 'x',
      color: '#000',
      budgetType: 'need',
      direction: 'expense',
    });
    const otherUsersCategoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-2',
      otherUsersCategory.id,
      '2026-08',
      10000,
    );
    const transaction = await transactionService.create('user-1', {
      categoryMonthId: expenseCategoryMonth.id,
      amountCents: 2500,
      date: '2026-08-15',
    });

    // Spies on $queryRaw (what lockBudgetMonthRow uses) to prove the fix
    // does more than "still rejects" — a test asserting only the reason
    // would pass identically whether or not the other user's row was
    // locked first, since loadCategoryMonthForWrite's ownership check
    // rejects regardless. This is the thing round 3 actually found.
    const lockedIds: string[] = [];
    const originalQueryRaw = prisma.$queryRaw.bind(prisma);
    prisma.$queryRaw = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      lockedIds.push(...(values as string[]));
      return originalQueryRaw(strings, ...values);
    }) as typeof prisma.$queryRaw;

    await expect(
      transactionService.update('user-1', transaction.id, {
        categoryMonthId: otherUsersCategoryMonth.id,
        amountCents: 2500,
        date: '2026-08-15',
      }),
    ).rejects.toMatchObject({ reason: 'category_month_not_found' });

    expect(lockedIds).not.toContain(otherUsersCategoryMonth.monthId);
  });

  it('moves a transaction to a categoryMonth in a different month', async () => {
    const { transactionService, categoryMonthService, expenseCategory, expenseCategoryMonth } =
      await setup();
    const septemberCategoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      expenseCategory.id,
      '2026-09',
      50000,
    );
    const transaction = await transactionService.create('user-1', {
      categoryMonthId: expenseCategoryMonth.id,
      amountCents: 2500,
      date: '2026-08-15',
    });

    const updated = await transactionService.update('user-1', transaction.id, {
      categoryMonthId: septemberCategoryMonth.id,
      amountCents: 2500,
      date: '2026-09-01',
    });

    expect(updated.categoryMonthId).toBe(septemberCategoryMonth.id);
  });

  it('locks the two involved budget_months rows in sorted order, not old-then-new', async () => {
    // Proves the canonical-ordering fix itself, not just its end-to-end
    // outcome: two concurrent updates swapping a transaction between the
    // same two months in opposite directions only avoid a Postgres
    // deadlock (40P01) if both always lock the pair in the same order,
    // regardless of which side is "the transaction's current month" and
    // which is "the target month" for that particular call. A regression
    // that dropped the `.sort()` in transactionService.ts's update() would
    // still pass every other test in this file (the end state is
    // identical either way) but would fail this one.
    //
    // Ids are deliberately hand-picked (not the service's randomUUID
    // output) so the "existing month sorts after target month" case is
    // guaranteed, not a coin flip depending on what two random UUIDs
    // happen to generate — insertion order (existing first, target
    // second) and sorted order are only actually distinguishable here
    // because "zzz-existing" > "aaa-target".
    const { prisma, transactionService, expenseCategory } = await setup();
    prisma.budgetMonths.push(
      { id: 'bm-zzz-existing', userId: 'user-1', month: '2026-08', locked: false, lockedAt: null, createdAt: new Date() },
      { id: 'bm-aaa-target', userId: 'user-1', month: '2026-09', locked: false, lockedAt: null, createdAt: new Date() },
    );
    prisma.categoryMonths.push(
      {
        id: 'cm-existing',
        userId: 'user-1',
        categoryId: expenseCategory.id,
        monthId: 'bm-zzz-existing',
        monthlyBudgetCents: 50000,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'cm-target',
        userId: 'user-1',
        categoryId: expenseCategory.id,
        monthId: 'bm-aaa-target',
        monthlyBudgetCents: 50000,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    );
    const transaction = await transactionService.create('user-1', {
      categoryMonthId: 'cm-existing',
      amountCents: 2500,
      date: '2026-08-15',
    });

    const lockedIds: string[] = [];
    const originalQueryRaw = prisma.$queryRaw.bind(prisma);
    prisma.$queryRaw = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      lockedIds.push(...(values as string[]));
      return originalQueryRaw(strings, ...values);
    }) as typeof prisma.$queryRaw;

    await transactionService.update('user-1', transaction.id, {
      categoryMonthId: 'cm-target',
      amountCents: 2500,
      date: '2026-09-01',
    });

    // The two rows get re-locked (harmlessly) by the checks that follow
    // the pre-lock loop — de-dupe to first appearance so this asserts the
    // pre-lock loop's own order, not just "both ids appear somewhere".
    const firstOccurrenceOrder = [
      ...new Set(lockedIds.filter((id) => id === 'bm-zzz-existing' || id === 'bm-aaa-target')),
    ];
    expect(firstOccurrenceOrder).toEqual(['bm-aaa-target', 'bm-zzz-existing']);
  });

  it('rejects moving a transaction into a different month that is locked, even though its current month is unlocked', async () => {
    // Exercises the two-distinct-lock path (current month + target month
    // are different budget_months rows) — this and the mirror case above
    // are the only tests that move a transaction across months at all.
    const { prisma, transactionService, categoryMonthService, expenseCategory, expenseCategoryMonth } =
      await setup();
    const septemberCategoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      expenseCategory.id,
      '2026-09',
      50000,
    );
    const septemberBudgetMonth = prisma.budgetMonths.find((bm) => bm.month === '2026-09')!;
    septemberBudgetMonth.locked = true;
    const transaction = await transactionService.create('user-1', {
      categoryMonthId: expenseCategoryMonth.id,
      amountCents: 2500,
      date: '2026-08-15',
    });

    await expect(
      transactionService.update('user-1', transaction.id, {
        categoryMonthId: septemberCategoryMonth.id,
        amountCents: 2500,
        date: '2026-09-01',
      }),
    ).rejects.toMatchObject({ reason: 'month_locked' });
  });
});

describe('deleteTransaction', () => {
  it('hard-deletes the transaction', async () => {
    const { prisma, transactionService, expenseCategoryMonth } = await setup();
    const transaction = await transactionService.create('user-1', {
      categoryMonthId: expenseCategoryMonth.id,
      amountCents: 2500,
      date: '2026-08-15',
    });

    await transactionService.deleteTransaction('user-1', transaction.id);

    expect(prisma.transactions).toHaveLength(0);
  });

  it('rejects deleting against a locked month', async () => {
    const { prisma, transactionService, expenseCategoryMonth } = await setup();
    const transaction = await transactionService.create('user-1', {
      categoryMonthId: expenseCategoryMonth.id,
      amountCents: 2500,
      date: '2026-08-15',
    });
    prisma.budgetMonths[0]!.locked = true;

    await expect(
      transactionService.deleteTransaction('user-1', transaction.id),
    ).rejects.toMatchObject({ reason: 'month_locked' });
    expect(prisma.transactions).toHaveLength(1);
  });
});

describe('listByCategoryMonthIds', () => {
  it('groups transactions by categoryMonthId for the given ids', async () => {
    const { transactionService, expenseCategoryMonth, incomeCategoryMonth } = await setup();
    const tx1 = await transactionService.create('user-1', {
      categoryMonthId: expenseCategoryMonth.id,
      amountCents: 100,
      date: '2026-08-05',
    });
    const tx2 = await transactionService.create('user-1', {
      categoryMonthId: incomeCategoryMonth.id,
      amountCents: 200,
      date: '2026-08-05',
    });

    const result = await transactionService.listByCategoryMonthIds([
      expenseCategoryMonth.id,
      incomeCategoryMonth.id,
    ]);

    expect(result.map((t) => t.id).sort()).toEqual([tx1.id, tx2.id].sort());
  });

  it('returns an empty array for an empty id list', async () => {
    const { transactionService } = await setup();

    const result = await transactionService.listByCategoryMonthIds([]);

    expect(result).toEqual([]);
  });
});

describe('listByRecurringExpenseInstanceIds', () => {
  it('groups transactions by recurringExpenseInstanceId for the given ids, ignoring unlinked transactions', async () => {
    const { transactionService, expenseCategoryMonth } = await setup();
    const linked = await transactionService.create(
      'user-1',
      { categoryMonthId: expenseCategoryMonth.id, amountCents: 100, date: '2026-08-05' },
      'instance-1',
    );
    await transactionService.create('user-1', {
      categoryMonthId: expenseCategoryMonth.id,
      amountCents: 200,
      date: '2026-08-05',
    });

    const result = await transactionService.listByRecurringExpenseInstanceIds(['instance-1']);

    expect(result.map((t) => t.id)).toEqual([linked.id]);
  });

  it('returns an empty array for an empty id list', async () => {
    const { transactionService } = await setup();

    const result = await transactionService.listByRecurringExpenseInstanceIds([]);

    expect(result).toEqual([]);
  });
});

describe('list', () => {
  it('rejects a malformed month string', async () => {
    const { transactionService } = await setup();

    await expect(transactionService.list('user-1', 'banana')).rejects.toMatchObject({
      reason: 'invalid_month',
    });
  });

  it('returns transactions for the month, ordered date DESC then createdAt DESC', async () => {
    const { transactionService, expenseCategoryMonth } = await setup();
    const first = await transactionService.create('user-1', {
      categoryMonthId: expenseCategoryMonth.id,
      amountCents: 100,
      date: '2026-08-05',
    });
    const second = await transactionService.create('user-1', {
      categoryMonthId: expenseCategoryMonth.id,
      amountCents: 200,
      date: '2026-08-20',
    });
    const third = await transactionService.create('user-1', {
      categoryMonthId: expenseCategoryMonth.id,
      amountCents: 300,
      date: '2026-08-20',
    });

    const result = await transactionService.list('user-1', '2026-08');

    expect(result.map((t) => t.id)).toEqual([third.id, second.id, first.id]);
  });

  it('filters by categoryId', async () => {
    const { transactionService, expenseCategoryMonth, incomeCategoryMonth, expenseCategory } =
      await setup();
    await transactionService.create('user-1', {
      categoryMonthId: expenseCategoryMonth.id,
      amountCents: 100,
      date: '2026-08-05',
    });
    await transactionService.create('user-1', {
      categoryMonthId: incomeCategoryMonth.id,
      amountCents: 100000,
      date: '2026-08-05',
    });

    const result = await transactionService.list('user-1', '2026-08', expenseCategory.id);

    expect(result).toHaveLength(1);
    expect(result[0]!.categoryMonthId).toBe(expenseCategoryMonth.id);
  });

  it('returns an empty list without creating a BudgetMonth row for a month with no data', async () => {
    const { prisma, transactionService } = await setup();

    const result = await transactionService.list('user-1', '2030-01');

    expect(result).toEqual([]);
    expect(prisma.budgetMonths.some((bm) => bm.month === '2030-01')).toBe(false);
  });
});
