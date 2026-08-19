import DataLoader from 'dataloader';
import type { BudgetMonthService } from '../services/budgetMonths/budgetMonthService.js';
import type { CategoryMonthService } from '../services/categories/categoryMonthService.js';
import type { CategoryService } from '../services/categories/categoryService.js';
import type { TransactionService } from '../services/categories/transactionService.js';
import type { RecurringExpenseService } from '../services/recurringExpenses/recurringExpenseService.js';
import type { SavingsFundService } from '../services/savings/savingsFundService.js';
import type { SavingsMovementService } from '../services/savings/savingsMovementService.js';

type CategoryRecord = Awaited<ReturnType<CategoryService['findManyByIds']>>[number];
type CategoryMonthRecord = Awaited<ReturnType<CategoryMonthService['findManyByIds']>>[number];
type BudgetMonthRecord = Awaited<ReturnType<BudgetMonthService['findManyByIds']>>[number];
type TransactionRecord = Awaited<ReturnType<TransactionService['listByCategoryMonthIds']>>[number];
type RecurringExpenseRecord = Awaited<ReturnType<RecurringExpenseService['findManyByIds']>>[number];
type SavingsFundRecord = Awaited<ReturnType<SavingsFundService['findManyByIds']>>[number];
type SavingsMovementRecord = Awaited<ReturnType<SavingsMovementService['listByFundIds']>>[number];

export interface GraphQLLoaders {
  categoryById: DataLoader<string, CategoryRecord | null>;
  categoryMonthById: DataLoader<string, CategoryMonthRecord | null>;
  budgetMonthById: DataLoader<string, BudgetMonthRecord | null>;
  transactionsByCategoryMonthId: DataLoader<string, TransactionRecord[]>;
  recurringExpenseById: DataLoader<string, RecurringExpenseRecord | null>;
  transactionsByRecurringExpenseId: DataLoader<string, TransactionRecord[]>;
  recurringCommittedCentsByCategoryMonthId: DataLoader<string, number>;
  savingsFundById: DataLoader<string, SavingsFundRecord | null>;
  movementsBySavingsFundId: DataLoader<string, SavingsMovementRecord[]>;
  currentAmountCentsBySavingsFundId: DataLoader<string, number>;
}

export interface GraphQLLoaderDeps {
  categoryService: Pick<CategoryService, 'findManyByIds'>;
  categoryMonthService: Pick<CategoryMonthService, 'findManyByIds'>;
  budgetMonthService: Pick<BudgetMonthService, 'findManyByIds'>;
  transactionService: Pick<TransactionService, 'listByCategoryMonthIds' | 'listByRecurringExpenseIds'>;
  recurringExpenseService: Pick<
    RecurringExpenseService,
    'findManyByIds' | 'sumCommittedCentsForCategoryMonth'
  >;
  savingsFundService: Pick<SavingsFundService, 'findManyByIds'>;
  savingsMovementService: Pick<SavingsMovementService, 'listByFundIds' | 'computeCurrentAmountCents'>;
}

/**
 * Fresh per GraphQL request — a DataLoader's cache must never leak across
 * requests (or, worse, across users). The underlying services are stateless
 * and shared, only the loaders themselves are request-scoped.
 */
