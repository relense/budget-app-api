import { describe, expect, it, jest } from '@jest/globals';
import { graphql } from 'graphql';
import type { GraphQLContext } from '../../src/graphql/context.js';
import { schema } from '../../src/graphql/schema.js';

const categoryMonth = {
  id: 'cm-1',
  categoryId: 'cat-1',
  monthId: 'month-1',
  monthlyBudgetCents: 10000,
};

function buildContext(userId: string | null): GraphQLContext {
  return {
    userId,
    categoryService: {} as never,
    categoryMonthService: {
      addCategoryToMonth: jest.fn(async () => categoryMonth),
      listByMonth: jest.fn(async () => [categoryMonth]),
    } as never,
    budgetMonthService: {} as never,
    transactionService: {} as never,
    recurringExpenseService: {} as never,
    savingsFundService: {} as never,
    savingsMovementService: {} as never,
    bankBalanceService: {} as never,
    loaders: {} as never,
  };
}

async function run(source: string, contextValue: GraphQLContext) {
  return graphql({ schema, source, contextValue });
}

describe('Query.categoryMonths', () => {
  const query = 'query($direction: Direction) { categoryMonths(month: "2026-08", direction: $direction) { id } }';

  it('calls listByMonth without a direction when none is given', async () => {
    const context = buildContext('user-1');

    const result = await run('{ categoryMonths(month: "2026-08") { id } }', context);

    expect(result.errors).toBeUndefined();
    expect(context.categoryMonthService.listByMonth).toHaveBeenCalledWith('user-1', '2026-08', undefined);
  });

  it('maps the direction argument through to listByMonth as a db-cased value', async () => {
    const context = buildContext('user-1');

    const result = await graphql({ schema, source: query, contextValue: context, variableValues: { direction: 'INCOME' } });

    expect(result.errors).toBeUndefined();
    expect(context.categoryMonthService.listByMonth).toHaveBeenCalledWith('user-1', '2026-08', 'income');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run('{ categoryMonths(month: "2026-08") { id } }', context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.categoryMonthService.listByMonth).not.toHaveBeenCalled();
  });
});

describe('Mutation.addCategoryToMonth', () => {
  it('passes the given monthlyBudgetCents through to the service', async () => {
    const context = buildContext('user-1');

    const result = await run(
      'mutation { addCategoryToMonth(categoryId: "cat-1", month: "2026-08", monthlyBudgetCents: 10000) { id monthlyBudgetCents } }',
      context,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ addCategoryToMonth: { id: 'cm-1', monthlyBudgetCents: 10000 } });
    expect(context.categoryMonthService.addCategoryToMonth).toHaveBeenCalledWith(
      'user-1',
      'cat-1',
      '2026-08',
      10000,
    );
  });

  it('passes undefined (not null) to the service when monthlyBudgetCents is omitted, so it can inherit', async () => {
    const context = buildContext('user-1');

    const result = await run(
      'mutation { addCategoryToMonth(categoryId: "cat-1", month: "2026-08") { id } }',
      context,
    );

    expect(result.errors).toBeUndefined();
    expect(context.categoryMonthService.addCategoryToMonth).toHaveBeenCalledWith(
      'user-1',
      'cat-1',
      '2026-08',
      undefined,
    );
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(
      'mutation { addCategoryToMonth(categoryId: "cat-1", month: "2026-08", monthlyBudgetCents: 10000) { id } }',
      context,
    );

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.categoryMonthService.addCategoryToMonth).not.toHaveBeenCalled();
  });
});
