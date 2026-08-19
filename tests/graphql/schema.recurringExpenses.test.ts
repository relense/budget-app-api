import { describe, expect, it, jest } from '@jest/globals';
import { graphql } from 'graphql';
import type { GraphQLContext } from '../../src/graphql/context.js';
import { RecurringExpenseInstanceServiceError } from '../../src/services/recurringExpenses/recurringExpenseInstanceService.js';
import { RecurringExpenseTemplateServiceError } from '../../src/services/recurringExpenses/recurringExpenseTemplateService.js';
import { schema } from '../../src/graphql/schema.js';

const template = {
  id: 'tpl-1',
  name: 'Rent',
  amountCents: 80000,
  budgetType: 'need' as const,
  dueDay: 1,
  categoryId: 'cat-1',
};

const instance = {
  id: 'inst-1',
  monthId: 'month-1',
  amountCents: 80000,
  templateId: template.id,
};

const transaction = {
  id: 'tx-1',
  amountCents: 80000,
  date: new Date('2026-08-01'),
  merchant: 'Landlord',
  note: null,
  direction: 'expense' as const,
  categoryMonthId: 'cm-1',
  recurringExpenseInstanceId: instance.id,
};

function buildContext(userId: string | null): GraphQLContext {
  return {
    userId,
    categoryService: {} as never,
    categoryMonthService: {} as never,
    transactionService: {} as never,
    templateService: {
      listCatalog: jest.fn(async () => [template]),
      updateTemplate: jest.fn(async () => template),
      deleteTemplate: jest.fn(async () => undefined),
    } as never,
    instanceService: {
      listByMonth: jest.fn(async () => [instance]),
      createTemplateForMonth: jest.fn(async () => ({ template, instance })),
      addRecurringExpenseToMonth: jest.fn(async () => instance),
      updateInstance: jest.fn(async () => instance),
      removeFromMonth: jest.fn(async () => undefined),
      markRecurringPaid: jest.fn(async () => transaction),
    } as never,
    loaders: {} as never,
  };
}

async function run(source: string, contextValue: GraphQLContext) {
  return graphql({ schema, source, contextValue });
}

describe('Query.recurringExpenseTemplates', () => {
  const query = '{ recurringExpenseTemplates { id name amountCents budgetType dueDay } }';

  it('returns the catalog for the authenticated user', async () => {
    const context = buildContext('user-1');

    const result = await run(query, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      recurringExpenseTemplates: [
        { id: 'tpl-1', name: 'Rent', amountCents: 80000, budgetType: 'NEED', dueDay: 1 },
      ],
    });
    expect(context.templateService.listCatalog).toHaveBeenCalledWith('user-1');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(query, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.templateService.listCatalog).not.toHaveBeenCalled();
  });
});

describe('Query.recurringExpenseInstances', () => {
  const query = '{ recurringExpenseInstances(month: "2026-08") { id amountCents } }';

  it('returns instances for the given month, scoped to the authenticated user', async () => {
    const context = buildContext('user-1');

    const result = await run(query, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ recurringExpenseInstances: [{ id: 'inst-1', amountCents: 80000 }] });
    expect(context.instanceService.listByMonth).toHaveBeenCalledWith('user-1', '2026-08');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(query, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.instanceService.listByMonth).not.toHaveBeenCalled();
  });
});

describe('Mutation.createRecurringExpenseTemplate', () => {
  const mutation = `
    mutation {
      createRecurringExpenseTemplate(
        input: { name: "Rent", amountCents: 80000, categoryId: "cat-1", budgetType: NEED, dueDay: 1 }
        month: "2026-08"
        categoryMonthlyBudgetCents: 90000
      ) { id name amountCents budgetType dueDay }
    }
  `;

  it('creates the template for the given month and returns it', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      createRecurringExpenseTemplate: {
        id: 'tpl-1',
        name: 'Rent',
        amountCents: 80000,
        budgetType: 'NEED',
        dueDay: 1,
      },
    });
    expect(context.instanceService.createTemplateForMonth).toHaveBeenCalledWith(
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
    expect(context.instanceService.createTemplateForMonth).not.toHaveBeenCalled();
  });

  it('maps a service error to a GraphQLError with a matching extensions.code', async () => {
    const context = buildContext('user-1');
    (context.instanceService.createTemplateForMonth as jest.Mock).mockImplementation(async () => {
      throw new RecurringExpenseTemplateServiceError('invalid_category_direction');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('INVALID_CATEGORY_DIRECTION');
  });
});

