import DataLoader from 'dataloader';
import type { BudgetMonthService } from '../services/budgetMonths/budgetMonthService.js';
import type { CategoryMonthService } from '../services/categories/categoryMonthService.js';
import type { CategoryService } from '../services/categories/categoryService.js';
import type { TransactionService } from '../services/categories/transactionService.js';

type CategoryRecord = Awaited<ReturnType<CategoryService['findManyByIds']>>[number];
type CategoryMonthRecord = Awaited<ReturnType<CategoryMonthService['findManyByIds']>>[number];
type BudgetMonthRecord = Awaited<ReturnType<BudgetMonthService['findManyByIds']>>[number];
type TransactionRecord = Awaited<ReturnType<TransactionService['listByCategoryMonthIds']>>[number];

export interface GraphQLLoaders {
  categoryById: DataLoader<string, CategoryRecord | null>;
  categoryMonthById: DataLoader<string, CategoryMonthRecord | null>;
  budgetMonthById: DataLoader<string, BudgetMonthRecord | null>;
  transactionsByCategoryMonthId: DataLoader<string, TransactionRecord[]>;
}

export interface GraphQLLoaderDeps {
  categoryService: Pick<CategoryService, 'findManyByIds'>;
  categoryMonthService: Pick<CategoryMonthService, 'findManyByIds'>;
  budgetMonthService: Pick<BudgetMonthService, 'findManyByIds'>;
  transactionService: Pick<TransactionService, 'listByCategoryMonthIds'>;
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

  return { categoryById, categoryMonthById, budgetMonthById, transactionsByCategoryMonthId };
}
