import { describe, expect, it, jest } from '@jest/globals';
import { graphql } from 'graphql';
import type { GraphQLContext } from '../../src/graphql/context.js';
import { createGraphQLLoaders, type GraphQLLoaderDeps } from '../../src/graphql/loaders.js';
import { schema } from '../../src/graphql/schema.js';

/**
 * schema.recurringExpenses.test.ts stubs `loaders: {} as never` and only
 * selects scalar fields, so it never exercises the RecurringExpense/
 * Transaction field resolvers that wire context.loaders.* into a response
 * (schema.ts's `category`, `transactions`, `paidThisMonth`, `month`,
 * `recurringExpense`, `categoryMonth` resolvers). This file builds a
 * context with *real* DataLoaders (backed by stubbed services) and selects
 * those nested fields, so a bug like swapping one loader for another would
 * actually fail here.
 */

const category = { id: 'cat-1', name: 'Housing' };
const budgetMonth = { id: 'month-1', month: '2026-08' };
const categoryMonth = { id: 'cm-1', categoryId: category.id, monthId: budgetMonth.id };
const recurringExpense = {
  id: 'recurring-1',
  monthId: budgetMonth.id,
  name: 'Rent',
  amountCents: 80000,
  budgetType: 'need' as const,
  dueDay: 1,
  categoryId: category.id,
};

function buildContext(overrides: {
  transactionsForRecurringExpense?: Array<{ id: string; amountCents: number }>;
} = {}): GraphQLContext {
  const transactionsForRecurringExpense =
    overrides.transactionsForRecurringExpense ??
    [{ id: 'tx-1', amountCents: 80000 }];

  const loaderDeps: GraphQLLoaderDeps = {
    categoryService: {
      findManyByIds: jest.fn(async (ids: string[]) => (ids.includes(category.id) ? [category] : [])),
    },
    categoryMonthService: {
      findManyByIds: jest.fn(async (ids: string[]) =>
        ids.includes(categoryMonth.id) ? [categoryMonth] : [],
      ),
    },
    budgetMonthService: {
      findManyByIds: jest.fn(async (ids: string[]) =>
        ids.includes(budgetMonth.id) ? [budgetMonth] : [],
      ),
    },
    transactionService: {
      listByCategoryMonthIds: jest.fn(async () => []),
      listByRecurringExpenseIds: jest.fn(async (ids: string[]) =>
        ids.includes(recurringExpense.id)
          ? transactionsForRecurringExpense.map((tx) => ({
              ...tx,
              recurringExpenseId: recurringExpense.id,
            }))
          : [],
      ),
    },
    recurringExpenseService: {
      findManyByIds: jest.fn(async (ids: string[]) =>
        ids.includes(recurringExpense.id) ? [recurringExpense] : [],
      ),
      sumCommittedCentsForCategoryMonth: jest.fn(async () => 0),
    },
  } as unknown as GraphQLLoaderDeps;

  return {
    userId: 'user-1',
    categoryService: {} as never,
    categoryMonthService: {} as never,
    budgetMonthService: {} as never,
    transactionService: {} as never,
    recurringExpenseService: {
      listByMonth: jest.fn(async () => [recurringExpense]),
      markRecurringPaid: jest.fn(async () => ({
        id: 'tx-1',
        amountCents: 80000,
        date: new Date('2026-08-01'),
        merchant: null,
        note: null,
        direction: 'expense' as const,
        categoryMonthId: categoryMonth.id,
        recurringExpenseId: recurringExpense.id,
      })),
    } as never,
    savingsFundService: {} as never,
    savingsMovementService: {} as never,
    bankBalanceService: {} as never,
    loaders: createGraphQLLoaders(loaderDeps),
  };
}

describe('RecurringExpense nested fields', () => {
  const query = `
    {
      recurringExpenses(month: "2026-08") {
        id
        month
        dueDate
        category { id name }
        transactions { id amountCents }
        paidThisMonth
      }
    }
  `;

  it('resolves month, category, and transactions via their DataLoaders', async () => {
    const context = buildContext();

    const result = await graphql({ schema, source: query, contextValue: context });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      recurringExpenses: [
        {
          id: 'recurring-1',
          month: '2026-08',
          dueDate: '2026-08-01',
          category: { id: 'cat-1', name: 'Housing' },
          transactions: [{ id: 'tx-1', amountCents: 80000 }],
          paidThisMonth: true,
        },
      ],
    });
  });

  it("dueDate clamps dueDay to the row's month's last day when it doesn't fit (e.g. day 31 in a 28-day month)", async () => {
    const shortMonth = { id: 'month-2', month: '2026-02' };
    const context = buildContext();
    context.recurringExpenseService = {
      listByMonth: jest.fn(async () => [{ ...recurringExpense, monthId: shortMonth.id, dueDay: 31 }]),
    } as never;
    context.loaders = createGraphQLLoaders({
      categoryService: {
        findManyByIds: jest.fn(async (ids: string[]) => (ids.includes(category.id) ? [category] : [])),
      },
      categoryMonthService: { findManyByIds: jest.fn(async () => []) },
      budgetMonthService: {
        findManyByIds: jest.fn(async (ids: string[]) =>
          ids.includes(shortMonth.id) ? [shortMonth] : [],
        ),
      },
      transactionService: {
        listByCategoryMonthIds: jest.fn(async () => []),
        listByRecurringExpenseIds: jest.fn(async () => []),
      },
      recurringExpenseService: {
        findManyByIds: jest.fn(async () => []),
        sumCommittedCentsForCategoryMonth: jest.fn(async () => 0),
      },
    } as unknown as GraphQLLoaderDeps);

    const result = await graphql({ schema, source: query, contextValue: context });

    expect(result.errors).toBeUndefined();
    expect((result.data as { recurringExpenses: Array<{ dueDate: string }> })
      .recurringExpenses[0]?.dueDate).toBe('2026-02-28');
  });

  it('paidThisMonth is false when the sum of linked transactions is below amountCents', async () => {
    const context = buildContext({ transactionsForRecurringExpense: [{ id: 'tx-1', amountCents: 40000 }] });

    const result = await graphql({ schema, source: query, contextValue: context });

    expect(result.errors).toBeUndefined();
    expect((result.data as { recurringExpenses: Array<{ paidThisMonth: boolean }> })
      .recurringExpenses[0]?.paidThisMonth).toBe(false);
  });
});

describe('Transaction.recurringExpense and Transaction.categoryMonth', () => {
  it("resolves markRecurringPaid's transaction back to its recurring expense and categoryMonth via their loaders", async () => {
    const context = buildContext();

    const result = await graphql({
      schema,
      source: `
        mutation {
          markRecurringPaid(id: "recurring-1", input: { amountCents: 80000, date: "2026-08-01" }) {
            id
            recurringExpense { id amountCents }
            categoryMonth { id }
          }
        }
      `,
      contextValue: context,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      markRecurringPaid: {
        id: 'tx-1',
        recurringExpense: { id: 'recurring-1', amountCents: 80000 },
        categoryMonth: { id: 'cm-1' },
      },
    });
  });
});
