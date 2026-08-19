import { describe, expect, it } from '@jest/globals';
import { createBudgetMonthService } from '../../../src/services/budgetMonths/budgetMonthService.js';
import { createCategoryMonthService } from '../../../src/services/categories/categoryMonthService.js';
import { createCategoryService } from '../../../src/services/categories/categoryService.js';
import { createTransactionService } from '../../../src/services/categories/transactionService.js';
import { createRecurringExpenseService } from '../../../src/services/recurringExpenses/recurringExpenseService.js';
import { createFakePrisma } from '../categories/testFakePrisma.js';

// Fixed rather than the real clock — several tests below activate
// categories/months in 2026-08/2026-09, and the one-month planning horizon
// is enforced relative to "today" — see recurringExpenseInstanceService's
// old test file for the same reasoning (git history).
async function setup(now: () => Date = () => new Date('2026-08-15T00:00:00.000Z')) {
  const prisma = createFakePrisma();
  const budgetMonthService = createBudgetMonthService({ prisma: prisma as never });
  const categoryService = createCategoryService({ prisma: prisma as never });
  const transactionService = createTransactionService({ prisma: prisma as never, budgetMonthService });
  const recurringExpenseService = createRecurringExpenseService({
    prisma: prisma as never,
    budgetMonthService,
    transactionService,
    now,
  });
  const categoryMonthService = createCategoryMonthService({
    prisma: prisma as never,
    budgetMonthService,
    now,
    onNewBudgetMonth: recurringExpenseService.seedNewMonth,
  });

  const housing = await categoryService.createCategory('user-1', {
    name: 'Housing',
    icon: 'home',
    color: '#000',
    budgetType: 'need',
    direction: 'expense',
  });
  const salary = await categoryService.createCategory('user-1', {
    name: 'Salary',
    icon: 'cash',
    color: '#000',
    budgetType: undefined,
    direction: 'income',
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
    recurringExpenseService,
    housing,
    salary,
    otherUsersCategory,
  };
}

describe('createRecurringExpense', () => {
  it('creates the row and activates the category for the month when given a budget', async () => {
    const { prisma, recurringExpenseService, housing } = await setup();

    const recurringExpense = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );

    expect(prisma.recurringExpenses).toHaveLength(1);
    expect(prisma.categoryMonths).toHaveLength(1);
    expect(prisma.categoryMonths[0]!.monthlyBudgetCents).toBe(90000);
    expect(recurringExpense.name).toBe('Rent');
    expect(recurringExpense.amountCents).toBe(80000);
    expect(recurringExpense.categoryId).toBe(housing.id);
  });

  it('reuses an already-active category_month without requiring a budget', async () => {
    const { prisma, categoryMonthService, recurringExpenseService, housing } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-08', 90000);

    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
    );

    expect(prisma.categoryMonths).toHaveLength(1);
  });

  it('throws category_month_budget_required when the category has never had a budget and none is given', async () => {
    const { recurringExpenseService, housing } = await setup();

    await expect(
      recurringExpenseService.createRecurringExpense(
        'user-1',
        { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
        '2026-08',
      ),
    ).rejects.toMatchObject({ reason: 'category_month_budget_required' });
  });

  it('rejects an invalid amount', async () => {
    const { recurringExpenseService, housing } = await setup();

    await expect(
      recurringExpenseService.createRecurringExpense(
        'user-1',
        { name: 'Rent', amountCents: 0, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
        '2026-08',
        90000,
      ),
    ).rejects.toMatchObject({ reason: 'invalid_amount' });
  });

  it('rejects an invalid due day', async () => {
    const { recurringExpenseService, housing } = await setup();

    await expect(
      recurringExpenseService.createRecurringExpense(
        'user-1',
        { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 32 },
        '2026-08',
        90000,
      ),
    ).rejects.toMatchObject({ reason: 'invalid_due_day' });
  });

  it('rejects budgetType SAVINGS — not meaningful for a recurring obligation', async () => {
    const { recurringExpenseService, housing } = await setup();

    await expect(
      recurringExpenseService.createRecurringExpense(
        'user-1',
        { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'savings', dueDay: 1 },
        '2026-08',
        90000,
      ),
    ).rejects.toMatchObject({ reason: 'invalid_budget_type' });
  });

  it('rejects an income category — direction would silently flip on markRecurringPaid otherwise', async () => {
    const { recurringExpenseService, salary } = await setup();

    await expect(
      recurringExpenseService.createRecurringExpense(
        'user-1',
        { name: 'Weird', amountCents: 80000, categoryId: salary.id, budgetType: 'need', dueDay: 1 },
        '2026-08',
        90000,
      ),
    ).rejects.toMatchObject({ reason: 'invalid_category_direction' });
  });

  it('rejects a category owned by another user', async () => {
    const { recurringExpenseService, otherUsersCategory } = await setup();

    await expect(
      recurringExpenseService.createRecurringExpense(
        'user-1',
        { name: 'Rent', amountCents: 80000, categoryId: otherUsersCategory.id, budgetType: 'need', dueDay: 1 },
        '2026-08',
        90000,
      ),
    ).rejects.toMatchObject({ reason: 'category_not_found' });
  });

  it('rejects a second recurring expense with the same name in the same month', async () => {
    const { recurringExpenseService, housing } = await setup();
    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );

    await expect(
      recurringExpenseService.createRecurringExpense(
        'user-1',
        { name: 'Rent', amountCents: 75000, categoryId: housing.id, budgetType: 'need', dueDay: 2 },
        '2026-08',
      ),
    ).rejects.toMatchObject({ reason: 'duplicate_name' });
  });

  it('allows the same name in two different months', async () => {
    const { prisma, recurringExpenseService, housing } = await setup();
    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );

    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-09',
    );

    // Explicit Aug row + explicit Sep row — the auto-seed-from-Aug attempt
    // for Sep hits the same name already just created there and is
    // silently skipped rather than erroring or duplicating.
    expect(prisma.recurringExpenses).toHaveLength(2);
  });
});

