import { randomUUID } from 'node:crypto';

export interface FakeBudgetMonth {
  id: string;
  userId: string;
  month: string;
  locked: boolean;
  lockedAt: Date | null;
  createdAt: Date;
}

interface FakeDelegates {
  budgetMonth: {
    findUnique(args: {
      where: { userId_month: { userId: string; month: string } };
    }): Promise<FakeBudgetMonth | null>;
    upsert(args: {
      where: { userId_month: { userId: string; month: string } };
      create: { userId: string; month: string };
      update: Record<string, never>;
    }): Promise<FakeBudgetMonth>;
  };
}

interface FakePrismaClient extends FakeDelegates {
  budgetMonths: FakeBudgetMonth[];
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
    budgetMonth: {
      async findUnique({ where }) {
        const { userId, month } = where.userId_month;
        return budgetMonths.find((bm) => bm.userId === userId && bm.month === month) ?? null;
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
    },
  };
}

export type FakePrisma = FakePrismaClient;
