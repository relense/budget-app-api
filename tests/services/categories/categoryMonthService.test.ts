import { describe, expect, it, jest } from '@jest/globals';
import { createBudgetMonthService } from '../../../src/services/budgetMonths/budgetMonthService.js';
import {
  createCategoryMonthService,
  ensureActiveForCategoryOnClient,
} from '../../../src/services/categories/categoryMonthService.js';
import { createCategoryService } from '../../../src/services/categories/categoryService.js';
import { FakeForeignKeyConstraintError } from '../budgetMonths/testFakePrisma.js';
import { createFakePrisma } from './testFakePrisma.js';

/**
 * ensureActiveForCategoryOnClient is only ever called via a caller's own
 * open transaction in production (recurringExpenseService) — no bound
 * service-level wrapper exists (removed as dead code during a whole-
 * codebase audit, see docs/PROGRESS.md). This reproduces the same
 * single-call-transaction shape for the tests below, so they still cover
 * this function's real behavior without resurrecting the unused wrapper.
 */
async function ensureActiveForCategory(
  prisma: ReturnType<typeof createFakePrisma>,
  now: () => Date,
  userId: string,
  categoryId: string,
  month: string,
  monthlyBudgetCents?: number,
) {
  const { categoryMonth } = await prisma.$transaction((tx) =>
    ensureActiveForCategoryOnClient(tx as never, userId, categoryId, month, monthlyBudgetCents, now),
  );
  return categoryMonth;
}

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
    now,
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

  it('never returns another user\'s categoryMonth rows for the same month string', async () => {
    const { categoryMonthService, categoryA, otherUsersCategory } = await setup();
    const mine = await categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 10000);
    await categoryMonthService.addCategoryToMonth('user-2', otherUsersCategory.id, '2026-08', 99999);

    const result = await categoryMonthService.listByMonth('user-1', '2026-08');

    expect(result.map((cm) => cm.id)).toEqual([mine.id]);
  });

  it('filters by direction, resolved through each row\'s own category', async () => {
    const { categoryService, categoryMonthService, categoryA } = await setup();
    const salary = await categoryService.createCategory('user-1', {
      name: 'Salary',
      icon: 'cash',
      color: '#00FF00',
      direction: 'income',
    });
    const expenseCM = await categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 10000);
    const incomeCM = await categoryMonthService.addCategoryToMonth('user-1', salary.id, '2026-08', 450000);

    const incomeOnly = await categoryMonthService.listByMonth('user-1', '2026-08', 'income');
    const expenseOnly = await categoryMonthService.listByMonth('user-1', '2026-08', 'expense');
    const unfiltered = await categoryMonthService.listByMonth('user-1', '2026-08');

    expect(incomeOnly.map((cm) => cm.id)).toEqual([incomeCM.id]);
    expect(expenseOnly.map((cm) => cm.id)).toEqual([expenseCM.id]);
    expect(unfiltered.map((cm) => cm.id).sort()).toEqual([expenseCM.id, incomeCM.id].sort());
  });

  it('returns an empty array when no active category matches the given direction', async () => {
    const { categoryMonthService, categoryA } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 10000);

    const incomeOnly = await categoryMonthService.listByMonth('user-1', '2026-08', 'income');

    expect(incomeOnly).toEqual([]);
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

  it('does not allow re-adding the same category after removing its last month — it was cascade-deleted, so a fresh createCategory is needed instead', async () => {
    const { prisma, categoryService, categoryMonthService, categoryA } = await setup();
    const first = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      10000,
    );
    await categoryMonthService.removeCategoryFromMonth('user-1', first.id);

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 8000),
    ).rejects.toMatchObject({ reason: 'category_not_found' });

    const recreated = await categoryService.createCategory('user-1', {
      name: categoryA.name,
      icon: categoryA.icon,
      color: categoryA.color,
      budgetType: categoryA.budgetType ?? undefined,
      direction: categoryA.direction,
    });
    const second = await categoryMonthService.addCategoryToMonth(
      'user-1',
      recreated.id,
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

  it('leaves no orphaned BudgetMonth row behind when the insert fails, so a retry still triggers onNewBudgetMonth', async () => {
    // Regression test (pr-reviewer, PR #14 round 1): resolveBudgetMonthIdWithCreatedFlag
    // and the categoryMonth insert used to run in two separate transactions
    // — a failure in the second (like category_month_budget_required below)
    // left the first transaction's BudgetMonth row committed anyway, and a
    // subsequent successful retry would then see wasCreated: false, silently
    // and permanently losing the carry-forward trigger for that month.
    const prisma = createFakePrisma();
    const budgetMonthService = createBudgetMonthService({ prisma: prisma as never });
    const categoryService = createCategoryService({ prisma: prisma as never });
    const onNewBudgetMonth = jest.fn(async (_userId: string, _month: string, _monthId: string) => undefined);
    const categoryMonthService = createCategoryMonthService({
      prisma: prisma as never,
      budgetMonthService,
      now: () => new Date('2026-08-15T00:00:00.000Z'),
      onNewBudgetMonth,
    });
    const category = await categoryService.createCategory('user-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', category.id, '2026-08'),
    ).rejects.toMatchObject({ reason: 'category_month_budget_required' });
    expect(prisma.budgetMonths).toHaveLength(0);
    expect(onNewBudgetMonth).not.toHaveBeenCalled();

    await categoryMonthService.addCategoryToMonth('user-1', category.id, '2026-08', 90000);

    expect(prisma.budgetMonths).toHaveLength(1);
    expect(onNewBudgetMonth).toHaveBeenCalledWith('user-1', '2026-08', prisma.budgetMonths[0]!.id);
  });

  it('does not re-fire onNewBudgetMonth when adding a second category to an already-existing month (test-auditor gap)', async () => {
    // A regression that changed `if (monthWasCreated && onNewBudgetMonth)`
    // to `if (onNewBudgetMonth)` would pass every other test in this file
    // (none of them wire onNewBudgetMonth for a month that already exists)
    // — this is the one that would actually catch it.
    const prisma = createFakePrisma();
    const budgetMonthService = createBudgetMonthService({ prisma: prisma as never });
    const categoryService = createCategoryService({ prisma: prisma as never });
    const onNewBudgetMonth = jest.fn(async (_userId: string, _month: string, _monthId: string) => undefined);
    const categoryMonthService = createCategoryMonthService({
      prisma: prisma as never,
      budgetMonthService,
      now: () => new Date('2026-08-15T00:00:00.000Z'),
      onNewBudgetMonth,
    });
    const first = await categoryService.createCategory('user-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });
    const second = await categoryService.createCategory('user-1', {
      name: 'Housing',
      icon: 'home',
      color: '#FF0000',
      budgetType: 'need',
      direction: 'expense',
    });

    await categoryMonthService.addCategoryToMonth('user-1', first.id, '2026-08', 90000);
    expect(onNewBudgetMonth).toHaveBeenCalledTimes(1);

    await categoryMonthService.addCategoryToMonth('user-1', second.id, '2026-08', 50000);
    expect(onNewBudgetMonth).toHaveBeenCalledTimes(1);
  });

  it('still returns the created categoryMonth even if onNewBudgetMonth throws (pr-reviewer round 2 gap)', async () => {
    // The doc comment on CategoryMonthServiceDeps says the seed hook is
    // "never allowed to fail the category-add the user actually asked
    // for" and the code wraps the call in try/catch to enforce that — this
    // is the test that actually proves the swallow works, not just that
    // the try/catch exists.
    const prisma = createFakePrisma();
    const budgetMonthService = createBudgetMonthService({ prisma: prisma as never });
    const categoryService = createCategoryService({ prisma: prisma as never });
    const onNewBudgetMonth = jest.fn(async (_userId: string, _month: string, _monthId: string) => {
      throw new Error('transient seeding failure');
    });
    const categoryMonthService = createCategoryMonthService({
      prisma: prisma as never,
      budgetMonthService,
      now: () => new Date('2026-08-15T00:00:00.000Z'),
      onNewBudgetMonth,
    });
    const category = await categoryService.createCategory('user-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });

    const categoryMonth = await categoryMonthService.addCategoryToMonth('user-1', category.id, '2026-08', 90000);

    expect(categoryMonth.categoryId).toBe(category.id);
    expect(onNewBudgetMonth).toHaveBeenCalledTimes(1);
    expect(prisma.categoryMonths).toHaveLength(1);
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

  it('throws category_not_found (not budget_month_not_found) when the category is concurrently deleted between the ownership check and the insert', async () => {
    // Simulates a concurrent removeCategoryFromMonth's cascade delete (see
    // categoryMonthService.removeCategoryFromMonth) winning the race for
    // categoryA — assertOwnedCategory's re-checks pass (it existed when
    // both ran), but is gone by the time the disambiguation check in the
    // outer catch runs. Modeled with a flag flipped at the moment the
    // insert fails, not an actual array mutation: this fake's
    // $transaction snapshots and rolls back on throw, so a real delete
    // performed inside the doomed transaction would be undone along with
    // everything else — unlike the real concurrent transaction this
    // simulates, which has already independently committed.
    const { prisma, categoryMonthService, categoryA } = await setup();
    let categoryDeletedConcurrently = false;
    const originalFindUnique = prisma.category.findUnique.bind(prisma.category);
    prisma.category.findUnique = (async (args: Parameters<typeof originalFindUnique>[0]) => {
      if (categoryDeletedConcurrently && args.where.id === categoryA.id) return null;
      return originalFindUnique(args);
    }) as typeof originalFindUnique;
    prisma.categoryMonth.create = (async () => {
      categoryDeletedConcurrently = true;
      throw new FakeForeignKeyConstraintError();
    }) as typeof prisma.categoryMonth.create;

    await expect(
      categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 10000),
    ).rejects.toMatchObject({ reason: 'category_not_found' });
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

describe('lockMonth/deleteBudgetMonth cannot skip more than one month (pr-reviewer PR #10 round-2 follow-up)', () => {
  // pr-reviewer flagged a theoretical "milder echo" of the original
  // past-month hijack: could advancing "current" (via lockMonth, or via
  // deleteBudgetMonth removing the current row once it's empty) ever jump
  // by more than one month, e.g. current=2026-08, 2026-09 never
  // provisioned, 2026-10 pre-provisioned and unlocked? These prove the
  // precondition itself is unreachable under either mechanism — see the
  // comment above assertWithinPlanningHorizon's call site in
  // addCategoryToMonth for the induction argument.
  it('deleting an intervening pre-provisioned month does not open up a later one while the earlier month is still current', async () => {
    const { categoryMonthService, budgetMonthService, categoryA, categoryB } = await setup();

    // Pre-provision September (current + 1, allowed) alongside August.
    const septemberActivation = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryB.id,
      '2026-09',
      5000,
    );

    // Change of mind: remove it and delete the now-empty month, so 2026-09
    // no longer exists — this is the "hole" pr-reviewer's scenario needs
    // between current and some later pre-provisioned month.
    await categoryMonthService.removeCategoryFromMonth('user-1', septemberActivation.id);
    await budgetMonthService.deleteBudgetMonth('user-1', '2026-09');

    // August is still unlocked and still current, so the horizon is still
    // [2026-08, 2026-09] — October must still be unreachable, proving the
    // >1-month-jump precondition can never actually be constructed.
    await expect(
      categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-10', 10000),
    ).rejects.toMatchObject({ reason: 'category_month_beyond_planning_horizon' });
  });

  it('locking the current month always advances "current" by exactly one month, never more, even once a further-out month exists', async () => {
    const { categoryMonthService, budgetMonthService, categoryA, categoryB } = await setup();

    await categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 10000);
    await categoryMonthService.addCategoryToMonth('user-1', categoryB.id, '2026-09', 10000);

    await budgetMonthService.lockMonth('user-1', '2026-08');
    expect((await budgetMonthService.findCurrentMonth('user-1')).month).toBe('2026-09');

    // Only reachable now that current has advanced to 2026-09.
    await categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-10', 10000);

    await budgetMonthService.lockMonth('user-1', '2026-09');
    // October already existing doesn't let this jump skip past it.
    expect((await budgetMonthService.findCurrentMonth('user-1')).month).toBe('2026-10');
  });

  it('deleting the current month always advances "current" by exactly one month, never more, even once a further-out month exists', async () => {
    // deleteBudgetMonth is the other path (besides lockMonth) that can
    // advance "current" — removing the current, empty, unlocked row makes
    // the next-earliest unlocked row become current. Same induction
    // argument applies: a row two months out can only exist once current
    // has already reached one month out, so this can't skip further either.
    const { categoryService, categoryMonthService, budgetMonthService, categoryA, categoryB } =
      await setup();

    const augustActivation = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      10000,
    );
    const septemberActivation = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryB.id,
      '2026-09',
      10000,
    );

    await categoryMonthService.removeCategoryFromMonth('user-1', augustActivation.id);
    await budgetMonthService.deleteBudgetMonth('user-1', '2026-08');
    expect((await budgetMonthService.findCurrentMonth('user-1')).month).toBe('2026-09');

    // categoryA no longer exists — removing its only month cascade-deleted
    // it — so a fresh category stands in for it here; this test is about
    // month advancement, not category reuse.
    const categoryC = await categoryService.createCategory('user-1', {
      name: 'October Category',
      icon: 'x',
      color: '#123456',
      budgetType: 'need',
      direction: 'expense',
    });

    // Only reachable now that current has advanced to 2026-09.
    const octoberActivation = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryC.id,
      '2026-10',
      10000,
    );

    await categoryMonthService.removeCategoryFromMonth('user-1', septemberActivation.id);
    await budgetMonthService.deleteBudgetMonth('user-1', '2026-09');
    // October already existing doesn't let this jump skip past it.
    expect((await budgetMonthService.findCurrentMonth('user-1')).month).toBe('2026-10');
    expect(octoberActivation.monthlyBudgetCents).toBe(10000);
  });
});