describe('carry-forward on first touch of a new month', () => {
  it('copies every recurring expense from the previous month when creating one triggers the new month', async () => {
    const { prisma, recurringExpenseService, housing } = await setup();
    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );
    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Electricity', amountCents: 6000, categoryId: housing.id, budgetType: 'need', dueDay: 10 },
      '2026-08',
    );

    // First touch of September — via a brand-new recurring expense, not
    // related to Rent/Electricity at all.
    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Netflix', amountCents: 1500, categoryId: housing.id, budgetType: 'want', dueDay: 5 },
      '2026-09',
    );

    const september = await recurringExpenseService.listByMonth('user-1', '2026-09');
    expect(september.map((re) => re.name).sort()).toEqual(['Electricity', 'Netflix', 'Rent']);
    expect(september.find((re) => re.name === 'Rent')?.amountCents).toBe(80000);
    // Copied September's category_month budget should inherit August's, not require re-input.
    expect(prisma.categoryMonths.filter((cm) => cm.categoryId === housing.id)).toHaveLength(2);

    // Aug: Rent + Electricity (2). Sep: Netflix (explicit) + Rent + Electricity (seeded) (3).
    expect(prisma.recurringExpenses).toHaveLength(5);
  });

  it('skips a name collision mid-seed but still seeds the remaining items (pr-reviewer coverage gap)', async () => {
    // Proves withSavepoint's per-item skip in seedNewMonth's loop actually
    // continues to the next item, not just that the overall call doesn't
    // throw — the other "allows the same name" test only had one item to
    // seed, so it couldn't distinguish "skipped and continued" from
    // "skipped and stopped".
    const { recurringExpenseService, housing } = await setup();
    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );
    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Electricity', amountCents: 6000, categoryId: housing.id, budgetType: 'need', dueDay: 10 },
      '2026-08',
    );
    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Gym', amountCents: 3000, categoryId: housing.id, budgetType: 'want', dueDay: 1 },
      '2026-08',
    );

    // First touch of September, explicitly naming it "Rent" too — collides
    // with the copied-forward Rent, but Electricity and Gym don't collide
    // with anything and should still get seeded.
    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 85000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-09',
    );

    const september = await recurringExpenseService.listByMonth('user-1', '2026-09');
    expect(september.map((re) => re.name).sort()).toEqual(['Electricity', 'Gym', 'Rent']);
    // The explicit create wins the name — its amount, not the copied one's.
    expect(september.find((re) => re.name === 'Rent')?.amountCents).toBe(85000);
  });

  it('does not carry forward when the target month already existed', async () => {
    const { recurringExpenseService, housing } = await setup();
    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );
    // Pre-touch September with something unrelated first.
    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Gym', amountCents: 3000, categoryId: housing.id, budgetType: 'want', dueDay: 1 },
      '2026-09',
    );
    // Rent got carried forward on that first touch — remove it to prove a
    // *second* action against the same (already-existing) month doesn't
    // try to carry forward again.
    const september = await recurringExpenseService.listByMonth('user-1', '2026-09');
    const rentInSeptember = september.find((re) => re.name === 'Rent')!;
    await recurringExpenseService.removeFromMonth('user-1', rentInSeptember.id);

    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Netflix', amountCents: 1500, categoryId: housing.id, budgetType: 'want', dueDay: 5 },
      '2026-09',
    );

    const finalSeptember = await recurringExpenseService.listByMonth('user-1', '2026-09');
    expect(finalSeptember.map((re) => re.name).sort()).toEqual(['Gym', 'Netflix']);
  });

  it('no-ops when the previous month has no budget month at all', async () => {
    const { recurringExpenseService, housing } = await setup();

    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Netflix', amountCents: 1500, categoryId: housing.id, budgetType: 'want', dueDay: 5 },
      '2026-08',
      90000,
    );

    const august = await recurringExpenseService.listByMonth('user-1', '2026-08');
    expect(august).toHaveLength(1);
  });

  it('carrying forward via categoryMonthService.addCategoryToMonth also seeds the new month', async () => {
    const { categoryMonthService, recurringExpenseService, housing } = await setup();
    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );

    // A category being added to September (nothing to do with Rent) is
    // still the first touch of that month — should carry Rent forward too.
    await categoryMonthService.addCategoryToMonth('user-1', housing.id, '2026-09');

    const september = await recurringExpenseService.listByMonth('user-1', '2026-09');
    expect(september.map((re) => re.name)).toEqual(['Rent']);
  });

  it('still returns the created row even if seedNewMonth throws partway through (pr-reviewer round 2 gap)', async () => {
    // createRecurringExpense's own doc comment says seeding "runs after
    // this transaction commits, not nested inside it" specifically so a
    // seeding failure can't undo the create the caller asked for — this
    // proves the try/catch around it actually holds, using a genuine
    // failure inside seedNewMonth's loop (assertOwnedCategory throwing on
    // a category that's gone missing) rather than a mock, since
    // seedNewMonth is an internal closure function, not independently
    // injectable.
    const { prisma, categoryService, recurringExpenseService, housing } = await setup();
    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );
    // A separate category for September's explicit create, so it doesn't
    // depend on `housing` (which is about to be sabotaged below) — this is
    // what proves only the *seed* step fails, not the explicit create too.
    const entertainment = await categoryService.createCategory('user-1', {
      name: 'Entertainment',
      icon: 'tv',
      color: '#0000FF',
      budgetType: 'want',
      direction: 'expense',
    });
    // Simulates `housing` having gone missing between August's activity and
    // September's first touch — assertOwnedCategory throws category_not_found
    // when seedNewMonth tries to re-activate it for the copied-forward Rent.
    prisma.categories.length = 0;
    prisma.categories.push(entertainment);

    const created = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Netflix', amountCents: 1500, categoryId: entertainment.id, budgetType: 'want', dueDay: 5 },
      '2026-09',
      2000,
    );

    expect(created.name).toBe('Netflix');
    const september = await recurringExpenseService.listByMonth('user-1', '2026-09');
    // Only the explicit create landed — the seed attempt for Rent failed
    // and was swallowed, not silently partially applied.
    expect(september.map((re) => re.name)).toEqual(['Netflix']);
  });
});