export function createGraphQLLoaders(deps: GraphQLLoaderDeps): GraphQLLoaders {
  const categoryById = new DataLoader<string, CategoryRecord | null>(async (ids) => {
    const rows = await deps.categoryService.findManyByIds([...ids]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => byId.get(id) ?? null);
  });

  const categoryMonthById = new DataLoader<string, CategoryMonthRecord | null>(async (ids) => {
    const rows = await deps.categoryMonthService.findManyByIds([...ids]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => byId.get(id) ?? null);
  });

  const budgetMonthById = new DataLoader<string, BudgetMonthRecord | null>(async (ids) => {
    const rows = await deps.budgetMonthService.findManyByIds([...ids]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => byId.get(id) ?? null);
  });

  const transactionsByCategoryMonthId = new DataLoader<string, TransactionRecord[]>(async (ids) => {
    const rows = await deps.transactionService.listByCategoryMonthIds([...ids]);
    const byCategoryMonthId = new Map<string, TransactionRecord[]>();
    for (const row of rows) {
      const list = byCategoryMonthId.get(row.categoryMonthId) ?? [];
      list.push(row);
      byCategoryMonthId.set(row.categoryMonthId, list);
    }
    return ids.map((id) => byCategoryMonthId.get(id) ?? []);
  });

  const recurringExpenseById = new DataLoader<string, RecurringExpenseRecord | null>(async (ids) => {
    const rows = await deps.recurringExpenseService.findManyByIds([...ids]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => byId.get(id) ?? null);
  });

  const transactionsByRecurringExpenseId = new DataLoader<string, TransactionRecord[]>(async (ids) => {
    const rows = await deps.transactionService.listByRecurringExpenseIds([...ids]);
    const byRecurringExpenseId = new Map<string, TransactionRecord[]>();
    for (const row of rows) {
      if (!row.recurringExpenseId) continue;
      const list = byRecurringExpenseId.get(row.recurringExpenseId) ?? [];
      list.push(row);
      byRecurringExpenseId.set(row.recurringExpenseId, list);
    }
    return ids.map((id) => byRecurringExpenseId.get(id) ?? []);
  });

  // Not a single batched query underneath (sumCommittedCentsForCategoryMonth
  // is per-pair, same low-cardinality reasoning as its own implementation) —
  // this loader still collapses N field resolutions into one batch tick and
  // dedupes repeated ids within a request, which is what DataLoader is for.
  const recurringCommittedCentsByCategoryMonthId = new DataLoader<string, number>(async (ids) => {
    const categoryMonths = await deps.categoryMonthService.findManyByIds([...ids]);
    const byId = new Map(categoryMonths.map((cm) => [cm.id, cm]));
    return Promise.all(
      ids.map(async (id) => {
        const categoryMonth = byId.get(id);
        if (!categoryMonth) return 0;
        return deps.recurringExpenseService.sumCommittedCentsForCategoryMonth(
          categoryMonth.categoryId,
          categoryMonth.monthId,
        );
      }),
    );
  });

  const savingsFundById = new DataLoader<string, SavingsFundRecord | null>(async (ids) => {
    const rows = await deps.savingsFundService.findManyByIds([...ids]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => byId.get(id) ?? null);
  });

  const movementsBySavingsFundId = new DataLoader<string, SavingsMovementRecord[]>(async (ids) => {
    const rows = await deps.savingsMovementService.listByFundIds([...ids]);
    const byFundId = new Map<string, SavingsMovementRecord[]>();
    for (const row of rows) {
      const list = byFundId.get(row.fundId) ?? [];
      list.push(row);
      byFundId.set(row.fundId, list);
    }
    return ids.map((id) => byFundId.get(id) ?? []);
  });

  // Not a single batched query underneath, same reasoning as
  // recurringCommittedCentsByCategoryMonthId above — still collapses N
  // field resolutions (SavingsFund.currentAmountCents and .achieved both
  // hit this same loader) into one batch tick per request.
  const currentAmountCentsBySavingsFundId = new DataLoader<string, number>(async (ids) => {
    const funds = await deps.savingsFundService.findManyByIds([...ids]);
    const byId = new Map(funds.map((fund) => [fund.id, fund]));
    return Promise.all(
      ids.map(async (id) => {
        const fund = byId.get(id);
        if (!fund) return 0;
        return deps.savingsMovementService.computeCurrentAmountCents(id, fund.initialBalanceCents);
      }),
    );
  });

  return {
    categoryById,
    categoryMonthById,
    budgetMonthById,
    transactionsByCategoryMonthId,
    recurringExpenseById,
    transactionsByRecurringExpenseId,
    recurringCommittedCentsByCategoryMonthId,
    savingsFundById,
    movementsBySavingsFundId,
    currentAmountCentsBySavingsFundId,
  };
}