describe('Mutation.updateRecurringExpenseTemplate', () => {
  const mutation = `
    mutation {
      updateRecurringExpenseTemplate(
        id: "tpl-1"
        input: { name: "Rent", amountCents: 85000, categoryId: "cat-1", budgetType: WANT, dueDay: 5 }
      ) { id }
    }
  `;

  it('updates the template and returns it', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(context.templateService.updateTemplate).toHaveBeenCalledWith('user-1', 'tpl-1', {
      name: 'Rent',
      amountCents: 85000,
      categoryId: 'cat-1',
      budgetType: 'want',
      dueDay: 5,
    });
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.templateService.updateTemplate).not.toHaveBeenCalled();
  });

  it('maps template_not_found to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.templateService.updateTemplate as jest.Mock).mockImplementation(async () => {
      throw new RecurringExpenseTemplateServiceError('template_not_found');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('TEMPLATE_NOT_FOUND');
  });
});

describe('Mutation.deleteRecurringExpenseTemplate', () => {
  const mutation = 'mutation { deleteRecurringExpenseTemplate(id: "tpl-1") }';

  it('deletes the template and returns true', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ deleteRecurringExpenseTemplate: true });
    expect(context.templateService.deleteTemplate).toHaveBeenCalledWith('user-1', 'tpl-1');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.templateService.deleteTemplate).not.toHaveBeenCalled();
  });

  it('maps template_has_active_instances to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.templateService.deleteTemplate as jest.Mock).mockImplementation(async () => {
      throw new RecurringExpenseTemplateServiceError('template_has_active_instances');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('TEMPLATE_HAS_ACTIVE_INSTANCES');
  });
});

describe('Mutation.addRecurringExpenseToMonth', () => {
  const mutation = `
    mutation {
      addRecurringExpenseToMonth(templateId: "tpl-1", month: "2026-08", categoryMonthlyBudgetCents: 90000)
      { id amountCents }
    }
  `;

  it('adds the template to the given month and returns the instance', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ addRecurringExpenseToMonth: { id: 'inst-1', amountCents: 80000 } });
    expect(context.instanceService.addRecurringExpenseToMonth).toHaveBeenCalledWith(
      'user-1',
      'tpl-1',
      '2026-08',
      90000,
    );
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.instanceService.addRecurringExpenseToMonth).not.toHaveBeenCalled();
  });

  it('maps instance_already_active to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.instanceService.addRecurringExpenseToMonth as jest.Mock).mockImplementation(async () => {
      throw new RecurringExpenseInstanceServiceError('instance_already_active');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('INSTANCE_ALREADY_ACTIVE');
  });
});

describe('Mutation.updateRecurringExpenseInstance', () => {
  const mutation = 'mutation { updateRecurringExpenseInstance(id: "inst-1", amountCents: 4500) { id } }';

  it('updates the instance amount', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(context.instanceService.updateInstance).toHaveBeenCalledWith('user-1', 'inst-1', 4500);
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.instanceService.updateInstance).not.toHaveBeenCalled();
  });

  it('maps invalid_amount to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.instanceService.updateInstance as jest.Mock).mockImplementation(async () => {
      throw new RecurringExpenseInstanceServiceError('invalid_amount');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('INVALID_AMOUNT');
  });
});

describe('Mutation.removeRecurringExpenseFromMonth', () => {
  const mutation = 'mutation { removeRecurringExpenseFromMonth(id: "inst-1") }';

  it('removes the instance and returns true', async () => {
    const context = buildContext('user-1');

    const result = await run(mutation, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ removeRecurringExpenseFromMonth: true });
    expect(context.instanceService.removeFromMonth).toHaveBeenCalledWith('user-1', 'inst-1');
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.instanceService.removeFromMonth).not.toHaveBeenCalled();
  });

  it('maps instance_has_transactions to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.instanceService.removeFromMonth as jest.Mock).mockImplementation(async () => {
      throw new RecurringExpenseInstanceServiceError('instance_has_transactions');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('INSTANCE_HAS_TRANSACTIONS');
  });
});

describe('Mutation.markRecurringPaid', () => {
  const mutation = `
    mutation {
      markRecurringPaid(
        id: "inst-1"
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
    expect(context.instanceService.markRecurringPaid).toHaveBeenCalledWith('user-1', 'inst-1', {
      amountCents: 80000,
      date: '2026-08-01',
      merchant: 'Landlord',
      note: undefined,
    });
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const context = buildContext(null);

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(context.instanceService.markRecurringPaid).not.toHaveBeenCalled();
  });

  it('maps month_locked to a GraphQLError', async () => {
    const context = buildContext('user-1');
    (context.instanceService.markRecurringPaid as jest.Mock).mockImplementation(async () => {
      throw new RecurringExpenseInstanceServiceError('month_locked');
    });

    const result = await run(mutation, context);

    expect(result.errors?.[0]?.extensions?.code).toBe('MONTH_LOCKED');
  });
});