describe('ensureActiveForCategoryOnClient', () => {
  // No bound service-level wrapper exists — recurringExpenseService calls
  // this standalone function directly against its own open transaction, so
  // these tests do the same via the local ensureActiveForCategory helper
  // above (production shape: one call, one transaction).
  it('creates a new category_month when none exists, using the given budget', async () => {
    const { prisma, now, categoryA } = await setup();

    const result = await ensureActiveForCategory(prisma, now, 'user-1', categoryA.id, '2026-08', 50000);

    expect(result.monthlyBudgetCents).toBe(50000);
    expect(prisma.categoryMonths).toHaveLength(1);
  });

  it('returns the existing category_month instead of erroring when already active, no budget needed', async () => {
    const { prisma, now, categoryMonthService, categoryA } = await setup();
    const first = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      50000,
    );

    const result = await ensureActiveForCategory(prisma, now, 'user-1', categoryA.id, '2026-08');

    expect(result.id).toBe(first.id);
    expect(prisma.categoryMonths).toHaveLength(1);
  });

  it('throws category_month_budget_required when creating fresh with no budget given', async () => {
    const { prisma, now, categoryA } = await setup();

    await expect(
      ensureActiveForCategory(prisma, now, 'user-1', categoryA.id, '2026-08'),
    ).rejects.toMatchObject({ reason: 'category_month_budget_required' });
  });

  it("inherits the category's most recent monthlyBudgetCents when creating fresh with no budget given", async () => {
    const { prisma, now, categoryMonthService, categoryA } = await setup();
    await categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-08', 12000);

    const result = await ensureActiveForCategory(prisma, now, 'user-1', categoryA.id, '2026-09');

    expect(result.monthlyBudgetCents).toBe(12000);
  });

  it('inherits by real calendar month, not insertion order, when multiple prior activations exist', async () => {
    const { prisma, now, categoryA } = await setup();
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

    const result = await ensureActiveForCategory(prisma, now, 'user-1', categoryA.id, '2026-08');

    expect(result.monthlyBudgetCents).toBe(30000);
  });

  it('throws category_not_found for a category belonging to another user', async () => {
    const { prisma, now, otherUsersCategory } = await setup();

    await expect(
      ensureActiveForCategory(prisma, now, 'user-1', otherUsersCategory.id, '2026-08', 50000),
    ).rejects.toMatchObject({ reason: 'category_not_found' });
  });

  it('throws category_not_found (not budget_month_not_found) when the category is concurrently deleted between the check and the insert', async () => {
    // Same race as addCategoryToMonth's identical test above, simulated the
    // same way (a flag, not an actual array mutation — see that test's
    // comment for why: this fake's $transaction rolls back a real delete
    // performed inside the doomed attempt, unlike the already-committed
    // concurrent transaction this is meant to represent).
    const { prisma, now, categoryA } = await setup();
    let categoryDeletedConcurrently = false;
    const originalFindUnique = prisma.category.findUnique.bind(prisma.category);
    prisma.category.findUnique = (async (args: Parameters<typeof originalFindUnique>[0]) => {
      if (categoryDeletedConcurrently && args.where.id === categoryA.id) return null;
      return originalFindUnique(args);
    }) as typeof originalFindUnique;
    prisma.categoryMonth.create = (async () => {
      categoryDeletedConcurrently = true;
      throw new FakeForeignKeyConstraintError();
    }) as typeof prisma.categoryMonth.create;

    await expect(
      ensureActiveForCategory(prisma, now, 'user-1', categoryA.id, '2026-08', 50000),
    ).rejects.toMatchObject({ reason: 'category_not_found' });
    expect(prisma.categoryMonths).toHaveLength(0);
  });

  it('throws month_locked when the target month is already locked', async () => {
    const { prisma, now, categoryA } = await setup();
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
      ensureActiveForCategory(prisma, now, 'user-1', categoryA.id, '2026-08', 50000),
    ).rejects.toMatchObject({ reason: 'month_locked' });
  });

  it('throws category_month_beyond_planning_horizon for a month more than one month past current', async () => {
    const { prisma, now, categoryA } = await setup();

    await expect(
      ensureActiveForCategory(prisma, now, 'user-1', categoryA.id, '2026-10', 10000),
    ).rejects.toMatchObject({ reason: 'category_month_beyond_planning_horizon' });
  });

  it('throws category_month_beyond_planning_horizon for a month before current', async () => {
    const { prisma, now, categoryA } = await setup();

    await expect(
      ensureActiveForCategory(prisma, now, 'user-1', categoryA.id, '2026-07', 10000),
    ).rejects.toMatchObject({ reason: 'category_month_beyond_planning_horizon' });
    expect(prisma.categoryMonths).toHaveLength(0);
    expect(prisma.budgetMonths).toHaveLength(0);
  });

  it('does not re-enforce the horizon when the category_month is already active (idempotent return)', async () => {
    // Pre-provisioned via a direct fixture push (bypassing the horizon
    // check, same as a locked historical month would) — ensureActiveForCategoryOnClient
    // must still return it rather than retroactively rejecting an
    // already-active month just because it's now far in the future relative
    // to the fixed clock. A distinct, earlier *unlocked* BudgetMonth row
    // (2026-08) is pushed too, so "current" pins there instead of trivially
    // deriving to 2027-01 itself (the only unlocked row otherwise) — without
    // it, this test would pass even if the idempotent-return exemption were
    // deleted, since the horizon check would then compare 2027-01 against
    // itself and pass regardless.
    const { prisma, now, categoryA } = await setup();
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

    const result = await ensureActiveForCategory(prisma, now, 'user-1', categoryA.id, '2027-01');

    expect(result.id).toBe('cm-far');
  });

  it('rejects a malformed month string', async () => {
    const { prisma, now, categoryA } = await setup();

    await expect(
      ensureActiveForCategory(prisma, now, 'user-1', categoryA.id, 'banana', 50000),
    ).rejects.toMatchObject({ reason: 'invalid_month' });
  });
});