describe('updateRecurringExpense', () => {
  it('updates the row in place, scoped to just this month', async () => {
    const { recurringExpenseService, housing } = await setup();
    const created = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );

    const updated = await recurringExpenseService.updateRecurringExpense('user-1', created.id, {
      name: 'Rent',
      amountCents: 85000,
      categoryId: housing.id,
      budgetType: 'need',
      dueDay: 2,
    });

    expect(updated.amountCents).toBe(85000);
    expect(updated.dueDay).toBe(2);
  });

  it('throws recurring_expense_not_found for another user\'s row', async () => {
    const { recurringExpenseService, housing } = await setup();
    const created = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );

    await expect(
      recurringExpenseService.updateRecurringExpense('user-2', created.id, {
        name: 'Rent',
        amountCents: 85000,
        categoryId: housing.id,
        budgetType: 'need',
        dueDay: 1,
      }),
    ).rejects.toMatchObject({ reason: 'recurring_expense_not_found' });
  });

  it('throws duplicate_name when renaming to a name already used in the same month', async () => {
    const { recurringExpenseService, housing } = await setup();
    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );
    const electricity = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Electricity', amountCents: 6000, categoryId: housing.id, budgetType: 'need', dueDay: 10 },
      '2026-08',
    );

    await expect(
      recurringExpenseService.updateRecurringExpense('user-1', electricity.id, {
        name: 'Rent',
        amountCents: 6000,
        categoryId: housing.id,
        budgetType: 'need',
        dueDay: 10,
      }),
    ).rejects.toMatchObject({ reason: 'duplicate_name' });
  });

  it('throws month_locked once the month is locked', async () => {
    const { recurringExpenseService, budgetMonthService, housing } = await setup();
    const created = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );
    await budgetMonthService.lockMonth('user-1', '2026-08');

    await expect(
      recurringExpenseService.updateRecurringExpense('user-1', created.id, {
        name: 'Rent',
        amountCents: 85000,
        categoryId: housing.id,
        budgetType: 'need',
        dueDay: 1,
      }),
    ).rejects.toMatchObject({ reason: 'month_locked' });
  });

  it('reassigning categoryId auto-activates the new category for the same month, inheriting its budget', async () => {
    // test-auditor gap: every other test in this file updates without
    // changing categoryId, so ensureActiveForCategoryOnClient's call inside
    // updateRecurringExpense (recurringExpenseService.ts:297) had no
    // coverage at all for the case that actually exercises it.
    const { prisma, categoryService, categoryMonthService, recurringExpenseService, housing } = await setup();
    const transport = await categoryService.createCategory('user-1', {
      name: 'Transport',
      icon: 'car',
      color: '#0000FF',
      budgetType: 'want',
      direction: 'expense',
    });
    await categoryMonthService.addCategoryToMonth('user-1', transport.id, '2026-08', 20000);
    const created = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );

    const updated = await recurringExpenseService.updateRecurringExpense('user-1', created.id, {
      name: 'Rent',
      amountCents: 80000,
      categoryId: transport.id,
      budgetType: 'need',
      dueDay: 1,
    });

    expect(updated.categoryId).toBe(transport.id);
    // Transport was already active this month (budget 20000) — reassigning
    // to it must not require/derive a new budget, just reuse the existing
    // category_month.
    expect(prisma.categoryMonths.filter((cm) => cm.categoryId === transport.id)).toHaveLength(1);
  });

  it('reassigning to a category never budgeted anywhere throws category_month_budget_required', async () => {
    const { categoryService, recurringExpenseService, housing } = await setup();
    const neverBudgeted = await categoryService.createCategory('user-1', {
      name: 'Travel',
      icon: 'plane',
      color: '#0000FF',
      budgetType: 'want',
      direction: 'expense',
    });
    const created = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );

    await expect(
      recurringExpenseService.updateRecurringExpense('user-1', created.id, {
        name: 'Rent',
        amountCents: 80000,
        categoryId: neverBudgeted.id,
        budgetType: 'need',
        dueDay: 1,
      }),
    ).rejects.toMatchObject({ reason: 'category_month_budget_required' });
  });
});

