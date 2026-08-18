import type { BudgetType, Direction } from '../services/categories/categoryService.js';

export type GraphQLBudgetType = 'PRECISO' | 'QUERO' | 'POUPANCA';
export type GraphQLDirection = 'EXPENSE' | 'INCOME';

const BUDGET_TYPE_TO_DB: Record<GraphQLBudgetType, BudgetType> = {
  PRECISO: 'preciso',
  QUERO: 'quero',
  POUPANCA: 'poupanca',
};

const BUDGET_TYPE_TO_GRAPHQL: Record<BudgetType, GraphQLBudgetType> = {
  preciso: 'PRECISO',
  quero: 'QUERO',
  poupanca: 'POUPANCA',
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

export function budgetTypeToGraphQL(value: BudgetType | null): GraphQLBudgetType | null {
  return value === null ? null : BUDGET_TYPE_TO_GRAPHQL[value];
}

export function directionToDb(value: GraphQLDirection): Direction {
  return DIRECTION_TO_DB[value];
}

export function directionToGraphQL(value: Direction): GraphQLDirection {
  return DIRECTION_TO_GRAPHQL[value];
}
