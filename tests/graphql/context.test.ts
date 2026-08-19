import { describe, expect, it } from '@jest/globals';
import { createGraphQLContextBuilder, type GraphQLContextBuilderDeps } from '../../src/graphql/context.js';

function buildDeps(): GraphQLContextBuilderDeps {
  return {
    categoryService: {} as never,
    categoryMonthService: {} as never,
    budgetMonthService: {} as never,
    transactionService: {} as never,
    recurringExpenseService: {} as never,
  };
}

describe('createGraphQLContextBuilder', () => {
  it('carries the given userId through to the context', () => {
    const buildContext = createGraphQLContextBuilder(buildDeps());

    expect(buildContext('user-1').userId).toBe('user-1');
    expect(buildContext(null).userId).toBeNull();
  });

  it('shares the same service instances across calls (stateless, request-independent)', () => {
    const deps = buildDeps();
    const buildContext = createGraphQLContextBuilder(deps);

    const first = buildContext('user-1');
    const second = buildContext('user-2');

    expect(first.recurringExpenseService).toBe(deps.recurringExpenseService);
    expect(first.recurringExpenseService).toBe(second.recurringExpenseService);
  });

  it('builds a fresh loaders instance per call, so no cache can leak across requests', () => {
    const buildContext = createGraphQLContextBuilder(buildDeps());

    const first = buildContext('user-1');
    const second = buildContext('user-1');

    expect(first.loaders).not.toBe(second.loaders);
    expect(first.loaders.categoryById).not.toBe(second.loaders.categoryById);
  });
});
