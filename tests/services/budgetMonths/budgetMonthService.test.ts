import { describe, expect, it } from '@jest/globals';
import { createBudgetMonthService } from '../../../src/services/budgetMonths/budgetMonthService.js';
import { createFakePrisma } from '../categories/testFakePrisma.js';

function setup(now: () => Date = () => new Date('2026-08-15T00:00:00.000Z')) {
  const prisma = createFakePrisma();
  const budgetMonthService = createBudgetMonthService({ prisma: prisma as never, now });
  return { prisma, budgetMonthService, now };
}

describe('resolveBudgetMonthId', () => {
  it('creates a new BudgetMonth when none exists yet', async () => {
    const { prisma, budgetMonthService } = setup();

    const id = await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');

    expect(prisma.budgetMonths).toHaveLength(1);
    expect(prisma.budgetMonths[0]).toMatchObject({
      id,
      userId: 'user-1',
      month: '2026-08',
      locked: false,
    });
  });

  it('returns the existing id instead of creating a duplicate', async () => {
    const { prisma, budgetMonthService } = setup();

    const firstId = await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');
    const secondId = await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');

    expect(secondId).toBe(firstId);
    expect(prisma.budgetMonths).toHaveLength(1);
  });

  it('gives different users independent BudgetMonth rows for the same month string', async () => {
    const { prisma, budgetMonthService } = setup();

    const userOneId = await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');
    const userTwoId = await budgetMonthService.resolveBudgetMonthId('user-2', '2026-08');

    expect(userOneId).not.toBe(userTwoId);
    expect(prisma.budgetMonths).toHaveLength(2);
  });

  it('gives the same user independent BudgetMonth rows across years', async () => {
    const { prisma, budgetMonthService } = setup();

    const id2026 = await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');
    const id2027 = await budgetMonthService.resolveBudgetMonthId('user-1', '2027-08');

    expect(id2026).not.toBe(id2027);
    expect(prisma.budgetMonths).toHaveLength(2);
  });
});

describe('findManyByIds', () => {
  it('returns BudgetMonth rows matching the given ids', async () => {
    const { budgetMonthService } = setup();
    const augustId = await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');
    const septemberId = await budgetMonthService.resolveBudgetMonthId('user-1', '2026-09');

    const result = await budgetMonthService.findManyByIds([augustId, septemberId]);

    expect(result.map((bm) => bm.month).sort()).toEqual(['2026-08', '2026-09']);
  });

  it('returns an empty array for an empty id list', async () => {
    const { budgetMonthService } = setup();

    const result = await budgetMonthService.findManyByIds([]);

    expect(result).toEqual([]);
  });
});

describe('findBudgetMonthId', () => {
  it('returns null without creating a row when none exists (read-only, no side effect)', async () => {
    const { prisma, budgetMonthService } = setup();

    const id = await budgetMonthService.findBudgetMonthId('user-1', '2026-08');

    expect(id).toBeNull();
    expect(prisma.budgetMonths).toHaveLength(0);
  });

  it('returns the existing id when a BudgetMonth row exists', async () => {
    const { budgetMonthService } = setup();
    const created = await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');

    const found = await budgetMonthService.findBudgetMonthId('user-1', '2026-08');

    expect(found).toBe(created);
  });
});

