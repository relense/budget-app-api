import { randomUUID } from 'node:crypto';

export interface FakeBudgetMonth {
  id: string;
  userId: string;
  month: string;
  locked: boolean;
  lockedAt: Date | null;
  createdAt: Date;
}

export interface FakeBudgetMonthDelegate {
  findUnique(args: {
    where: { id: string } | { userId_month: { userId: string; month: string } };
  }): Promise<FakeBudgetMonth | null>;
  findMany(args: { where: { id: { in: string[] } } }): Promise<FakeBudgetMonth[]>;
  upsert(args: {
    where: { userId_month: { userId: string; month: string } };
    create: { userId: string; month: string };
    update: Record<string, never>;
  }): Promise<FakeBudgetMonth>;
}

/**
 * Shared in-memory BudgetMonth delegate — reused by every service's
 * fake-Prisma test double that touches budget_months (budgetMonthService,
 * categoryMonthService, transactionService), so the lookup/upsert
 * semantics don't drift between separately-maintained copies.
 */
export function createFakeBudgetMonthDelegate(budgetMonths: FakeBudgetMonth[]): FakeBudgetMonthDelegate {
  return {
    async findUnique({ where }) {
      if ('id' in where) {
        return budgetMonths.find((bm) => bm.id === where.id) ?? null;
      }
      const { userId, month } = where.userId_month;
      return budgetMonths.find((bm) => bm.userId === userId && bm.month === month) ?? null;
    },
    async findMany({ where }) {
      return budgetMonths.filter((bm) => where.id.in.includes(bm.id));
    },
    async upsert({ where }) {
      const { userId, month } = where.userId_month;
      const existing = budgetMonths.find((bm) => bm.userId === userId && bm.month === month);
      if (existing) return existing;

      const row: FakeBudgetMonth = {
        id: randomUUID(),
        userId,
        month,
        locked: false,
        lockedAt: null,
        createdAt: new Date(),
      };
      budgetMonths.push(row);
      return row;
    },
  };
}

interface FakePrismaClient {
  budgetMonths: FakeBudgetMonth[];
  budgetMonth: FakeBudgetMonthDelegate;
}

/**
 * A minimal in-memory stand-in for the slice of PrismaClient budgetMonthService
 * depends on. Used instead of per-call jest mocks so tests exercise real
 * lookup/upsert semantics without a live DB.
 */
export function createFakePrisma(): FakePrismaClient {
  const budgetMonths: FakeBudgetMonth[] = [];

  return {
    budgetMonths,
    budgetMonth: createFakeBudgetMonthDelegate(budgetMonths),
  };
}

export type FakePrisma = FakePrismaClient;
