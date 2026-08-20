import { describe, expect, it, jest } from '@jest/globals';
import { graphql } from 'graphql';
import type { GraphQLContext } from '../../src/graphql/context.js';
import { BankBalanceServiceError } from '../../src/services/bankBalance/bankBalanceService.js';
import { schema } from '../../src/graphql/schema.js';

const balance = {
  amountCents: 79500000,
  checkpointAmountCents: 75000000,
  checkpointSetAt: new Date('2026-08-20T12:00:00.000Z'),
};

function buildContext(userId: string | null): GraphQLContext {
  return {
    userId,
    categoryService: {} as never,
    categoryMonthService: {} as never,
    budgetMonthService: {} as never,
    transactionService: {} as never,
    recurringExpenseService: {} as never,
    savingsFundService: {} as never,
    savingsMovementService: {} as never,
    bankBalanceService: {
      getBankBalance: jest.fn(async () => balance),
      setBankBalanceCheckpoint: jest.fn(async () => balance),
    } as never,
    loaders: {} as never,
  };
}

async function run(source: string, contextValue: GraphQLContext) {
  return graphql({ schema, source, contextValue });
}

describe('Query.bankBalance', () => {
  const query = '{ bankBalance { amountCents checkpointAmountCents checkpointSetAt } }';

  it('returns the computed balance, formatting checkpointSetAt as a full ISO timestamp', async () => {
    const context = buildContext('user-1');

    const result = await run(query, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      bankBalance: {
        amountCents: 79500000,
        checkpointAmountCents: 75000000,
        checkpointSetAt: '2026-08-20T12:00:00.000Z',
      },
    });
    expect(context.bankBalanceService.getBankBalance).toHaveBeenCalledWith('user-1');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(query, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.bankBalanceService.getBankBalance).not.toHaveBeenCalled();
  });
});

describe('Mutation.setBankBalanceCheckpoint', () => {
  const mutation = 'mutation { setBankBalanceCheckpoint(amountCents: 7500000) { amountCents checkpointAmountCents } }';

  it('sets the checkpoint and returns the resulting balance', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      setBankBalanceCheckpoint: { amountCents: 79500000, checkpointAmountCents: 75000000 },
    });
    expect(context.bankBalanceService.setBankBalanceCheckpoint).toHaveBeenCalledWith('user-1', 7500000);
  });

  it('accepts a negative amountCents', async () => {
    const context = buildContext('user-1');

    const result = await run(
      'mutation { setBankBalanceCheckpoint(amountCents: -5000) { amountCents } }',
      context,
    );

    expect(result.errors).toBeUndefined();
    expect(context.bankBalanceService.setBankBalanceCheckpoint).toHaveBeenCalledWith('user-1', -5000);
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.bankBalanceService.setBankBalanceCheckpoint).not.toHaveBeenCalled();
  });

  it('maps invalid_amount to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.bankBalanceService.setBankBalanceCheckpoint as jest.Mock).mockImplementation(async () => {
      throw new BankBalanceServiceError('invalid_amount');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('INVALID_AMOUNT');
  });
});