describe('findCurrentMonth', () => {
  it("returns today's real calendar month, without creating a row, when the user has none at all", async () => {
    const { prisma, budgetMonthService } = setup(() => new Date('2026-08-15T00:00:00.000Z'));

    const result = await budgetMonthService.findCurrentMonth('user-1');

    expect(result).toEqual({ month: '2026-08', locked: false });
    expect(prisma.budgetMonths).toHaveLength(0);
  });

  it('returns the earliest unlocked BudgetMonth row, not just the earliest overall', async () => {
    const { prisma, budgetMonthService } = setup();
    const juneId = await budgetMonthService.resolveBudgetMonthId('user-1', '2026-06');
    await budgetMonthService.resolveBudgetMonthId('user-1', '2026-07');
    const june = prisma.budgetMonths.find((bm) => bm.id === juneId)!;
    june.locked = true;

    const result = await budgetMonthService.findCurrentMonth('user-1');

    expect(result).toEqual({ month: '2026-07', locked: false });
  });

  it('picks the earliest unlocked month by real calendar order, not row insertion order', async () => {
    const { budgetMonthService } = setup();
    // Deliberately created out of order — the earliest real month is
    // inserted last, so an insertion-order bug would pick the wrong one.
    await budgetMonthService.resolveBudgetMonthId('user-1', '2026-09');
    await budgetMonthService.resolveBudgetMonthId('user-1', '2026-07');
    await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');

    const result = await budgetMonthService.findCurrentMonth('user-1');

    expect(result.month).toBe('2026-07');
  });

  it("falls back to today's real month when every existing row is locked", async () => {
    const { prisma, budgetMonthService } = setup(() => new Date('2026-08-15T00:00:00.000Z'));
    const juneId = await budgetMonthService.resolveBudgetMonthId('user-1', '2026-06');
    prisma.budgetMonths.find((bm) => bm.id === juneId)!.locked = true;

    const result = await budgetMonthService.findCurrentMonth('user-1');

    expect(result).toEqual({ month: '2026-08', locked: false });
    expect(prisma.budgetMonths).toHaveLength(1);
  });

  it("does not let another user's rows affect this user's current month", async () => {
    const { budgetMonthService } = setup();
    await budgetMonthService.resolveBudgetMonthId('user-2', '2026-01');

    const result = await budgetMonthService.findCurrentMonth('user-1');

    expect(result).toEqual({ month: '2026-08', locked: false });
  });
});

describe('lockMonth', () => {
  it('locks the current month', async () => {
    const { prisma, budgetMonthService, now } = setup();
    await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');

    const locked = await budgetMonthService.lockMonth('user-1', '2026-08');

    expect(locked.locked).toBe(true);
    expect(locked.lockedAt).toEqual(now());
    expect(prisma.budgetMonths[0]!.locked).toBe(true);
  });

  it('throws budget_month_not_found for a month with no row', async () => {
    const { budgetMonthService } = setup();

    await expect(budgetMonthService.lockMonth('user-1', '2026-08')).rejects.toMatchObject({
      reason: 'budget_month_not_found',
    });
  });

  it("throws budget_month_not_found for another user's month", async () => {
    const { budgetMonthService } = setup();
    await budgetMonthService.resolveBudgetMonthId('user-2', '2026-08');

    await expect(budgetMonthService.lockMonth('user-1', '2026-08')).rejects.toMatchObject({
      reason: 'budget_month_not_found',
    });
  });

  it('throws budget_month_already_locked when the month is already locked', async () => {
    const { budgetMonthService } = setup();
    await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');
    await budgetMonthService.lockMonth('user-1', '2026-08');

    await expect(budgetMonthService.lockMonth('user-1', '2026-08')).rejects.toMatchObject({
      reason: 'budget_month_already_locked',
    });
  });

  it('throws budget_month_not_current when a month other than the earliest unlocked one is targeted', async () => {
    const { budgetMonthService } = setup();
    await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');
    await budgetMonthService.resolveBudgetMonthId('user-1', '2026-09');

    await expect(budgetMonthService.lockMonth('user-1', '2026-09')).rejects.toMatchObject({
      reason: 'budget_month_not_current',
    });
  });

  it('rejects a malformed month string', async () => {
    const { budgetMonthService } = setup();

    await expect(budgetMonthService.lockMonth('user-1', '2026/08')).rejects.toMatchObject({
      reason: 'invalid_month',
    });
  });
});

