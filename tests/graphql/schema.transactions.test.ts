import { describe, expect, it, jest } from '@jest/globals';
import { graphql } from 'graphql';
import type { GraphQLContext } from '../../src/graphql/context.js';
import { TransactionServiceError } from '../../src/services/categories/transactionService.js';
import { schema } from '../../src/graphql/schema.js';

const transaction = {
  id: 'tx-1',
  amountCents: 5000,
  date: new Date('2026-08-05'),
  merchant: 'Auchan',
  note: null,
  direction: 'expense' as const,
  categoryMonthId: 'cm-1',
  recurringExpenseId: null,
};

function buildContext(userId: string | null): GraphQLContext {
  return {
    userId,
    categoryService: {} as never,
    categoryMonthService: {} as never,
    budgetMonthService: {} as never,
    transactionService: {
      list: jest.fn(async () => [transaction]),
      create: jest.fn(async () => transaction),
      update: jest.fn(async () => transaction),
      deleteTransaction: jest.fn(async () => undefined),
    } as never,
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

describe('Query.transactions', () => {
  const query = '{ transactions(month: "2026-08") { id amountCents } }';

  it('returns the month\'s transactions for the authenticated user', async () => {
    const context = buildContext('user-1');

    const result = await run(query, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ transactions: [{ id: 'tx-1', amountCents: 5000 }] });
    expect(context.transactionService.list).toHaveBeenCalledWith('user-1', '2026-08', undefined);
  });

  it('forwards an optional categoryId filter', async () => {
    const context = buildContext('user-1');

    await run('{ transactions(month: "2026-08", categoryId: "cat-1") { id } }', context);

    expect(context.transactionService.list).toHaveBeenCalledWith('user-1', '2026-08', 'cat-1');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(query, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.transactionService.list).not.toHaveBeenCalled();
  });
});

describe('Mutation.createTransaction', () => {
  const mutation =
    'mutation { createTransaction(input: { categoryMonthId: "cm-1", amountCents: 5000, date: "2026-08-05", merchant: "Auchan" }) { id amountCents } }';

  it('creates the transaction and returns it', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ createTransaction: { id: 'tx-1', amountCents: 5000 } });
    expect(context.transactionService.create).toHaveBeenCalledWith('user-1', {
      categoryMonthId: 'cm-1',
      amountCents: 5000,
      date: '2026-08-05',
      merchant: 'Auchan',
      note: undefined,
    });
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.transactionService.create).not.toHaveBeenCalled();
  });

  it('maps category_month_not_found to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.transactionService.create as jest.Mock).mockImplementation(async () => {
      throw new TransactionServiceError('category_month_not_found');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('CATEGORY_MONTH_NOT_FOUND');
  });
});

describe('Mutation.updateTransaction', () => {
  const mutation =
    'mutation { updateTransaction(id: "tx-1", input: { categoryMonthId: "cm-1", amountCents: 6000, date: "2026-08-06" }) { id } }';

  it('updates the transaction and returns it', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(context.transactionService.update).toHaveBeenCalledWith('user-1', 'tx-1', {
      categoryMonthId: 'cm-1',
      amountCents: 6000,
      date: '2026-08-06',
      merchant: undefined,
      note: undefined,
    });
  });

  it('maps transaction_not_found to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.transactionService.update as jest.Mock).mockImplementation(async () => {
      throw new TransactionServiceError('transaction_not_found');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('TRANSACTION_NOT_FOUND');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.transactionService.update).not.toHaveBeenCalled();
  });
});

describe('Mutation.deleteTransaction', () => {
  const mutation = 'mutation { deleteTransaction(id: "tx-1") }';

  it('deletes the transaction and returns true', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ deleteTransaction: true });
    expect(context.transactionService.deleteTransaction).toHaveBeenCalledWith('user-1', 'tx-1');
  });

  it('maps month_locked to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.transactionService.deleteTransaction as jest.Mock).mockImplementation(async () => {
      throw new TransactionServiceError('month_locked');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('MONTH_LOCKED');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.transactionService.deleteTransaction).not.toHaveBeenCalled();
  });
});
