import { describe, expect, it, jest } from '@jest/globals';
import { graphql } from 'graphql';
import type { GraphQLContext } from '../../src/graphql/context.js';
import { createGraphQLLoaders, type GraphQLLoaderDeps } from '../../src/graphql/loaders.js';
import { schema } from '../../src/graphql/schema.js';

/**
 * schema.recurringExpenses.test.ts stubs `loaders: {} as never` and only
 * selects scalar fields, so it never exercises the RecurringExpenseTemplate/
 * RecurringExpenseInstance/Transaction field resolvers that wire
 * context.loaders.* into a response (schema.ts's `category`, `template`,
 * `transactions`, `paidThisMonth`, `month`, `recurringExpenseInstance`,
 * `categoryMonth` resolvers). This file builds a context with *real*
 * DataLoaders (backed by stubbed services) and selects those nested fields,
 * so a bug like swapping one loader for another would actually fail here.
 */

const category = { id: 'cat-1', name: 'Housing' };
const budgetMonth = { id: 'month-1', month: '2026-08' };
const categoryMonth = { id: 'cm-1', categoryId: category.id, monthId: budgetMonth.id };
const template = {
  id: 'tpl-1',
  name: 'Rent',
  amountCents: 80000,
  budgetType: 'need' as const,
  dueDay: 1,
  categoryId: category.id,
};
const instance = {
  id: 'inst-1',
  monthId: budgetMonth.id,
  amountCents: 80000,
  templateId: template.id,
};

function buildContext(overrides: {
  transactionsForInstance?: Array<{ id: string; amountCents: number }>;
} = {}): GraphQLContext {
  const transactionsForInstance =
    overrides.transactionsForInstance ??
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
      listByRecurringExpenseInstanceIds: jest.fn(async (ids: string[]) =>
        ids.includes(instance.id)
          ? transactionsForInstance.map((tx) => ({
              ...tx,
              recurringExpenseInstanceId: instance.id,
            }))
          : [],
      ),
    },
    templateService: {
      findManyByIds: jest.fn(async (ids: string[]) => (ids.includes(template.id) ? [template] : [])),
    },
    instanceService: {
      findManyByIds: jest.fn(async (ids: string[]) => (ids.includes(instance.id) ? [instance] : [])),
      sumCommittedCentsForCategoryMonth: jest.fn(async () => 0),
    },
  } as unknown as GraphQLLoaderDeps;

  return {
    userId: 'user-1',
    categoryService: {} as never,
    categoryMonthService: {} as never,
    transactionService: {} as never,
    templateService: {
      listCatalog: jest.fn(async () => [template]),
    } as never,
    instanceService: {
      listByMonth: jest.fn(async () => [instance]),
      markRecurringPaid: jest.fn(async () => ({
        id: 'tx-1',
        amountCents: 80000,
        date: new Date('2026-08-01'),
        merchant: null,
        note: null,
        direction: 'expense' as const,
        categoryMonthId: categoryMonth.id,
        recurringExpenseInstanceId: instance.id,
      })),
    } as never,
    loaders: createGraphQLLoaders(loaderDeps),
  };
}

describe('RecurringExpenseTemplate.category', () => {
  it('resolves the category via the categoryById loader', async () => {
    const context = buildContext();

    const result = await graphql({
      schema,
      source: '{ recurringExpenseTemplates { id category { id name } } }',
      contextValue: context,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      recurringExpenseTemplates: [{ id: 'tpl-1', category: { id: 'cat-1', name: 'Housing' } }],
    });
  });
});

describe('RecurringExpenseInstance nested fields', () => {
  const query = `
    {
      recurringExpenseInstances(month: "2026-08") {
        id
        month
        template { id name }
        transactions { id amountCents }
        paidThisMonth
      }
    }
  `;

  it('resolves month, template, and transactions via their DataLoaders', async () => {
    const context = buildContext();

    const result = await graphql({ schema, source: query, contextValue: context });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      recurringExpenseInstances: [
        {
          id: 'inst-1',
          month: '2026-08',
          template: { id: 'tpl-1', name: 'Rent' },
          transactions: [{ id: 'tx-1', amountCents: 80000 }],
          paidThisMonth: true,
        },
      ],
    });
  });

  it('paidThisMonth is false when the sum of linked transactions is below amountCents', async () => {
    const context = buildContext({ transactionsForInstance: [{ id: 'tx-1', amountCents: 40000 }] });

    const result = await graphql({ schema, source: query, contextValue: context });

    expect(result.errors).toBeUndefined();
    expect((result.data as { recurringExpenseInstances: Array<{ paidThisMonth: boolean }> })
      .recurringExpenseInstances[0]?.paidThisMonth).toBe(false);
  });
});

describe('Transaction.recurringExpenseInstance and Transaction.categoryMonth', () => {
  it("resolves markRecurringPaid's transaction back to its instance and categoryMonth via their loaders", async () => {
    const context = buildContext();

    const result = await graphql({
      schema,
      source: `
        mutation {
          markRecurringPaid(id: "inst-1", input: { amountCents: 80000, date: "2026-08-01" }) {
            id
            recurringExpenseInstance { id amountCents }
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
        recurringExpenseInstance: { id: 'inst-1', amountCents: 80000 },
        categoryMonth: { id: 'cm-1' },
      },
    });
  });
});
