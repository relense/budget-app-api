import type { BudgetType, Direction } from '../services/categories/categoryService.js';

export type GraphQLBudgetType = 'NEED' | 'WANT' | 'SAVINGS';
export type GraphQLDirection = 'EXPENSE' | 'INCOME';

const BUDGET_TYPE_TO_DB: Record<GraphQLBudgetType, BudgetType> = {
  NEED: 'need',
  WANT: 'want',
  SAVINGS: 'savings',
};

const BUDGET_TYPE_TO_GRAPHQL: Record<BudgetType, GraphQLBudgetType> = {
  need: 'NEED',
  want: 'WANT',
  savings: 'SAVINGS',
};

const DIRECTION_TO_DB: Record<GraphQLDirection, Direction> = {
  EXPENSE: 'expense',
  INCOME: 'income',
};

const DIRECTION_TO_GRAPHQL: Record<Direction, GraphQLDirection> = {
  expense: 'EXPENSE',
  income: 'INCOME',
};

export function budgetTypeToDb(value: GraphQLBudgetType | null | undefined): BudgetType | undefined {
  return value ? BUDGET_TYPE_TO_DB[value] : undefined;
}

/** For inputs where budgetType is non-null in the GraphQL schema (e.g. RecurringExpenseInput). */
export function budgetTypeToDbRequired(value: GraphQLBudgetType): BudgetType {
  return BUDGET_TYPE_TO_DB[value];
}

export function budgetTypeToGraphQL(value: BudgetType | null): GraphQLBudgetType | null {
  return value === null ? null : BUDGET_TYPE_TO_GRAPHQL[value];
}

export function directionToDb(value: GraphQLDirection): Direction {
  return DIRECTION_TO_DB[value];
}

export function directionToGraphQL(value: Direction): GraphQLDirection {
  return DIRECTION_TO_GRAPHQL[value];
}