describe('deleteBudgetMonth', () => {
  it('hard-deletes an empty, unlocked month', async () => {
    const { prisma, budgetMonthService } = setup();
    await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');

    await budgetMonthService.deleteBudgetMonth('user-1', '2026-08');

    expect(prisma.budgetMonths).toHaveLength(0);
  });

  it('throws budget_month_not_found for a month with no row', async () => {
    const { budgetMonthService } = setup();

    await expect(budgetMonthService.deleteBudgetMonth('user-1', '2026-08')).rejects.toMatchObject({
      reason: 'budget_month_not_found',
    });
  });

  it("throws budget_month_not_found for another user's month", async () => {
    const { budgetMonthService } = setup();
    await budgetMonthService.resolveBudgetMonthId('user-2', '2026-08');

    await expect(budgetMonthService.deleteBudgetMonth('user-1', '2026-08')).rejects.toMatchObject({
      reason: 'budget_month_not_found',
    });
  });

  it('throws budget_month_locked when the month is already locked', async () => {
    const { budgetMonthService } = setup();
    await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');
    await budgetMonthService.lockMonth('user-1', '2026-08');

    await expect(budgetMonthService.deleteBudgetMonth('user-1', '2026-08')).rejects.toMatchObject({
      reason: 'budget_month_locked',
    });
  });

  it('throws budget_month_has_activations when a category_month row references it', async () => {
    const { prisma, budgetMonthService } = setup();
    const monthId = await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');
    prisma.categoryMonths.push({
      id: 'cm-1',
      userId: 'user-1',
      categoryId: 'cat-1',
      monthId,
      monthlyBudgetCents: 10000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(budgetMonthService.deleteBudgetMonth('user-1', '2026-08')).rejects.toMatchObject({
      reason: 'budget_month_has_activations',
    });
    expect(prisma.budgetMonths).toHaveLength(1);
  });

  it('throws budget_month_has_activations when a recurring_expenses row references it with no category_month present', async () => {
    // recurring_expenses.month_id has its own direct onDelete: Restrict FK
    // to budget_months — it doesn't go through category_month. This is now
    // hard to reach via removeCategoryFromMonth itself (it checks for a
    // referencing recurring_expenses row too), but the FK backstop is
    // defensive on purpose — proving deleteBudgetMonth's own P2003 catch
    // still closes the gap regardless of how a dangling row like this could
    // ever arise, not just for the one path that's blocked today.
    const { prisma, budgetMonthService } = setup();
    const monthId = await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');
    prisma.recurringExpenses.push({
      id: 'recurring-1',
      userId: 'user-1',
      monthId,
      categoryId: 'category-1',
      name: 'Rent',
      amountCents: 8000,
      budgetType: 'need',
      dueDay: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(budgetMonthService.deleteBudgetMonth('user-1', '2026-08')).rejects.toMatchObject({
      reason: 'budget_month_has_activations',
    });
    expect(prisma.budgetMonths).toHaveLength(1);
  });

  it('throws budget_month_has_activations (not a raw FK error) when a category_month is created between the check and the delete', async () => {
    const { prisma, budgetMonthService } = setup();
    const monthId = await budgetMonthService.resolveBudgetMonthId('user-1', '2026-08');

    // Simulate the race: the "no activations" check reports none (as if
    // it ran a moment before a concurrent insert), but a category_month
    // lands right after — the fake's delete() enforces onDelete: Restrict
    // just like the real DB, so this exercises the same path a concurrent
    // request would hit.
    prisma.categoryMonth.findFirst = (async () => {
      prisma.categoryMonths.push({
        id: 'cm-race',
        userId: 'user-1',
        categoryId: 'cat-1',
        monthId,
        monthlyBudgetCents: 10000,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return null;
    }) as typeof prisma.categoryMonth.findFirst;

    await expect(budgetMonthService.deleteBudgetMonth('user-1', '2026-08')).rejects.toMatchObject({
      reason: 'budget_month_has_activations',
    });
    expect(prisma.budgetMonths).toHaveLength(1);
  });

  it('rejects a malformed month string', async () => {
    const { budgetMonthService } = setup();

    await expect(budgetMonthService.deleteBudgetMonth('user-1', '2026/08')).rejects.toMatchObject({
      reason: 'invalid_month',
    });
  });
});
