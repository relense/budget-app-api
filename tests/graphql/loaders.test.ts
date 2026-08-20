import { describe, expect, it, jest } from '@jest/globals';
import { createGraphQLLoaders, type GraphQLLoaderDeps } from '../../src/graphql/loaders.js';

function buildDeps(overrides: Partial<GraphQLLoaderDeps> = {}): GraphQLLoaderDeps {
  return {
    categoryService: { findManyByIds: jest.fn(async () => []) },
    categoryMonthService: { findManyByIds: jest.fn(async () => []) },
    budgetMonthService: { findManyByIds: jest.fn(async () => []) },
    transactionService: {
      listByCategoryMonthIds: jest.fn(async () => []),
      listByRecurringExpenseIds: jest.fn(async () => []),
    },
    recurringExpenseService: {
      findManyByIds: jest.fn(async () => []),
      sumCommittedCentsForCategoryMonth: jest.fn(async () => 0),
    },
    savingsFundService: { findManyByIds: jest.fn(async () => []) },
    savingsMovementService: {
      listByFundIds: jest.fn(async () => []),
      computeCurrentAmountCents: jest.fn(async () => 0),
    },
    ...overrides,
  } as unknown as GraphQLLoaderDeps;
}

describe('categoryById', () => {
  it('batches multiple loads into a single findManyByIds call and maps rows back by id', async () => {
    const findManyByIds = jest.fn(async (ids: string[]) =>
      ids.filter((id) => id === 'cat-1' || id === 'cat-2').map((id) => ({ id, name: id })),
    );
    const deps = buildDeps({ categoryService: { findManyByIds } as never });
    const loaders = createGraphQLLoaders(deps);

    const [a, b] = await Promise.all([
      loaders.categoryById.load('cat-1'),
      loaders.categoryById.load('cat-2'),
    ]);

    expect(findManyByIds).toHaveBeenCalledTimes(1);
    expect(findManyByIds).toHaveBeenCalledWith(['cat-1', 'cat-2']);
    expect(a).toMatchObject({ id: 'cat-1' });
    expect(b).toMatchObject({ id: 'cat-2' });
  });

  it('resolves to null for an id with no matching row', async () => {
    const deps = buildDeps({ categoryService: { findManyByIds: jest.fn(async () => []) } as never });
    const loaders = createGraphQLLoaders(deps);

    expect(await loaders.categoryById.load('missing')).toBeNull();
  });
});

describe('categoryMonthById', () => {
  it('batches multiple loads into a single findManyByIds call and maps rows back by id', async () => {
    const findManyByIds = jest.fn(async (ids: string[]) =>
      ids.filter((id) => id === 'cm-1' || id === 'cm-2').map((id) => ({ id })),
    );
    const deps = buildDeps({ categoryMonthService: { findManyByIds } as never });
    const loaders = createGraphQLLoaders(deps);

    const [a, b] = await Promise.all([
      loaders.categoryMonthById.load('cm-1'),
      loaders.categoryMonthById.load('cm-2'),
    ]);

    expect(findManyByIds).toHaveBeenCalledTimes(1);
    expect(findManyByIds).toHaveBeenCalledWith(['cm-1', 'cm-2']);
    expect(a).toMatchObject({ id: 'cm-1' });
    expect(b).toMatchObject({ id: 'cm-2' });
  });

  it('resolves to null for an id with no matching row', async () => {
    const deps = buildDeps({ categoryMonthService: { findManyByIds: jest.fn(async () => []) } as never });
    const loaders = createGraphQLLoaders(deps);

    expect(await loaders.categoryMonthById.load('missing')).toBeNull();
  });
});

