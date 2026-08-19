import { describe, expect, it, jest } from '@jest/globals';
import { createGraphQLLoaders, type GraphQLLoaderDeps } from '../../src/graphql/loaders.js';

function buildDeps(overrides: Partial<GraphQLLoaderDeps> = {}): GraphQLLoaderDeps {
  return {
    categoryService: { findManyByIds: jest.fn(async () => []) },
    categoryMonthService: { findManyByIds: jest.fn(async () => []) },
    budgetMonthService: { findManyByIds: jest.fn(async () => []) },
    transactionService: {
      listByCategoryMonthIds: jest.fn(async () => []),
      listByRecurringExpenseInstanceIds: jest.fn(async () => []),
    },
    templateService: { findManyByIds: jest.fn(async () => []) },
    instanceService: {
      findManyByIds: jest.fn(async () => []),
      sumCommittedCentsForCategoryMonth: jest.fn(async () => 0),
    },
    ...overrides,
  } as unknown as GraphQLLoaderDeps;
}

describe('recurringExpenseTemplateById', () => {
  it('batches multiple loads into a single findManyByIds call and maps rows back by id', async () => {
    const findManyByIds = jest.fn(async (ids: string[]) =>
      ids
        .filter((id) => id === 'tpl-1' || id === 'tpl-2')
        .map((id) => ({ id, name: id })),
    );
    const deps = buildDeps({ templateService: { findManyByIds } as never });
    const loaders = createGraphQLLoaders(deps);

    const [a, b] = await Promise.all([
      loaders.recurringExpenseTemplateById.load('tpl-1'),
      loaders.recurringExpenseTemplateById.load('tpl-2'),
    ]);

    expect(findManyByIds).toHaveBeenCalledTimes(1);
    expect(findManyByIds).toHaveBeenCalledWith(['tpl-1', 'tpl-2']);
    expect(a).toMatchObject({ id: 'tpl-1' });
    expect(b).toMatchObject({ id: 'tpl-2' });
  });

  it('resolves to null for an id with no matching row', async () => {
    const deps = buildDeps({
      templateService: { findManyByIds: jest.fn(async () => []) } as never,
    });
    const loaders = createGraphQLLoaders(deps);

    const result = await loaders.recurringExpenseTemplateById.load('missing');

    expect(result).toBeNull();
  });
});

describe('recurringExpenseInstanceById', () => {
  it('batches multiple loads into a single findManyByIds call and maps rows back by id', async () => {
    const findManyByIds = jest.fn(async (ids: string[]) =>
      ids.filter((id) => id === 'inst-1').map((id) => ({ id, amountCents: 100 })),
    );
    const deps = buildDeps({
      instanceService: {
        findManyByIds,
        sumCommittedCentsForCategoryMonth: jest.fn(async () => 0),
      } as never,
    });
    const loaders = createGraphQLLoaders(deps);

    const [found, missing] = await Promise.all([
      loaders.recurringExpenseInstanceById.load('inst-1'),
      loaders.recurringExpenseInstanceById.load('inst-2'),
    ]);

    expect(findManyByIds).toHaveBeenCalledTimes(1);
    expect(found).toMatchObject({ id: 'inst-1' });
    expect(missing).toBeNull();
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
      instanceService: {
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
      instanceService: {
        findManyByIds: jest.fn(async () => []),
        sumCommittedCentsForCategoryMonth,
      } as never,
    });
    const loaders = createGraphQLLoaders(deps);

    const result = await loaders.recurringCommittedCentsByCategoryMonthId.load('missing');

    expect(result).toBe(0);
    expect(sumCommittedCentsForCategoryMonth).not.toHaveBeenCalled();
  });
});

describe('per-request isolation', () => {
  it('does not share a cache across two createGraphQLLoaders() calls', async () => {
    const findManyByIds = jest.fn(async (ids: string[]) => ids.map((id) => ({ id })));
    const deps = buildDeps({ templateService: { findManyByIds } as never });

    const requestOneLoaders = createGraphQLLoaders(deps);
    await requestOneLoaders.recurringExpenseTemplateById.load('tpl-1');

    const requestTwoLoaders = createGraphQLLoaders(deps);
    await requestTwoLoaders.recurringExpenseTemplateById.load('tpl-1');

    expect(findManyByIds).toHaveBeenCalledTimes(2);
  });
});
