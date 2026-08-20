import { describe, expect, it, jest } from '@jest/globals';
import { graphql } from 'graphql';
import type { GraphQLContext } from '../../src/graphql/context.js';
import { CategoryServiceError } from '../../src/services/categories/categoryService.js';
import { CategoryMonthServiceError } from '../../src/services/categories/categoryMonthService.js';
import { schema } from '../../src/graphql/schema.js';

const category = {
  id: 'cat-1',
  name: 'Groceries',
  icon: 'cart',
  color: '#00FF00',
  budgetType: 'need' as const,
  direction: 'expense' as const,
};

const categoryMonth = {
  id: 'cm-1',
  categoryId: 'cat-1',
  monthId: 'month-1',
  monthlyBudgetCents: 10000,
};

function buildContext(userId: string | null): GraphQLContext {
  return {
    userId,
    categoryService: {
      listCatalog: jest.fn(async () => [category]),
      createCategory: jest.fn(async () => category),
      updateCategory: jest.fn(async () => category),
      deleteCategory: jest.fn(async () => undefined),
    } as never,
    categoryMonthService: {
      addCategoryToMonth: jest.fn(async () => categoryMonth),
      listByMonth: jest.fn(async () => [categoryMonth]),
      removeCategoryFromMonth: jest.fn(async () => undefined),
      updateCategoryMonthBudget: jest.fn(async () => categoryMonth),
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

describe('Query.categories', () => {
  const query = '{ categories { id name } }';

  it('returns the catalog for the authenticated user', async () => {
    const context = buildContext('user-1');

    const result = await run(query, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ categories: [{ id: 'cat-1', name: 'Groceries' }] });
    expect(context.categoryService.listCatalog).toHaveBeenCalledWith('user-1');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(query, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.categoryService.listCatalog).not.toHaveBeenCalled();
  });
});

describe('Mutation.createCategory', () => {
  const mutation =
    'mutation { createCategory(input: { name: "Groceries", icon: "cart", color: "#00FF00", budgetType: NEED, direction: EXPENSE }) { id name } }';

  it('creates the category and returns it', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ createCategory: { id: 'cat-1', name: 'Groceries' } });
    expect(context.categoryService.createCategory).toHaveBeenCalledWith('user-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: 'need',
      direction: 'expense',
    });
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.categoryService.createCategory).not.toHaveBeenCalled();
  });

  it('maps a service error to a GraphQLError with a matching extensions.code', async () => {
    const context = buildContext('user-1');
    (context.categoryService.createCategory as jest.Mock).mockImplementation(async () => {
      throw new CategoryServiceError('budget_type_required_for_expense');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('BUDGET_TYPE_REQUIRED_FOR_EXPENSE');
  });
});

describe('Mutation.updateCategory', () => {
  const mutation =
    'mutation { updateCategory(id: "cat-1", input: { name: "Groceries", icon: "cart", color: "#00FF00", direction: EXPENSE }) { id } }';

  it('updates the category and returns it', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(context.categoryService.updateCategory).toHaveBeenCalledWith('user-1', 'cat-1', {
      name: 'Groceries',
      icon: 'cart',
      color: '#00FF00',
      budgetType: undefined,
      direction: 'expense',
    });
  });

  it('maps category_not_found to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.categoryService.updateCategory as jest.Mock).mockImplementation(async () => {
      throw new CategoryServiceError('category_not_found');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('CATEGORY_NOT_FOUND');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.categoryService.updateCategory).not.toHaveBeenCalled();
  });
});

describe('Mutation.deleteCategory', () => {
  const mutation = 'mutation { deleteCategory(id: "cat-1") }';

  it('deletes the category and returns true', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ deleteCategory: true });
    expect(context.categoryService.deleteCategory).toHaveBeenCalledWith('user-1', 'cat-1');
  });

  it('maps category_has_active_months to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.categoryService.deleteCategory as jest.Mock).mockImplementation(async () => {
      throw new CategoryServiceError('category_has_active_months');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('CATEGORY_HAS_ACTIVE_MONTHS');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.categoryService.deleteCategory).not.toHaveBeenCalled();
  });
});

describe('Mutation.removeCategoryFromMonth', () => {
  const mutation = 'mutation { removeCategoryFromMonth(categoryMonthId: "cm-1") }';

  it('removes the category from the month and returns true', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ removeCategoryFromMonth: true });
    expect(context.categoryMonthService.removeCategoryFromMonth).toHaveBeenCalledWith('user-1', 'cm-1');
  });

  it('maps category_month_has_transactions to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.categoryMonthService.removeCategoryFromMonth as jest.Mock).mockImplementation(async () => {
      throw new CategoryMonthServiceError('category_month_has_transactions');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('CATEGORY_MONTH_HAS_TRANSACTIONS');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.categoryMonthService.removeCategoryFromMonth).not.toHaveBeenCalled();
  });
});

describe('Mutation.updateCategoryMonthBudget', () => {
  const mutation = 'mutation { updateCategoryMonthBudget(categoryMonthId: "cm-1", monthlyBudgetCents: 20000) { id } }';

  it('updates the budget and returns the categoryMonth', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(context.categoryMonthService.updateCategoryMonthBudget).toHaveBeenCalledWith(
      'user-1',
      'cm-1',
      20000,
    );
  });

  it('maps category_month_not_found to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.categoryMonthService.updateCategoryMonthBudget as jest.Mock).mockImplementation(async () => {
      throw new CategoryMonthServiceError('category_month_not_found');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('CATEGORY_MONTH_NOT_FOUND');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.categoryMonthService.updateCategoryMonthBudget).not.toHaveBeenCalled();
  });
});