describe('budgetMonthById', () => {
  it('batches multiple loads into a single findManyByIds call and maps rows back by id', async () => {
    const findManyByIds = jest.fn(async (ids: string[]) =>
      ids.filter((id) => id === 'bm-1' || id === 'bm-2').map((id) => ({ id, month: id })),
    );
    const deps = buildDeps({ budgetMonthService: { findManyByIds } as never });
    const loaders = createGraphQLLoaders(deps);

    const [a, b] = await Promise.all([
      loaders.budgetMonthById.load('bm-1'),
      loaders.budgetMonthById.load('bm-2'),
    ]);

    expect(findManyByIds).toHaveBeenCalledTimes(1);
    expect(findManyByIds).toHaveBeenCalledWith(['bm-1', 'bm-2']);
    expect(a).toMatchObject({ id: 'bm-1' });
    expect(b).toMatchObject({ id: 'bm-2' });
  });

  it('resolves to null for an id with no matching row', async () => {
    const deps = buildDeps({ budgetMonthService: { findManyByIds: jest.fn(async () => []) } as never });
    const loaders = createGraphQLLoaders(deps);

    expect(await loaders.budgetMonthById.load('missing')).toBeNull();
  });
});

describe('recurringExpenseById', () => {
  it('batches multiple loads into a single findManyByIds call and maps rows back by id', async () => {
    const findManyByIds = jest.fn(async (ids: string[]) =>
      ids
        .filter((id) => id === 'recurring-1' || id === 'recurring-2')
        .map((id) => ({ id, name: id })),
    );
    const deps = buildDeps({
      recurringExpenseService: {
        findManyByIds,
        sumCommittedCentsForCategoryMonth: jest.fn(async () => 0),
      } as never,
    });
    const loaders = createGraphQLLoaders(deps);

    const [a, b] = await Promise.all([
      loaders.recurringExpenseById.load('recurring-1'),
      loaders.recurringExpenseById.load('recurring-2'),
    ]);

    expect(findManyByIds).toHaveBeenCalledTimes(1);
    expect(findManyByIds).toHaveBeenCalledWith(['recurring-1', 'recurring-2']);
    expect(a).toMatchObject({ id: 'recurring-1' });
    expect(b).toMatchObject({ id: 'recurring-2' });
  });

  it('resolves to null for an id with no matching row', async () => {
    const deps = buildDeps({
      recurringExpenseService: {
        findManyByIds: jest.fn(async () => []),
        sumCommittedCentsForCategoryMonth: jest.fn(async () => 0),
      } as never,
    });
    const loaders = createGraphQLLoaders(deps);

    const result = await loaders.recurringExpenseById.load('missing');

    expect(result).toBeNull();
  });
});

describe('recurringCommittedCentsByCategoryMonthId', () => {
  it('sums committed cents via the resolved categoryMonth', async () => {
    const categoryMonthFindManyByIds = jest.fn(async (ids: string[]) =>
      ids
        .filter((id) => id === 'cm-1')
        .map((id) => ({ id, categoryId: 'cat-1', monthId: 'month-1' })),
    );
    const sumCommittedCentsForCategoryMonth = jest.fn(async (_categoryId: string, _monthId: string) => 4000);
    const deps = buildDeps({
      categoryMonthService: { findManyByIds: categoryMonthFindManyByIds } as never,
      recurringExpenseService: {
        findManyByIds: jest.fn(async () => []),
        sumCommittedCentsForCategoryMonth,
      } as never,
    });
    const loaders = createGraphQLLoaders(deps);

    const result = await loaders.recurringCommittedCentsByCategoryMonthId.load('cm-1');

    expect(result).toBe(4000);
    expect(sumCommittedCentsForCategoryMonth).toHaveBeenCalledWith('cat-1', 'month-1');
  });

  it('returns 0 without calling sumCommittedCentsForCategoryMonth when the categoryMonth id is unknown', async () => {
    const sumCommittedCentsForCategoryMonth = jest.fn(async () => 0);
    const deps = buildDeps({
      categoryMonthService: { findManyByIds: jest.fn(async () => []) } as never,
      recurringExpenseService: {
        findManyByIds: jest.fn(async () => []),
        sumCommittedCentsForCategoryMonth,
      } as never,
    });
    const loaders = createGraphQLLoaders(deps);

    const result = await loaders.recurringCommittedCentsByCategoryMonthId.load('missing');

    expect(result).toBe(0);
    expect(sumCommittedCentsForCategoryMonth).not.toHaveBeenCalled();
  });

  it('batches multiple loads into a single categoryMonthService.findManyByIds call', async () => {
    const categoryMonthFindManyByIds = jest.fn(async (ids: string[]) =>
      ids
        .filter((id) => id === 'cm-1' || id === 'cm-2')
        .map((id) => ({ id, categoryId: `cat-${id}`, monthId: 'month-1' })),
    );
    const sumCommittedCentsForCategoryMonth = jest.fn(async () => 1000);
    const deps = buildDeps({
      categoryMonthService: { findManyByIds: categoryMonthFindManyByIds } as never,
      recurringExpenseService: {
        findManyByIds: jest.fn(async () => []),
        sumCommittedCentsForCategoryMonth,
      } as never,
    });
    const loaders = createGraphQLLoaders(deps);

    await Promise.all([
      loaders.recurringCommittedCentsByCategoryMonthId.load('cm-1'),
      loaders.recurringCommittedCentsByCategoryMonthId.load('cm-2'),
    ]);

    expect(categoryMonthFindManyByIds).toHaveBeenCalledTimes(1);
    expect(categoryMonthFindManyByIds).toHaveBeenCalledWith(['cm-1', 'cm-2']);
  });
});

