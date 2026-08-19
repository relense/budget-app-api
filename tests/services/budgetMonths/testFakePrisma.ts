import { randomUUID } from 'node:crypto';

export interface FakeBudgetMonth {
  id: string;
  userId: string;
  month: string;
  locked: boolean;
  lockedAt: Date | null;
  createdAt: Date;
}

/** Mimics the shape of Prisma's PrismaClientKnownRequestError for P2003 (foreign key constraint). */
export class FakeForeignKeyConstraintError extends Error {
  readonly code = 'P2003';
  constructor() {
    super('Foreign key constraint failed');
  }
}

export interface FakeBudgetMonthDelegate {
  findUnique(args: {
    where: { id: string } | { userId_month: { userId: string; month: string } };
  }): Promise<FakeBudgetMonth | null>;
  findMany(args: {
    where: { id: { in: string[] } } | { userId: string; locked?: boolean };
  }): Promise<FakeBudgetMonth[]>;
  upsert(args: {
    where: { userId_month: { userId: string; month: string } };
    create: { userId: string; month: string };
    update: Record<string, never>;
  }): Promise<FakeBudgetMonth>;
  update(args: {
    where: { id: string };
    data: Partial<Pick<FakeBudgetMonth, 'locked' | 'lockedAt'>>;
  }): Promise<FakeBudgetMonth>;
  delete(args: { where: { id: string } }): Promise<FakeBudgetMonth>;
}

export interface FakeBudgetMonthDelegateRefs {
  categoryMonths?: Array<{ monthId: string }>;
  recurringExpenseInstances?: Array<{ monthId: string }>;
}

/**
 * Shared in-memory BudgetMonth delegate — reused by every service's
 * fake-Prisma test double that touches budget_months (budgetMonthService,
 * categoryMonthService, transactionService), so the lookup/upsert/delete
 * semantics don't drift between separately-maintained copies. `refs` is
 * how `delete` simulates the real onDelete: Restrict FKs from
 * category_month/recurring_expense_instance — pass live references to
 * those arrays from the composing fake so the check reflects current
 * state, not a snapshot taken at construction time.
 */
export function createFakeBudgetMonthDelegate(
  budgetMonths: FakeBudgetMonth[],
  refs: FakeBudgetMonthDelegateRefs = {},
): FakeBudgetMonthDelegate {
  return {
    async findUnique({ where }) {
      if ('id' in where) {
        return budgetMonths.find((bm) => bm.id === where.id) ?? null;
      }
      const { userId, month } = where.userId_month;
      return budgetMonths.find((bm) => bm.userId === userId && bm.month === month) ?? null;
    },
    async findMany({ where }) {
      if ('id' in where) {
        return budgetMonths.filter((bm) => where.id.in.includes(bm.id));
      }
      return budgetMonths.filter((bm) => {
        if (bm.userId !== where.userId) return false;
        if (where.locked !== undefined && bm.locked !== where.locked) return false;
        return true;
      });
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
    async update({ where, data }) {
      const row = budgetMonths.find((bm) => bm.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
    async delete({ where }) {
      const index = budgetMonths.findIndex((bm) => bm.id === where.id);
      if (index === -1) throw new Error('not found');
      const referenced =
        (refs.categoryMonths ?? []).some((cm) => cm.monthId === where.id) ||
        (refs.recurringExpenseInstances ?? []).some((ri) => ri.monthId === where.id);
      if (referenced) {
        throw new FakeForeignKeyConstraintError();
      }
      const [row] = budgetMonths.splice(index, 1);
      return row!;
    },
  };
}
