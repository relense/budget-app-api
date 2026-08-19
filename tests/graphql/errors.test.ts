import { describe, expect, it } from '@jest/globals';
import { GraphQLError } from 'graphql';
import { BudgetMonthServiceError } from '../../src/services/budgetMonths/budgetMonthService.js';
import { CategoryMonthServiceError } from '../../src/services/categories/categoryMonthService.js';
import { CategoryServiceError } from '../../src/services/categories/categoryService.js';
import { TransactionServiceError } from '../../src/services/categories/transactionService.js';
import { RecurringExpenseServiceError } from '../../src/services/recurringExpenses/recurringExpenseService.js';
import { SavingsFundServiceError } from '../../src/services/savings/savingsFundService.js';
import { SavingsMovementServiceError } from '../../src/services/savings/savingsMovementService.js';
import { requireUserId, toGraphQLError } from '../../src/graphql/errors.js';

describe('requireUserId', () => {
  it('returns the userId when present', () => {
    expect(requireUserId('user-1')).toBe('user-1');
  });

  it('throws an UNAUTHENTICATED GraphQLError when null', () => {
    try {
      requireUserId(null);
      throw new Error('expected requireUserId to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GraphQLError);
      expect((error as GraphQLError).extensions?.code).toBe('UNAUTHENTICATED');
    }
  });
});

describe('toGraphQLError', () => {
  it.each([
    ['CategoryServiceError', new CategoryServiceError('category_not_found'), 'CATEGORY_NOT_FOUND'],
    [
      'CategoryMonthServiceError',
      new CategoryMonthServiceError('category_month_budget_required'),
      'CATEGORY_MONTH_BUDGET_REQUIRED',
    ],
    [
      'CategoryMonthServiceError (budget_month_not_found)',
      new CategoryMonthServiceError('budget_month_not_found'),
      'BUDGET_MONTH_NOT_FOUND',
    ],
    ['TransactionServiceError', new TransactionServiceError('invalid_amount'), 'INVALID_AMOUNT'],
    [
      'BudgetMonthServiceError',
      new BudgetMonthServiceError('budget_month_not_found'),
      'BUDGET_MONTH_NOT_FOUND',
    ],
    [
      'RecurringExpenseServiceError',
      new RecurringExpenseServiceError('recurring_expense_not_found'),
      'RECURRING_EXPENSE_NOT_FOUND',
    ],
    ['SavingsFundServiceError', new SavingsFundServiceError('fund_has_movements'), 'FUND_HAS_MOVEMENTS'],
    [
      'SavingsMovementServiceError',
      new SavingsMovementServiceError('insufficient_funds'),
      'INSUFFICIENT_FUNDS',
    ],
  ])('maps %s to a GraphQLError with extensions.code %s', (_label, error, expectedCode) => {
    expect(() => toGraphQLError(error)).toThrow(GraphQLError);
    try {
      toGraphQLError(error);
    } catch (thrown) {
      expect((thrown as GraphQLError).extensions?.code).toBe(expectedCode);
      expect((thrown as GraphQLError).message).toBe(error.message);
    }
  });

  it('rethrows an unrecognized error as-is', () => {
    const original = new Error('boom');

    expect(() => toGraphQLError(original)).toThrow(original);
  });
});