describe('removeCategoryFromMonth', () => {
  it('hard-deletes the row when no transactions reference it, and also deletes the underlying category since this was its last month', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      10000,
    );

    await categoryMonthService.removeCategoryFromMonth('user-1', categoryMonth.id);

    expect(prisma.categoryMonths).toHaveLength(0);
    // The mobile client never manages the global catalog directly — the
    // only user-facing way to remove a category is from a month's budget
    // screen — so a category that's dormant everywhere would otherwise
    // become permanent, invisible clutter with no UI that could ever
    // reach it again.
    expect(prisma.categories.some((c) => c.id === categoryA.id)).toBe(false);
  });

  it('does not delete the underlying category if it is still active in another month', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();
    const augustActivation = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      10000,
    );
    await categoryMonthService.addCategoryToMonth('user-1', categoryA.id, '2026-09', 10000);

    await categoryMonthService.removeCategoryFromMonth('user-1', augustActivation.id);

    expect(prisma.categoryMonths).toHaveLength(1);
    expect(prisma.categories.some((c) => c.id === categoryA.id)).toBe(true);
  });

  it('succeeds without the cascade (leaving the category active) when it is concurrently reactivated between the check and the cascade delete', async () => {
    const { prisma, categoryMonthService, categoryA } = await setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      10000,
    );

    // Simulate the race: the "still active elsewhere" check reports none
    // (as if it ran a moment before a concurrent reactivation), but a new
    // CategoryMonth lands right after — the fake's category.delete()
    // enforces onDelete: Restrict just like the real DB. The user's actual
    // request (removing the August activation) should still succeed; only
    // the bonus cascade cleanup is skipped, since the category is
    // legitimately active again by the time it would run.
    prisma.categoryMonth.findFirst = (async () => {
      prisma.categoryMonths.push({
        id: 'racing-activation',
        userId: 'user-1',
        categoryId: categoryA.id,
        monthId: 'some-other-month-id',
        monthlyBudgetCents: 10000,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return null;
    }) as typeof prisma.categoryMonth.findFirst;

    await categoryMonthService.removeCategoryFromMonth('user-1', categoryMonth.id);

    expect(prisma.categoryMonths).toHaveLength(1);
    expect(prisma.categoryMonths[0]!.id).toBe('racing-activation');
    expect(prisma.categories.some((c) => c.id === categoryA.id)).toBe(true);
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
      recurringExpenseId: null,
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
        recurringExpenseId: null,
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

  it('throws category_month_not_found for another user\'s categoryMonth', async () => {
    const { categoryMonthService, categoryA } = await setup();
    const categoryMonth = await categoryMonthService.addCategoryToMonth(
      'user-1',
      categoryA.id,
      '2026-08',
      10000,
    );

    await expect(
      categoryMonthService.updateCategoryMonthBudget('user-2', categoryMonth.id, 12000),
    ).rejects.toMatchObject({ reason: 'category_month_not_found' });
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