describe('removeFromMonth', () => {
  it('deletes an unreferenced row', async () => {
    const { prisma, recurringExpenseService, housing } = await setup();
    const created = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );

    await recurringExpenseService.removeFromMonth('user-1', created.id);

    expect(prisma.recurringExpenses).toHaveLength(0);
  });

  it('throws recurring_expense_has_transactions while a transaction references it', async () => {
    const { recurringExpenseService, housing } = await setup();
    const created = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );
    await recurringExpenseService.markRecurringPaid('user-1', created.id, {
      amountCents: 80000,
      date: '2026-08-01',
    });

    await expect(recurringExpenseService.removeFromMonth('user-1', created.id)).rejects.toMatchObject({
      reason: 'recurring_expense_has_transactions',
    });
  });

  it('throws recurring_expense_not_found for another user\'s row', async () => {
    const { recurringExpenseService, housing } = await setup();
    const created = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );

    await expect(recurringExpenseService.removeFromMonth('user-2', created.id)).rejects.toMatchObject({
      reason: 'recurring_expense_not_found',
    });
  });

  it('throws recurring_expense_not_found for a nonexistent id', async () => {
    const { recurringExpenseService } = await setup();

    await expect(recurringExpenseService.removeFromMonth('user-1', 'missing')).rejects.toMatchObject({
      reason: 'recurring_expense_not_found',
    });
  });

  it('throws month_locked once the month is locked', async () => {
    const { recurringExpenseService, budgetMonthService, housing } = await setup();
    const created = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );
    await budgetMonthService.lockMonth('user-1', '2026-08');

    await expect(recurringExpenseService.removeFromMonth('user-1', created.id)).rejects.toMatchObject({
      reason: 'month_locked',
    });
  });

  it('throws recurring_expense_has_transactions (not a raw FK error) when a transaction is created between the check and the delete', async () => {
    const { prisma, recurringExpenseService, housing } = await setup();
    const created = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );
    const categoryMonth = prisma.categoryMonths.find((cm) => cm.categoryId === housing.id)!;

    // Simulate the race: the "no referencing transaction" check reports
    // none (as if it ran a moment before the concurrent insert), but a
    // transaction lands in the table right after — the fake's delete()
    // enforces onDelete: Restrict just like the real DB, same pattern as
    // categoryMonthService's identical race test.
    prisma.transaction.findFirst = (async () => {
      prisma.transactions.push({
        id: 'tx-race',
        userId: 'user-1',
        categoryMonthId: categoryMonth.id,
        recurringExpenseId: created.id,
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

    await expect(recurringExpenseService.removeFromMonth('user-1', created.id)).rejects.toMatchObject({
      reason: 'recurring_expense_has_transactions',
    });
  });
});

describe('markRecurringPaid', () => {
  it('creates a transaction linked via recurringExpenseId', async () => {
    const { recurringExpenseService, housing } = await setup();
    const created = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );

    const transaction = await recurringExpenseService.markRecurringPaid('user-1', created.id, {
      amountCents: 80000,
      date: '2026-08-01',
      merchant: 'Landlord',
    });

    expect(transaction.recurringExpenseId).toBe(created.id);
    expect(transaction.direction).toBe('expense');
  });

  it('can be called more than once for split payments', async () => {
    const { recurringExpenseService, housing } = await setup();
    const created = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );

    await recurringExpenseService.markRecurringPaid('user-1', created.id, {
      amountCents: 40000,
      date: '2026-08-01',
    });
    await recurringExpenseService.markRecurringPaid('user-1', created.id, {
      amountCents: 40000,
      date: '2026-08-15',
    });

    const transactions = await recurringExpenseService.listByMonth('user-1', '2026-08');
    expect(transactions).toHaveLength(1); // still one recurring expense row
  });

  it('throws recurring_expense_not_found for another user\'s row', async () => {
    const { recurringExpenseService, housing } = await setup();
    const created = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );

    await expect(
      recurringExpenseService.markRecurringPaid('user-2', created.id, {
        amountCents: 80000,
        date: '2026-08-01',
      }),
    ).rejects.toMatchObject({ reason: 'recurring_expense_not_found' });
  });

  it('throws recurring_expense_not_found for a nonexistent id', async () => {
    const { recurringExpenseService } = await setup();

    await expect(
      recurringExpenseService.markRecurringPaid('user-1', 'missing', {
        amountCents: 80000,
        date: '2026-08-01',
      }),
    ).rejects.toMatchObject({ reason: 'recurring_expense_not_found' });
  });

  it('throws a data-integrity Error if the recurring expense outlived its category_month', async () => {
    // Not reachable through normal service calls (a category_month can't be
    // removed while a recurring expense still references it — see
    // categoryMonthService's category_month_has_recurring_expenses check)
    // — this proves markRecurringPaid's own defensive check actually fires
    // if that invariant is ever violated by something else.
    const { prisma, recurringExpenseService, housing } = await setup();
    const created = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );
    prisma.categoryMonths.length = 0;

    await expect(
      recurringExpenseService.markRecurringPaid('user-1', created.id, {
        amountCents: 80000,
        date: '2026-08-01',
      }),
    ).rejects.toThrow(/Data integrity error: CategoryMonth not found/);
  });
});

