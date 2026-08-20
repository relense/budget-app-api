import { describe, expect, it, jest } from '@jest/globals';
import { graphql } from 'graphql';
import type { GraphQLContext } from '../../src/graphql/context.js';
import { createGraphQLLoaders, type GraphQLLoaderDeps } from '../../src/graphql/loaders.js';
import { schema } from '../../src/graphql/schema.js';

/**
 * schema.savingsFunds.test.ts stubs loaders: {} as never and only selects
 * scalar fields, so it never exercises the SavingsFund/SavingsMovement
 * field resolvers that wire context.loaders.* into a response
 * (currentAmountCents, achieved, movements, fund). This file builds a
 * context with *real* DataLoaders (backed by stubbed services) and selects
 * those nested fields, so a bug like swapping one loader for another would
 * actually fail here.
 */

const fund = {
  id: 'fund-1',
  name: 'Wedding',
  targetAmountCents: 500000,
  initialBalanceCents: 100000,
  startDate: null,
  endDate: null,
  monthlyTargetCents: null,
};

function buildContext(overrides: {
  movementsForFund?: Array<{ id: string; fundId: string; amountCents: number; type: 'deposit' | 'withdraw'; date: Date }>;
  savingsFundByIdMissesEveryId?: boolean;
} = {}): GraphQLContext {
  const movementsForFund = overrides.movementsForFund ?? [
    { id: 'movement-1', fundId: fund.id, amountCents: 20000, type: 'deposit' as const, date: new Date('2026-08-01') },
  ];

  const loaderDeps: GraphQLLoaderDeps = {
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
    savingsFundService: {
      findManyByIds: jest.fn(async (ids: string[]) =>
        overrides.savingsFundByIdMissesEveryId ? [] : ids.includes(fund.id) ? [fund] : [],
      ),
    },
    savingsMovementService: {
      listByFundIds: jest.fn(async (ids: string[]) =>
        ids.includes(fund.id) ? movementsForFund : [],
      ),
      computeCurrentAmountCents: jest.fn(async (_fundId: string, initialBalanceCents: number) => {
        const net = movementsForFund.reduce(
          (sum, m) => sum + (m.type === 'deposit' ? m.amountCents : -m.amountCents),
          0,
        );
        return initialBalanceCents + net;
      }),
    },
  } as unknown as GraphQLLoaderDeps;

  return {
    userId: 'user-1',
    categoryService: {} as never,
    categoryMonthService: {} as never,
    budgetMonthService: {} as never,
    transactionService: {} as never,
    recurringExpenseService: {} as never,
    savingsFundService: {
      listCatalog: jest.fn(async () => [fund]),
    } as never,
    savingsMovementService: {} as never,
    bankBalanceService: {} as never,
    loaders: createGraphQLLoaders(loaderDeps),
  };
}

describe('SavingsFund nested fields', () => {
  const query = `
    {
      savingsFunds {
        id
        currentAmountCents
        achieved
        movements { id amountCents }
      }
    }
  `;

  it('resolves currentAmountCents and movements via their DataLoaders', async () => {
    const context = buildContext();

    const result = await graphql({ schema, source: query, contextValue: context });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      savingsFunds: [
        {
          id: 'fund-1',
          currentAmountCents: 120000, // 100000 initial + 20000 deposit
          achieved: false, // target is 500000
          movements: [{ id: 'movement-1', amountCents: 20000 }],
        },
      ],
    });
  });

  it('achieved is true once currentAmountCents reaches targetAmountCents', async () => {
    const context = buildContext({
      movementsForFund: [
        { id: 'movement-1', fundId: fund.id, amountCents: 400000, type: 'deposit', date: new Date('2026-08-01') },
      ],
    });

    const result = await graphql({ schema, source: query, contextValue: context });

    expect(result.errors).toBeUndefined();
    const data = result.data as { savingsFunds: Array<{ achieved: boolean; currentAmountCents: number }> };
    expect(data.savingsFunds[0]?.currentAmountCents).toBe(500000);
    expect(data.savingsFunds[0]?.achieved).toBe(true);
  });

  it('achieved is false without a target, regardless of currentAmountCents (no-target short-circuit)', async () => {
    const context = buildContext({
      movementsForFund: [
        { id: 'movement-1', fundId: fund.id, amountCents: 999999, type: 'deposit', date: new Date('2026-08-01') },
      ],
    });
    (context.savingsFundService.listCatalog as jest.Mock).mockImplementation(async () => [
      { ...fund, targetAmountCents: null },
    ]);

    const result = await graphql({ schema, source: query, contextValue: context });

    expect(result.errors).toBeUndefined();
    const data = result.data as { savingsFunds: Array<{ achieved: boolean }> };
    expect(data.savingsFunds[0]?.achieved).toBe(false);
  });
});

describe('SavingsMovement.fund', () => {
  it("resolves a movement's fund via the savingsFundById loader", async () => {
    const context = buildContext();

    const result = await graphql({
      schema,
      source: '{ savingsFunds { movements { id fund { id name } } } }',
      contextValue: context,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      savingsFunds: [{ movements: [{ id: 'movement-1', fund: { id: 'fund-1', name: 'Wedding' } }] }],
    });
  });

  it('throws a data integrity error when the movement references a fund the loader cannot find', async () => {
    const context = buildContext({ savingsFundByIdMissesEveryId: true });

    const result = await graphql({
      schema,
      source: '{ savingsFunds { movements { id fund { id } } } }',
      contextValue: context,
    });

    expect(result.errors?.[0]?.message).toMatch(/Data integrity error: SavingsFund fund-1 not found/);
  });
});
