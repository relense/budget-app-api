import DataLoader from 'dataloader';
import type { BudgetMonthService } from '../services/budgetMonths/budgetMonthService.js';
import type { CategoryMonthService } from '../services/categories/categoryMonthService.js';
import type { CategoryService } from '../services/categories/categoryService.js';
import type { TransactionService } from '../services/categories/transactionService.js';
import type { RecurringExpenseInstanceService } from '../services/recurringExpenses/recurringExpenseInstanceService.js';
import type { RecurringExpenseTemplateService } from '../services/recurringExpenses/recurringExpenseTemplateService.js';

type CategoryRecord = Awaited<ReturnType<CategoryService['findManyByIds']>>[number];
type CategoryMonthRecord = Awaited<ReturnType<CategoryMonthService['findManyByIds']>>[number];
type BudgetMonthRecord = Awaited<ReturnType<BudgetMonthService['findManyByIds']>>[number];
type TransactionRecord = Awaited<ReturnType<TransactionService['listByCategoryMonthIds']>>[number];
type RecurringExpenseTemplateRecord = Awaited<
  ReturnType<RecurringExpenseTemplateService['findManyByIds']>
>[number];
type RecurringExpenseInstanceRecord = Awaited<
  ReturnType<RecurringExpenseInstanceService['findManyByIds']>
>[number];

export interface GraphQLLoaders {
  categoryById: DataLoader<string, CategoryRecord | null>;
  categoryMonthById: DataLoader<string, CategoryMonthRecord | null>;
  budgetMonthById: DataLoader<string, BudgetMonthRecord | null>;
  transactionsByCategoryMonthId: DataLoader<string, TransactionRecord[]>;
  recurringExpenseTemplateById: DataLoader<string, RecurringExpenseTemplateRecord | null>;
  recurringExpenseInstanceById: DataLoader<string, RecurringExpenseInstanceRecord | null>;
  transactionsByRecurringExpenseInstanceId: DataLoader<string, TransactionRecord[]>;
  recurringCommittedCentsByCategoryMonthId: DataLoader<string, number>;
}

export interface GraphQLLoaderDeps {
  categoryService: Pick<CategoryService, 'findManyByIds'>;
  categoryMonthService: Pick<CategoryMonthService, 'findManyByIds'>;
  budgetMonthService: Pick<BudgetMonthService, 'findManyByIds'>;
  transactionService: Pick<TransactionService, 'listByCategoryMonthIds' | 'listByRecurringExpenseInstanceIds'>;
  templateService: Pick<RecurringExpenseTemplateService, 'findManyByIds'>;
  instanceService: Pick<
    RecurringExpenseInstanceService,
    'findManyByIds' | 'sumCommittedCentsForCategoryMonth'
  >;
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

  const recurringExpenseTemplateById = new DataLoader<string, RecurringExpenseTemplateRecord | null>(
    async (ids) => {
      const rows = await deps.templateService.findManyByIds([...ids]);
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.map((id) => byId.get(id) ?? null);
    },
  );

  const recurringExpenseInstanceById = new DataLoader<string, RecurringExpenseInstanceRecord | null>(
    async (ids) => {
      const rows = await deps.instanceService.findManyByIds([...ids]);
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.map((id) => byId.get(id) ?? null);
    },
  );

  const transactionsByRecurringExpenseInstanceId = new DataLoader<string, TransactionRecord[]>(
    async (ids) => {
      const rows = await deps.transactionService.listByRecurringExpenseInstanceIds([...ids]);
      const byInstanceId = new Map<string, TransactionRecord[]>();
      for (const row of rows) {
        if (!row.recurringExpenseInstanceId) continue;
        const list = byInstanceId.get(row.recurringExpenseInstanceId) ?? [];
        list.push(row);
        byInstanceId.set(row.recurringExpenseInstanceId, list);
      }
      return ids.map((id) => byInstanceId.get(id) ?? []);
    },
  );

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
        return deps.instanceService.sumCommittedCentsForCategoryMonth(
          categoryMonth.categoryId,
          categoryMonth.monthId,
        );
      }),
    );
  });

  return {
    categoryById,
    categoryMonthById,
    budgetMonthById,
    transactionsByCategoryMonthId,
    recurringExpenseTemplateById,
    recurringExpenseInstanceById,
    transactionsByRecurringExpenseInstanceId,
    recurringCommittedCentsByCategoryMonthId,
  };
}
