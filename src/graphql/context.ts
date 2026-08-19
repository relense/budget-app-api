import type { BudgetMonthService } from '../services/budgetMonths/budgetMonthService.js';
import type { CategoryMonthService } from '../services/categories/categoryMonthService.js';
import type { CategoryService } from '../services/categories/categoryService.js';
import type { TransactionService } from '../services/categories/transactionService.js';
import type { RecurringExpenseInstanceService } from '../services/recurringExpenses/recurringExpenseInstanceService.js';
import type { RecurringExpenseTemplateService } from '../services/recurringExpenses/recurringExpenseTemplateService.js';
import { createGraphQLLoaders, type GraphQLLoaders } from './loaders.js';

export interface GraphQLContext {
  userId: string | null;
  categoryService: CategoryService;
  categoryMonthService: CategoryMonthService;
  transactionService: TransactionService;
  templateService: RecurringExpenseTemplateService;
  instanceService: RecurringExpenseInstanceService;
  loaders: GraphQLLoaders;
}

export interface GraphQLContextBuilderDeps {
  categoryService: CategoryService;
  categoryMonthService: CategoryMonthService;
  budgetMonthService: BudgetMonthService;
  transactionService: TransactionService;
  templateService: RecurringExpenseTemplateService;
  instanceService: RecurringExpenseInstanceService;
}

/**
 * The services are stateless and shared across requests; only the
 * DataLoaders are rebuilt per call, so their cache never leaks across
 * requests (or users).
 */
export function createGraphQLContextBuilder(deps: GraphQLContextBuilderDeps) {
  return function buildContext(userId: string | null): GraphQLContext {
    return {
      userId,
      categoryService: deps.categoryService,
      categoryMonthService: deps.categoryMonthService,
      transactionService: deps.transactionService,
      templateService: deps.templateService,
      instanceService: deps.instanceService,
      loaders: createGraphQLLoaders(deps),
    };
  };
}