describe('transactionsByRecurringExpenseId', () => {
  it('batches multiple loads into a single call and groups rows by recurring expense id', async () => {
    const listByRecurringExpenseIds = jest.fn(async (ids: string[]) => [
      { id: 'tx-1', recurringExpenseId: 'recurring-1', amountCents: 100 },
      { id: 'tx-2', recurringExpenseId: 'recurring-1', amountCents: 200 },
      {
        id: 'tx-3',
        recurringExpenseId: ids.includes('recurring-2') ? 'recurring-2' : null,
        amountCents: 300,
      },
    ]);
    const deps = buildDeps({
      transactionService: {
        listByCategoryMonthIds: jest.fn(async () => []),
        listByRecurringExpenseIds,
      } as never,
    });
    const loaders = createGraphQLLoaders(deps);

    const [forFirst, forSecond] = await Promise.all([
      loaders.transactionsByRecurringExpenseId.load('recurring-1'),
      loaders.transactionsByRecurringExpenseId.load('recurring-2'),
    ]);

    expect(listByRecurringExpenseIds).toHaveBeenCalledTimes(1);
    expect(listByRecurringExpenseIds).toHaveBeenCalledWith(['recurring-1', 'recurring-2']);
    expect(forFirst.map((tx) => tx.id)).toEqual(['tx-1', 'tx-2']);
    expect(forSecond.map((tx) => tx.id)).toEqual(['tx-3']);
  });

  it('excludes rows with a null recurringExpenseId instead of grouping them under a falsy key', async () => {
    const listByRecurringExpenseIds = jest.fn(async () => [
      { id: 'tx-unlinked', recurringExpenseId: null, amountCents: 500 },
    ]);
    const deps = buildDeps({
      transactionService: {
        listByCategoryMonthIds: jest.fn(async () => []),
        listByRecurringExpenseIds,
      } as never,
    });
    const loaders = createGraphQLLoaders(deps);

    const result = await loaders.transactionsByRecurringExpenseId.load('recurring-1');

    expect(result).toEqual([]);
  });
});

describe('savingsFundById', () => {
  it('resolves to null for an id with no matching row', async () => {
    const deps = buildDeps({
      savingsFundService: { findManyByIds: jest.fn(async () => []) } as never,
      savingsMovementService: {
        listByFundIds: jest.fn(async () => []),
        computeCurrentAmountCents: jest.fn(async () => 0),
      } as never,
    });
    const loaders = createGraphQLLoaders(deps);

    const result = await loaders.savingsFundById.load('missing-fund');

    expect(result).toBeNull();
  });

  it('batches multiple loads into a single findManyByIds call and maps rows back by id', async () => {
    const findManyByIds = jest.fn(async (ids: string[]) =>
      ids.filter((id) => id === 'fund-1' || id === 'fund-2').map((id) => ({ id, name: id })),
    );
    const deps = buildDeps({
      savingsFundService: { findManyByIds } as never,
      savingsMovementService: {
        listByFundIds: jest.fn(async () => []),
        computeCurrentAmountCents: jest.fn(async () => 0),
      } as never,
    });
    const loaders = createGraphQLLoaders(deps);

    const [a, b] = await Promise.all([
      loaders.savingsFundById.load('fund-1'),
      loaders.savingsFundById.load('fund-2'),
    ]);

    expect(findManyByIds).toHaveBeenCalledTimes(1);
    expect(findManyByIds).toHaveBeenCalledWith(['fund-1', 'fund-2']);
    expect(a).toMatchObject({ id: 'fund-1' });
    expect(b).toMatchObject({ id: 'fund-2' });
  });
});

