import { describe, expect, it, jest } from '@jest/globals';
import { graphql } from 'graphql';
import type { GraphQLContext } from '../../src/graphql/context.js';
import { BudgetMonthServiceError } from '../../src/services/budgetMonths/budgetMonthService.js';
import { schema } from '../../src/graphql/schema.js';

function buildContext(userId: string | null): GraphQLContext {
  return {
    userId,
    categoryService: {} as never,
    categoryMonthService: {} as never,
    budgetMonthService: {
      findCurrentMonth: jest.fn(async () => ({ month: '2026-08', locked: false })),
      lockMonth: jest.fn(async () => ({ id: 'bm-1', month: '2026-08', locked: true, lockedAt: new Date() })),
      deleteBudgetMonth: jest.fn(async () => undefined),
    } as never,
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

describe('Query.currentMonth', () => {
  const query = '{ currentMonth { month locked } }';

  it("returns the user's current month", async () => {
    const context = buildContext('user-1');

    const result = await run(query, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ currentMonth: { month: '2026-08', locked: false } });
    expect(context.budgetMonthService.findCurrentMonth).toHaveBeenCalledWith('user-1');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(query, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.budgetMonthService.findCurrentMonth).not.toHaveBeenCalled();
  });
});

describe('Mutation.lockMonth', () => {
  const mutation = 'mutation { lockMonth(month: "2026-08") { month locked } }';

  it('locks the given month', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ lockMonth: { month: '2026-08', locked: true } });
    expect(context.budgetMonthService.lockMonth).toHaveBeenCalledWith('user-1', '2026-08');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.budgetMonthService.lockMonth).not.toHaveBeenCalled();
  });

  it('maps budget_month_not_current to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.budgetMonthService.lockMonth as jest.Mock).mockImplementation(async () => {
      throw new BudgetMonthServiceError('budget_month_not_current');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('BUDGET_MONTH_NOT_CURRENT');
  });

  it('maps budget_month_not_found to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.budgetMonthService.lockMonth as jest.Mock).mockImplementation(async () => {
      throw new BudgetMonthServiceError('budget_month_not_found');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('BUDGET_MONTH_NOT_FOUND');
  });
});

describe('Mutation.deleteBudgetMonth', () => {
  const mutation = 'mutation { deleteBudgetMonth(month: "2026-09") }';

  it('deletes the given month and returns true', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ deleteBudgetMonth: true });
    expect(context.budgetMonthService.deleteBudgetMonth).toHaveBeenCalledWith('user-1', '2026-09');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.budgetMonthService.deleteBudgetMonth).not.toHaveBeenCalled();
  });

  it('maps budget_month_has_activations to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.budgetMonthService.deleteBudgetMonth as jest.Mock).mockImplementation(async () => {
      throw new BudgetMonthServiceError('budget_month_has_activations');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('BUDGET_MONTH_HAS_ACTIVATIONS');
  });
});