describe('sumCommittedCentsForCategoryMonth', () => {
  it('sums amountCents across every recurring expense under the category for the month', async () => {
    const { prisma, recurringExpenseService, housing } = await setup();
    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );
    await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Electricity', amountCents: 6479, categoryId: housing.id, budgetType: 'need', dueDay: 10 },
      '2026-08',
    );
    const monthId = prisma.recurringExpenses[0]!.monthId;

    const sum = await recurringExpenseService.sumCommittedCentsForCategoryMonth(housing.id, monthId);

    expect(sum).toBe(86479);
  });

  it('returns 0 for a category/month with no recurring expenses', async () => {
    const { recurringExpenseService, housing } = await setup();

    const sum = await recurringExpenseService.sumCommittedCentsForCategoryMonth(housing.id, 'no-such-month');

    expect(sum).toBe(0);
  });
});

describe('findManyByIds', () => {
  it('batches multiple ids into a single lookup and returns the matching rows', async () => {
    const { recurringExpenseService, housing } = await setup();
    const rent = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: housing.id, budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );
    const electricity = await recurringExpenseService.createRecurringExpense(
      'user-1',
      { name: 'Electricity', amountCents: 6479, categoryId: housing.id, budgetType: 'need', dueDay: 10 },
      '2026-08',
    );

    const rows = await recurringExpenseService.findManyByIds([rent.id, electricity.id, 'missing']);

    expect(rows.map((row) => row.id).sort()).toEqual([electricity.id, rent.id].sort());
  });

  it('returns an empty array for an empty id list, without querying', async () => {
    const { recurringExpenseService } = await setup();

    expect(await recurringExpenseService.findManyByIds([])).toEqual([]);
  });
});
