import { describe, expect, it, jest } from '@jest/globals';
import { graphql } from 'graphql';
import type { GraphQLContext } from '../../src/graphql/context.js';
import { RecurringExpenseServiceError } from '../../src/services/recurringExpenses/recurringExpenseService.js';
import { schema } from '../../src/graphql/schema.js';

const recurringExpense = {
  id: 'recurring-1',
  monthId: 'month-1',
  name: 'Rent',
  amountCents: 80000,
  budgetType: 'need' as const,
  dueDay: 1,
  categoryId: 'cat-1',
};

const transaction = {
  id: 'tx-1',
  amountCents: 80000,
  date: new Date('2026-08-01'),
  merchant: 'Landlord',
  note: null,
  direction: 'expense' as const,
  categoryMonthId: 'cm-1',
  recurringExpenseId: recurringExpense.id,
};

function buildContext(userId: string | null): GraphQLContext {
  return {
    userId,
    categoryService: {} as never,
    categoryMonthService: {} as never,
    budgetMonthService: {} as never,
    transactionService: {} as never,
    recurringExpenseService: {
      listByMonth: jest.fn(async () => [recurringExpense]),
      createRecurringExpense: jest.fn(async () => recurringExpense),
      updateRecurringExpense: jest.fn(async () => recurringExpense),
      removeFromMonth: jest.fn(async () => undefined),
      markRecurringPaid: jest.fn(async () => transaction),
    } as never,
    savingsFundService: {} as never,
    savingsMovementService: {} as never,
    bankBalanceService: {} as never,
    loaders: {} as never,
  };
}

async function run(source: string, contextValue: GraphQLContext) {
  return graphql({ schema, source, contextValue });
}

describe('Query.recurringExpenses', () => {
  const query = '{ recurringExpenses(month: "2026-08") { id name amountCents budgetType dueDay } }';

  it('returns recurring expenses for the given month, scoped to the authenticated user', async () => {
    const context = buildContext('user-1');

    const result = await run(query, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      recurringExpenses: [
        { id: 'recurring-1', name: 'Rent', amountCents: 80000, budgetType: 'NEED', dueDay: 1 },
      ],
    });
    expect(context.recurringExpenseService.listByMonth).toHaveBeenCalledWith('user-1', '2026-08');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(query, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.recurringExpenseService.listByMonth).not.toHaveBeenCalled();
  });
});

describe('Mutation.createRecurringExpense', () => {
  const mutation = `
    mutation {
      createRecurringExpense(
        input: { name: "Rent", amountCents: 80000, categoryId: "cat-1", budgetType: NEED, dueDay: 1 }
        month: "2026-08"
        categoryMonthlyBudgetCents: 90000
      ) { id name amountCents budgetType dueDay }
    }
  `;

  it('creates the recurring expense for the given month and returns it', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      createRecurringExpense: {
        id: 'recurring-1',
        name: 'Rent',
        amountCents: 80000,
        budgetType: 'NEED',
        dueDay: 1,
      },
    });
    expect(context.recurringExpenseService.createRecurringExpense).toHaveBeenCalledWith(
      'user-1',
      { name: 'Rent', amountCents: 80000, categoryId: 'cat-1', budgetType: 'need', dueDay: 1 },
      '2026-08',
      90000,
    );
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.recurringExpenseService.createRecurringExpense).not.toHaveBeenCalled();
  });

  it('maps a service error to a GraphQLError with a matching extensions.code', async () => {
    const context = buildContext('user-1');
    (context.recurringExpenseService.createRecurringExpense as jest.Mock).mockImplementation(async () => {
      throw new RecurringExpenseServiceError('invalid_category_direction');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('INVALID_CATEGORY_DIRECTION');
  });
});

describe('Mutation.updateRecurringExpense', () => {
  const mutation = `
    mutation {
      updateRecurringExpense(
        id: "recurring-1"
        input: { name: "Rent", amountCents: 85000, categoryId: "cat-1", budgetType: WANT, dueDay: 5 }
      ) { id }
    }
  `;

  it('updates the recurring expense and returns it', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(context.recurringExpenseService.updateRecurringExpense).toHaveBeenCalledWith(
      'user-1',
      'recurring-1',
      {
        name: 'Rent',
        amountCents: 85000,
        categoryId: 'cat-1',
        budgetType: 'want',
        dueDay: 5,
      },
    );
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.recurringExpenseService.updateRecurringExpense).not.toHaveBeenCalled();
  });

  it('maps recurring_expense_not_found to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.recurringExpenseService.updateRecurringExpense as jest.Mock).mockImplementation(async () => {
      throw new RecurringExpenseServiceError('recurring_expense_not_found');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('RECURRING_EXPENSE_NOT_FOUND');
  });
});

describe('Mutation.removeRecurringExpenseFromMonth', () => {
  const mutation = 'mutation { removeRecurringExpenseFromMonth(id: "recurring-1") }';

  it('removes the recurring expense and returns true', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ removeRecurringExpenseFromMonth: true });
    expect(context.recurringExpenseService.removeFromMonth).toHaveBeenCalledWith('user-1', 'recurring-1');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.recurringExpenseService.removeFromMonth).not.toHaveBeenCalled();
  });

  it('maps recurring_expense_has_transactions to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.recurringExpenseService.removeFromMonth as jest.Mock).mockImplementation(async () => {
      throw new RecurringExpenseServiceError('recurring_expense_has_transactions');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('RECURRING_EXPENSE_HAS_TRANSACTIONS');
  });
});

describe('Mutation.markRecurringPaid', () => {
  const mutation = `
    mutation {
      markRecurringPaid(
        id: "recurring-1"
        input: { amountCents: 80000, date: "2026-08-01", merchant: "Landlord" }
      ) { id amountCents merchant direction date }
    }
  `;

  it('records the payment and returns the resulting transaction', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      markRecurringPaid: {
        id: 'tx-1',
        amountCents: 80000,
        merchant: 'Landlord',
        direction: 'EXPENSE',
        date: '2026-08-01',
      },
    });
    expect(context.recurringExpenseService.markRecurringPaid).toHaveBeenCalledWith(
      'user-1',
      'recurring-1',
      {
        amountCents: 80000,
        date: '2026-08-01',
        merchant: 'Landlord',
        note: undefined,
      },
    );
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.recurringExpenseService.markRecurringPaid).not.toHaveBeenCalled();
  });

  it('maps month_locked to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.recurringExpenseService.markRecurringPaid as jest.Mock).mockImplementation(async () => {
      throw new RecurringExpenseServiceError('month_locked');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('MONTH_LOCKED');
  });
});
