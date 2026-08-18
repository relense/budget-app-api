import { describe, expect, it } from '@jest/globals';
import { createBudgetMonthService } from './budgetMonthService.js';
import { createFakePrisma } from './testFakePrisma.js';

function setup() {
  const prisma = createFakePrisma();
  const budgetMonthService = createBudgetMonthService({ prisma: prisma as never });
  return { prisma, budgetMonthService };
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
