import type { BankBalanceService } from '../services/bankBalance/bankBalanceService.js';
import type { BudgetMonthService } from '../services/budgetMonths/budgetMonthService.js';
import type { CategoryMonthService } from '../services/categories/categoryMonthService.js';
import type { CategoryService } from '../services/categories/categoryService.js';
import type { TransactionService } from '../services/categories/transactionService.js';
import type { RecurringExpenseService } from '../services/recurringExpenses/recurringExpenseService.js';
import type { SavingsFundService } from '../services/savings/savingsFundService.js';
import type { SavingsMovementService } from '../services/savings/savingsMovementService.js';
import { createGraphQLLoaders, type GraphQLLoaders } from './loaders.js';

export interface GraphQLContext {
  userId: string | null;
  categoryService: CategoryService;
  categoryMonthService: CategoryMonthService;
  budgetMonthService: BudgetMonthService;
  transactionService: TransactionService;
  recurringExpenseService: RecurringExpenseService;
  savingsFundService: SavingsFundService;
  savingsMovementService: SavingsMovementService;
  bankBalanceService: BankBalanceService;
  loaders: GraphQLLoaders;
}

export interface GraphQLContextBuilderDeps {
  categoryService: CategoryService;
  categoryMonthService: CategoryMonthService;
  budgetMonthService: BudgetMonthService;
  transactionService: TransactionService;
  recurringExpenseService: RecurringExpenseService;
  savingsFundService: SavingsFundService;
  savingsMovementService: SavingsMovementService;
  bankBalanceService: BankBalanceService;
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
      budgetMonthService: deps.budgetMonthService,
      transactionService: deps.transactionService,
      recurringExpenseService: deps.recurringExpenseService,
      savingsFundService: deps.savingsFundService,
      savingsMovementService: deps.savingsMovementService,
      bankBalanceService: deps.bankBalanceService,
      loaders: createGraphQLLoaders(deps),
    };
  };
}
