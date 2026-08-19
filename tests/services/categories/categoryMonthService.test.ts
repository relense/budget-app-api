import { describe, expect, it } from '@jest/globals';
import { createBudgetMonthService } from '../../../src/services/budgetMonths/budgetMonthService.js';
import { createCategoryMonthService } from '../../../src/services/categories/categoryMonthService.js';
import { createCategoryService } from '../../../src/services/categories/categoryService.js';
import { createFakePrisma } from './testFakePrisma.js';

// Fixed rather than the real clock — several tests below activate
// categories across multiple months, and now that the one-month planning
// horizon is enforced server-side (relative to "today"), leaving this on
// the real clock would make those tests silently start failing once wall-
// clock time drifts far enough past this date, for reasons unrelated to
// any actual code change.
async function setup(now: () => Date = () => new Date('2026-08-15T00:00:00.000Z')) {
  const prisma = createFakePrisma();
  const budgetMonthService = createBudgetMonthService({ prisma: prisma as never });
  const categoryService = createCategoryService({ prisma: prisma as never });
  const categoryMonthService = createCategoryMonthService({
    prisma: prisma as never,
    budgetMonthService,
    now,
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
    // Locked at the current month (2026-08, under the fixed clock) rather
    // than a past one — a past month is now itself rejected by the
    // planning-horizon check before this ever reaches the lock check, so a
    // past month can no longer isolate what this test is actually after.
    prisma.budgetMonths.push({
      id: 'bm-1',
      userId: 'user-1',
      month: '2026-08',
      locked: true,
      lockedAt: new Date(),
      createdAt: new Date(),
    });

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 10000),
    ).rejects.toMatchObject({ reason: 'month_locked' });
    expect(prisma.categoryMonths).toHaveLength(0);
  });

  it('throws category_month_beyond_planning_horizon for a month more than one month past current', async () => {
    // now = 2026-08-15, no BudgetMonth rows yet, so current derives to
    // 2026-08 and the horizon is 2026-09 — 2026-10 is one month too far.
    const { prisma, categoryMonthService, categoryA } = await setup();

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-10', 10000),
    ).rejects.toMatchObject({ reason: 'category_month_beyond_planning_horizon' });
    expect(prisma.categoryMonths).toHaveLength(0);
  });

  it('throws category_month_beyond_planning_horizon for a month before current', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-07', 10000),
    ).rejects.toMatchObject({ reason: 'category_month_beyond_planning_horizon' });
    expect(prisma.categoryMonths).toHaveLength(0);
    // The rejected month must not have left a stray BudgetMonth row behind
    // — a past-month row surviving a rejection is exactly what would let
    // it hijack "current" (the earliest unlocked row) for a later call.
    expect(prisma.budgetMonths).toHaveLength(0);
  });

  it('cannot hijack "current" by first activating an arbitrary past month, then activating the real current month', async () => {
    // Regression for a bug pr-reviewer caught before merge: activating a
    // category in an untouched past month used to silently create an
    // unlocked BudgetMonth row there, which then became the "earliest
    // unlocked" row — dragging "current" itself backwards for every later
    // call by this user, non-concurrently, on plain sequential use.
    const { categoryMonthService, categoryA, categoryB } = await setup();

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2020-01', 5000),
    ).rejects.toMatchObject({ reason: 'category_month_beyond_planning_horizon' });

    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryB.id,
      '2026-08',
      5000,
    );

    expect(categoryMonth.monthlyBudgetCents).toBe(5000);
  });

  it('allows activating exactly at the horizon (current + 1)', async () => {
    const { categoryMonthService, categoryA } = await setup();

    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-09',
      10000,
    );

    expect(categoryMonth.monthlyBudgetCents).toBe(10000);
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

  it('throws category_month_budget_required when omitted and the category has never been active anywhere', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08'),
    ).rejects.toMatchObject({ reason: 'category_month_budget_required' });
    expect(prisma.categoryMonths).toHaveLength(0);
  });

  it('throws budget_month_not_found when the target BudgetMonth is deleted between the lock and the insert', async () => {
    // Simulates deleteBudgetMonth winning the race for a month with zero
    // category_month rows so far: the BudgetMonth row genuinely no longer
    // exists by the time assertMonthNotLockedOnClient reads it, even
    // though resolveBudgetMonthId just confirmed it existed moments
    // earlier. Without the explicit !budgetMonth check, this would
    // silently fall through (undefined?.locked is falsy) into a raw,
    // uncaught FK violation on the insert instead of a clean error.
    const { prisma, categoryMonthService, categoryA } = await setup();
    prisma.budgetMonth.findUnique = (async (args: { where: { id: string } }) => {
      const index = prisma.budgetMonths.findIndex((bm) => bm.id === args.where.id);
      if (index !== -1) prisma.budgetMonths.splice(index, 1);
      return null;
    }) as typeof prisma.budgetMonth.findUnique;

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 10000),
    ).rejects.toMatchObject({ reason: 'budget_month_not_found' });
    expect(prisma.categoryMonths).toHaveLength(0);
  });

  it("inherits the category's most recent monthlyBudgetCents when omitted", async () => {
    const { categoryMonthService, categoryA } = await setup();
    // Prior activation at the current month (2026-08), inheriting into the
    // horizon month right after it (2026-09) — a prior activation further
    // in the past is no longer reachable via a live call now that the
    // planning horizon also blocks past months (see the fixture-row
    // approach used by the "inherits by real calendar month" tests below
    // for cases that genuinely need multi-month-apart history).
    await categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 10000);

    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-09',
    );

    expect(categoryMonth.monthlyBudgetCents).toBe(10000);
  });

  it('uses the given budget rather than inheriting when a prior activation exists but a budget is still passed', async () => {
    const { categoryMonthService, categoryA } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 10000);

    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-09',
      5000,
    );

    expect(categoryMonth.monthlyBudgetCents).toBe(5000);
  });

  it('inherits by real calendar month, not insertion order, when multiple prior activations exist', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();
    // Historical (already-locked) activations, so they don't count as
    // "current" under the planning-horizon check below — pushed directly
    // rather than via addCategoryToMonth, since a real user could only
    // ever reach this history by locking each month in turn, which would
    // make it impossible to construct one out of chronological order the
    // way this test deliberately does. Real-latest month (2026-07)
    // inserted neither first nor last — rules out "first created wins"
    // and "last created wins" as well as the actual bug that shipped
    // ("most recently created wins"), not just the one.
    prisma.budgetMonths.push(
      { id: 'bm-05', userId: 'user-1', month: '2026-05', locked: true, lockedAt: new Date(), createdAt: new Date() },
      { id: 'bm-07', userId: 'user-1', month: '2026-07', locked: true, lockedAt: new Date(), createdAt: new Date() },
      { id: 'bm-06', userId: 'user-1', month: '2026-06', locked: true, lockedAt: new Date(), createdAt: new Date() },
    );
    prisma.categoryMonths.push(
      { id: 'cm-05', userId: 'user-1', categoryId: categoryA.id, monthId: 'bm-05', monthlyBudgetCents: 10000, createdAt: new Date(), updatedAt: new Date() },
      { id: 'cm-07', userId: 'user-1', categoryId: categoryA.id, monthId: 'bm-07', monthlyBudgetCents: 30000, createdAt: new Date(), updatedAt: new Date() },
      { id: 'cm-06', userId: 'user-1', categoryId: categoryA.id, monthId: 'bm-06', monthlyBudgetCents: 20000, createdAt: new Date(), updatedAt: new Date() },
    );

    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
    );

    expect(categoryMonth.monthlyBudgetCents).toBe(30000);
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

  it("inherits the category's most recent monthlyBudgetCents when creating fresh with no budget given", async () => {
    const { categoryMonthService, categoryA } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 12000);

    const result = await categoryMonthService.ensureActiveForCategory('user-1', categoryA.id, '2026-09');

    expect(result.monthlyBudgetCents).toBe(12000);
  });

  it('inherits by real calendar month, not insertion order, when multiple prior activations exist', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();
    // Historical (already-locked) activations, same rationale as the
    // addCategoryToMonth version of this test above. Real-latest month
    // (2026-07) inserted neither first nor last — rules out "first/last
    // created wins" as well as the actual bug that shipped.
    prisma.budgetMonths.push(
      { id: 'bm-05', userId: 'user-1', month: '2026-05', locked: true, lockedAt: new Date(), createdAt: new Date() },
      { id: 'bm-07', userId: 'user-1', month: '2026-07', locked: true, lockedAt: new Date(), createdAt: new Date() },
      { id: 'bm-06', userId: 'user-1', month: '2026-06', locked: true, lockedAt: new Date(), createdAt: new Date() },
    );
    prisma.categoryMonths.push(
      { id: 'cm-05', userId: 'user-1', categoryId: categoryA.id, monthId: 'bm-05', monthlyBudgetCents: 10000, createdAt: new Date(), updatedAt: new Date() },
      { id: 'cm-07', userId: 'user-1', categoryId: categoryA.id, monthId: 'bm-07', monthlyBudgetCents: 30000, createdAt: new Date(), updatedAt: new Date() },
      { id: 'cm-06', userId: 'user-1', categoryId: categoryA.id, monthId: 'bm-06', monthlyBudgetCents: 20000, createdAt: new Date(), updatedAt: new Date() },
    );

    const result = await categoryMonthService.ensureActiveForCategory('user-1', categoryA.id, '2026-08');

    expect(result.monthlyBudgetCents).toBe(30000);
  });

  it('throws category_not_found for a category belonging to another user', async () => {
    const { categoryMonthService, otherUsersCategory } = await setup();

    await expect(
      categoryMonthService.ensureActiveForCategory('user-1', otherUsersCategory.id, '2026-08', 50000),
    ).rejects.toMatchObject({ reason: 'category_not_found' });
  });

  it('throws month_locked when the target month is already locked', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();
    // Locked at the current month (2026-08, under the fixed clock) rather
    // than a past one — see the identical note on addCategoryToMonth's
    // version of this test above.
    prisma.budgetMonths.push({
      id: 'bm-1',
      userId: 'user-1',
      month: '2026-08',
      locked: true,
      lockedAt: new Date(),
      createdAt: new Date(),
    });

    await expect(
      categoryMonthService.ensureActiveForCategory('user-1', categoryA.id, '2026-08', 50000),
    ).rejects.toMatchObject({ reason: 'month_locked' });
  });

  it('throws category_month_beyond_planning_horizon for a month more than one month past current', async () => {
    const { categoryMonthService, categoryA } = await setup();

    await expect(
      categoryMonthService.ensureActiveForCategory('user-1', categoryA.id, '2026-10', 10000),
    ).rejects.toMatchObject({ reason: 'category_month_beyond_planning_horizon' });
  });

  it('throws category_month_beyond_planning_horizon for a month before current', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();

    await expect(
      categoryMonthService.ensureActiveForCategory('user-1', categoryA.id, '2026-07', 10000),
    ).rejects.toMatchObject({ reason: 'category_month_beyond_planning_horizon' });
    expect(prisma.categoryMonths).toHaveLength(0);
    expect(prisma.budgetMonths).toHaveLength(0);
  });

  it('does not re-enforce the horizon when the category_month is already active (idempotent return)', async () => {
    // Pre-provisioned via a direct fixture push (bypassing the horizon
    // check, same as a locked historical month would) — ensureActiveForCategory
    // must still return it rather than retroactively rejecting an
    // already-active month just because it's now far in the future relative
    // to the fixed clock. A distinct, earlier *unlocked* BudgetMonth row
    // (2026-08) is pushed too, so "current" pins there instead of trivially
    // deriving to 2027-01 itself (the only unlocked row otherwise) — without
    // it, this test would pass even if the idempotent-return exemption were
    // deleted, since the horizon check would then compare 2027-01 against
    // itself and pass regardless.
    const { prisma, categoryMonthService, categoryA } = await setup();
    prisma.budgetMonths.push({
      id: 'bm-current',
      userId: 'user-1',
      month: '2026-08',
      locked: false,
      lockedAt: null,
      createdAt: new Date(),
    });
    prisma.budgetMonths.push({
      id: 'bm-far',
      userId: 'user-1',
      month: '2027-01',
      locked: false,
      lockedAt: null,
      createdAt: new Date(),
    });
    prisma.categoryMonths.push({
      id: 'cm-far',
      userId: 'user-1',
      categoryId: categoryA.id,
      monthId: 'bm-far',
      monthlyBudgetCents: 5000,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await categoryMonthService.ensureActiveForCategory('user-1', categoryA.id, '2027-01');

    expect(result.id).toBe('cm-far');
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
