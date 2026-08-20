import { describe, expect, it, jest } from '@jest/globals';
import { graphql } from 'graphql';
import { createGraphQLLoaders, type GraphQLLoaderDeps } from '../../src/graphql/loaders.js';
import { schema } from '../../src/graphql/schema.js';

/**
 * actualAmountCents reuses the same transactionsByCategoryMonthId
 * DataLoader as CategoryMonth.transactions — this proves it sums the
 * loader's real batched result rather than a mocked shortcut.
 */

const categoryMonth = {
  id: 'cm-1',
  categoryId: 'cat-1',
  monthId: 'month-1',
  monthlyBudgetCents: 450000,
};

const secondCategoryMonth = {
  id: 'cm-2',
  categoryId: 'cat-2',
  monthId: 'month-1',
  monthlyBudgetCents: 30000,
};

function buildContext(
  transactionsForCategoryMonth: Array<{ id: string; categoryMonthId: string; amountCents: number }>,
  categoryMonths: Array<typeof categoryMonth> = [categoryMonth],
) {
  const listByCategoryMonthIds = jest.fn(async (ids: string[]) =>
    transactionsForCategoryMonth.filter((t) => ids.includes(t.categoryMonthId)),
  );
  const loaderDeps: GraphQLLoaderDeps = {
    categoryService: { findManyByIds: jest.fn(async () => []) },
    categoryMonthService: { findManyByIds: jest.fn(async () => []) },
    budgetMonthService: { findManyByIds: jest.fn(async () => []) },
    transactionService: {
      listByCategoryMonthIds,
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
  } as unknown as GraphQLLoaderDeps;

  return {
    context: {
      userId: 'user-1',
      categoryService: {} as never,
      categoryMonthService: {
        listByMonth: jest.fn(async () => categoryMonths),
      } as never,
      budgetMonthService: {} as never,
      transactionService: {} as never,
      recurringExpenseService: {} as never,
      savingsFundService: {} as never,
      savingsMovementService: {} as never,
      loaders: createGraphQLLoaders(loaderDeps),
    },
    listByCategoryMonthIds,
  };
}

describe('CategoryMonth.actualAmountCents', () => {
  const query = '{ categoryMonths(month: "2026-08") { id actualAmountCents } }';

  it('sums the CategoryMonth\'s own transactions via the real transactionsByCategoryMonthId loader', async () => {
    const { context } = buildContext([
      { id: 'tx-1', categoryMonthId: 'cm-1', amountCents: 300000 },
      { id: 'tx-2', categoryMonthId: 'cm-1', amountCents: 150000 },
      { id: 'tx-unrelated', categoryMonthId: 'cm-other', amountCents: 999999 },
    ]);

    const result = await graphql({ schema, source: query, contextValue: context });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ categoryMonths: [{ id: 'cm-1', actualAmountCents: 450000 }] });
  });

  it('is 0 when the CategoryMonth has no transactions yet', async () => {
    const { context } = buildContext([]);

    const result = await graphql({ schema, source: query, contextValue: context });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ categoryMonths: [{ id: 'cm-1', actualAmountCents: 0 }] });
  });

  it('batches multiple CategoryMonth rows into a single listByCategoryMonthIds call, each getting its own sum', async () => {
    const { context, listByCategoryMonthIds } = buildContext(
      [
        { id: 'tx-1', categoryMonthId: 'cm-1', amountCents: 300000 },
        { id: 'tx-2', categoryMonthId: 'cm-2', amountCents: 5000 },
        { id: 'tx-3', categoryMonthId: 'cm-2', amountCents: 3000 },
      ],
      [categoryMonth, secondCategoryMonth],
    );

    const result = await graphql({
      schema,
      source: '{ categoryMonths(month: "2026-08") { id actualAmountCents } }',
      contextValue: context,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      categoryMonths: [
        { id: 'cm-1', actualAmountCents: 300000 },
        { id: 'cm-2', actualAmountCents: 8000 },
      ],
    });
    expect(listByCategoryMonthIds).toHaveBeenCalledTimes(1);
    expect(listByCategoryMonthIds).toHaveBeenCalledWith(['cm-1', 'cm-2']);
  });
});
