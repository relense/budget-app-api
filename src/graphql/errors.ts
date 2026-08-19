import { GraphQLError } from 'graphql';
import { CategoryMonthServiceError } from '../services/categories/categoryMonthService.js';
import { CategoryServiceError } from '../services/categories/categoryService.js';
import { TransactionServiceError } from '../services/categories/transactionService.js';
import { RecurringExpenseInstanceServiceError } from '../services/recurringExpenses/recurringExpenseInstanceService.js';
import { RecurringExpenseTemplateServiceError } from '../services/recurringExpenses/recurringExpenseTemplateService.js';

/**
 * Maps known service-layer errors to a GraphQLError with a stable
 * extensions.code clients can branch on. Anything else is rethrown as-is —
 * Yoga's maskedErrors (production only, see server.ts) reduces it to a
 * generic message while the full detail still reaches server-side logs.
 */
export function toGraphQLError(error: unknown): never {
  if (
    error instanceof CategoryServiceError ||
    error instanceof CategoryMonthServiceError ||
    error instanceof TransactionServiceError ||
    error instanceof RecurringExpenseTemplateServiceError ||
    error instanceof RecurringExpenseInstanceServiceError
  ) {
    throw new GraphQLError(error.message, { extensions: { code: error.reason.toUpperCase() } });
  }
  throw error;
}

/** Every resolver touching user-owned data re-checks this — no single top-level auth check. */
export function requireUserId(userId: string | null): string {
  if (!userId) {
    throw new GraphQLError('Not authenticated', { extensions: { code: 'UNAUTHENTICATED' } });
  }
  return userId;
}