describe('movementsBySavingsFundId', () => {
  it('batches multiple loads into a single listByFundIds call and groups rows by fund id', async () => {
    const listByFundIds = jest.fn(async (ids: string[]) => [
      { id: 'mv-1', fundId: 'fund-1', amountCents: 100 },
      { id: 'mv-2', fundId: 'fund-1', amountCents: 200 },
      { id: 'mv-3', fundId: ids.includes('fund-2') ? 'fund-2' : 'nope', amountCents: 300 },
    ]);
    const deps = buildDeps({
      savingsFundService: { findManyByIds: jest.fn(async () => []) } as never,
      savingsMovementService: {
        listByFundIds,
        computeCurrentAmountCents: jest.fn(async () => 0),
      } as never,
    });
    const loaders = createGraphQLLoaders(deps);

    const [forFirst, forSecond] = await Promise.all([
      loaders.movementsBySavingsFundId.load('fund-1'),
      loaders.movementsBySavingsFundId.load('fund-2'),
    ]);

    expect(listByFundIds).toHaveBeenCalledTimes(1);
    expect(listByFundIds).toHaveBeenCalledWith(['fund-1', 'fund-2']);
    expect(forFirst.map((m) => m.id)).toEqual(['mv-1', 'mv-2']);
    expect(forSecond.map((m) => m.id)).toEqual(['mv-3']);
  });
});

describe('currentAmountCentsBySavingsFundId', () => {
  it('returns 0 without calling computeCurrentAmountCents when the fund id is unknown', async () => {
    const computeCurrentAmountCents = jest.fn(async () => 0);
    const deps = buildDeps({
      savingsFundService: { findManyByIds: jest.fn(async () => []) } as never,
      savingsMovementService: {
        listByFundIds: jest.fn(async () => []),
        computeCurrentAmountCents,
      } as never,
    });
    const loaders = createGraphQLLoaders(deps);

    const result = await loaders.currentAmountCentsBySavingsFundId.load('missing-fund');

    expect(result).toBe(0);
    expect(computeCurrentAmountCents).not.toHaveBeenCalled();
  });

  it('batches multiple loads into a single savingsFundService.findManyByIds call', async () => {
    const findManyByIds = jest.fn(async (ids: string[]) =>
      ids
        .filter((id) => id === 'fund-1' || id === 'fund-2')
        .map((id) => ({ id, initialBalanceCents: 1000 })),
    );
    const computeCurrentAmountCents = jest.fn(async () => 1500);
    const deps = buildDeps({
      savingsFundService: { findManyByIds } as never,
      savingsMovementService: {
        listByFundIds: jest.fn(async () => []),
        computeCurrentAmountCents,
      } as never,
    });
    const loaders = createGraphQLLoaders(deps);

    await Promise.all([
      loaders.currentAmountCentsBySavingsFundId.load('fund-1'),
      loaders.currentAmountCentsBySavingsFundId.load('fund-2'),
    ]);

    expect(findManyByIds).toHaveBeenCalledTimes(1);
    expect(findManyByIds).toHaveBeenCalledWith(['fund-1', 'fund-2']);
  });
});

describe('per-request isolation', () => {
  it('does not share a cache across two createGraphQLLoaders() calls', async () => {
    const findManyByIds = jest.fn(async (ids: string[]) => ids.map((id) => ({ id })));
    const deps = buildDeps({
      recurringExpenseService: {
        findManyByIds,
        sumCommittedCentsForCategoryMonth: jest.fn(async () => 0),
      } as never,
    });

    const requestOneLoaders = createGraphQLLoaders(deps);
    await requestOneLoaders.recurringExpenseById.load('recurring-1');

    const requestTwoLoaders = createGraphQLLoaders(deps);
    await requestTwoLoaders.recurringExpenseById.load('recurring-1');

    expect(findManyByIds).toHaveBeenCalledTimes(2);
  });
});
