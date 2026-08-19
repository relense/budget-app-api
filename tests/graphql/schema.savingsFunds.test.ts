import { describe, expect, it, jest } from '@jest/globals';
import { graphql } from 'graphql';
import type { GraphQLContext } from '../../src/graphql/context.js';
import { SavingsFundServiceError } from '../../src/services/savings/savingsFundService.js';
import { SavingsMovementServiceError } from '../../src/services/savings/savingsMovementService.js';
import { schema } from '../../src/graphql/schema.js';

const fund = {
  id: 'fund-1',
  name: 'Wedding',
  targetAmountCents: 500000,
  initialBalanceCents: 100000,
  startDate: null,
  endDate: null,
  monthlyTargetCents: null,
};

const movement = {
  id: 'movement-1',
  fundId: fund.id,
  amountCents: 10000,
  type: 'deposit' as const,
  date: new Date('2026-08-01'),
};

function buildContext(userId: string | null): GraphQLContext {
  return {
    userId,
    categoryService: {} as never,
    categoryMonthService: {} as never,
    budgetMonthService: {} as never,
    transactionService: {} as never,
    recurringExpenseService: {} as never,
    savingsFundService: {
      listCatalog: jest.fn(async () => [fund]),
      createSavingsFund: jest.fn(async () => fund),
      updateSavingsFund: jest.fn(async () => fund),
      deleteSavingsFund: jest.fn(async () => undefined),
    } as never,
    savingsMovementService: {
      createSavingsMovement: jest.fn(async () => movement),
      updateSavingsMovement: jest.fn(async () => movement),
      deleteSavingsMovement: jest.fn(async () => undefined),
    } as never,
    loaders: {} as never,
  };
}

async function run(source: string, contextValue: GraphQLContext) {
  return graphql({ schema, source, contextValue });
}

describe('Query.savingsFunds', () => {
  const query = '{ savingsFunds { id name targetAmountCents initialBalanceCents } }';

  it('returns the catalog for the authenticated user', async () => {
    const context = buildContext('user-1');

    const result = await run(query, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      savingsFunds: [{ id: 'fund-1', name: 'Wedding', targetAmountCents: 500000, initialBalanceCents: 100000 }],
    });
    expect(context.savingsFundService.listCatalog).toHaveBeenCalledWith('user-1');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(query, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.savingsFundService.listCatalog).not.toHaveBeenCalled();
  });
});

describe('Mutation.createSavingsFund', () => {
  const mutation = `
    mutation {
      createSavingsFund(
        input: { name: "Wedding", targetAmountCents: 500000, initialBalanceCents: 100000 }
      ) { id name }
    }
  `;

  it('creates the fund and returns it', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ createSavingsFund: { id: 'fund-1', name: 'Wedding' } });
    expect(context.savingsFundService.createSavingsFund).toHaveBeenCalledWith('user-1', {
      name: 'Wedding',
      targetAmountCents: 500000,
      initialBalanceCents: 100000,
      startDate: undefined,
      endDate: undefined,
      monthlyTargetCents: undefined,
    });
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.savingsFundService.createSavingsFund).not.toHaveBeenCalled();
  });

  it('maps a service error to a GraphQLError with a matching extensions.code', async () => {
    const context = buildContext('user-1');
    (context.savingsFundService.createSavingsFund as jest.Mock).mockImplementation(async () => {
      throw new SavingsFundServiceError('invalid_date_range');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('INVALID_DATE_RANGE');
  });
});

describe('Mutation.updateSavingsFund', () => {
  const mutation = 'mutation { updateSavingsFund(id: "fund-1", input: { name: "Wedding Fund" }) { id } }';

  it('updates the fund and returns it', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(context.savingsFundService.updateSavingsFund).toHaveBeenCalledWith('user-1', 'fund-1', {
      name: 'Wedding Fund',
      targetAmountCents: undefined,
      startDate: undefined,
      endDate: undefined,
      monthlyTargetCents: undefined,
    });
  });

  it('maps fund_not_found to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.savingsFundService.updateSavingsFund as jest.Mock).mockImplementation(async () => {
      throw new SavingsFundServiceError('fund_not_found');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('FUND_NOT_FOUND');
  });
});

describe('Mutation.deleteSavingsFund', () => {
  const mutation = 'mutation { deleteSavingsFund(id: "fund-1") }';

  it('deletes the fund and returns true', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ deleteSavingsFund: true });
    expect(context.savingsFundService.deleteSavingsFund).toHaveBeenCalledWith('user-1', 'fund-1');
  });

  it('maps fund_has_movements to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.savingsFundService.deleteSavingsFund as jest.Mock).mockImplementation(async () => {
      throw new SavingsFundServiceError('fund_has_movements');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('FUND_HAS_MOVEMENTS');
  });
});

describe('Mutation.createSavingsMovement', () => {
  const mutation = `
    mutation {
      createSavingsMovement(
        input: { fundId: "fund-1", amountCents: 10000, type: DEPOSIT, date: "2026-08-01" }
      ) { id amountCents type date }
    }
  `;

  it('creates the movement and returns it', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      createSavingsMovement: { id: 'movement-1', amountCents: 10000, type: 'DEPOSIT', date: '2026-08-01' },
    });
    expect(context.savingsMovementService.createSavingsMovement).toHaveBeenCalledWith('user-1', {
      fundId: 'fund-1',
      amountCents: 10000,
      type: 'deposit',
      date: '2026-08-01',
    });
  });

  it('maps insufficient_funds to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.savingsMovementService.createSavingsMovement as jest.Mock).mockImplementation(async () => {
      throw new SavingsMovementServiceError('insufficient_funds');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('INSUFFICIENT_FUNDS');
  });
});

describe('Mutation.updateSavingsMovement', () => {
  const mutation = `
    mutation {
      updateSavingsMovement(
        id: "movement-1"
        input: { amountCents: 12000, type: DEPOSIT, date: "2026-08-02" }
      ) { id }
    }
  `;

  it('updates the movement and returns it', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(context.savingsMovementService.updateSavingsMovement).toHaveBeenCalledWith('user-1', 'movement-1', {
      amountCents: 12000,
      type: 'deposit',
      date: '2026-08-02',
    });
  });

  it('maps movement_not_found to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.savingsMovementService.updateSavingsMovement as jest.Mock).mockImplementation(async () => {
      throw new SavingsMovementServiceError('movement_not_found');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('MOVEMENT_NOT_FOUND');
  });
});

describe('Mutation.deleteSavingsMovement', () => {
  const mutation = 'mutation { deleteSavingsMovement(id: "movement-1") }';

  it('deletes the movement and returns true', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ deleteSavingsMovement: true });
    expect(context.savingsMovementService.deleteSavingsMovement).toHaveBeenCalledWith('user-1', 'movement-1');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.savingsMovementService.deleteSavingsMovement).not.toHaveBeenCalled();
  });

  it('maps movement_not_found to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.savingsMovementService.deleteSavingsMovement as jest.Mock).mockImplementation(async () => {
      throw new SavingsMovementServiceError('movement_not_found');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('MOVEMENT_NOT_FOUND');
  });
});
