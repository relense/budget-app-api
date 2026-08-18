import { randomUUID } from 'node:crypto';

export type FakeBudgetType = 'preciso' | 'quero' | 'poupanca';
export type FakeDirection = 'expense' | 'income';

export interface FakeCategory {
  id: string;
  userId: string;
  name: string;
  icon: string;
  color: string;
  budgetType: FakeBudgetType | null;
  direction: FakeDirection;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeBudgetMonth {
  id: string;
  userId: string;
  month: string;
  locked: boolean;
  lockedAt: Date | null;
  createdAt: Date;
}

export interface FakeCategoryMonth {
  id: string;
  userId: string;
  categoryId: string;
  monthId: string;
  monthlyBudgetCents: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeTransaction {
  id: string;
  userId: string;
  categoryMonthId: string;
  amountCents: number;
  date: Date;
  merchant: string | null;
  note: string | null;
  direction: FakeDirection;
  createdAt: Date;
  updatedAt: Date;
}

/** Mimics the shape of Prisma's PrismaClientKnownRequestError for P2002 (unique constraint). */
export class FakeUniqueConstraintError extends Error {
  readonly code = 'P2002';
  constructor() {
    super('Unique constraint failed');
  }
}

interface FakeDelegates {
  category: {
    create(args: {
      data: {
        userId: string;
        name: string;
        icon: string;
        color: string;
        budgetType: FakeBudgetType | null;
        direction: FakeDirection;
      };
    }): Promise<FakeCategory>;
    findUnique(args: { where: { id: string } }): Promise<FakeCategory | null>;
    update(args: {
      where: { id: string };
      data: Partial<
        Pick<FakeCategory, 'name' | 'icon' | 'color' | 'budgetType' | 'direction' | 'deletedAt'>
      >;
    }): Promise<FakeCategory>;
  };
  budgetMonth: {
    findUnique(args: {
      where: { id: string } | { userId_month: { userId: string; month: string } };
    }): Promise<FakeBudgetMonth | null>;
    upsert(args: {
      where: { userId_month: { userId: string; month: string } };
      create: { userId: string; month: string };
      update: Record<string, never>;
    }): Promise<FakeBudgetMonth>;
  };
  categoryMonth: {
    findUnique(args: { where: { id: string } }): Promise<FakeCategoryMonth | null>;
    findFirst(args: { where: { categoryId: string } }): Promise<FakeCategoryMonth | null>;
    findMany(args: { where: { categoryId: string } }): Promise<FakeCategoryMonth[]>;
    create(args: {
      data: { userId: string; categoryId: string; monthId: string; monthlyBudgetCents: number };
    }): Promise<FakeCategoryMonth>;
    update(args: {
      where: { id: string };
      data: Partial<Pick<FakeCategoryMonth, 'monthlyBudgetCents'>>;
    }): Promise<FakeCategoryMonth>;
    delete(args: { where: { id: string } }): Promise<FakeCategoryMonth>;
  };
  transaction: {
    findFirst(args: {
      where: { categoryMonthId: string } | { categoryMonthId: { in: string[] } };
    }): Promise<FakeTransaction | null>;
  };
}

interface FakePrismaClient extends FakeDelegates {
  categories: FakeCategory[];
  budgetMonths: FakeBudgetMonth[];
  categoryMonths: FakeCategoryMonth[];
  transactions: FakeTransaction[];
}

/**
 * A minimal in-memory stand-in for the slice of PrismaClient the category
 * services depend on. Used instead of per-call jest mocks so tests exercise
 * real lookup/update semantics without a live DB.
 */
export function createFakePrisma(): FakePrismaClient {
  const categories: FakeCategory[] = [];
  const budgetMonths: FakeBudgetMonth[] = [];
  const categoryMonths: FakeCategoryMonth[] = [];
  const transactions: FakeTransaction[] = [];

  return {
    categories,
    budgetMonths,
    categoryMonths,
    transactions,
    category: {
      async create({ data }) {
        const row: FakeCategory = {
          id: randomUUID(),
          userId: data.userId,
          name: data.name,
          icon: data.icon,
          color: data.color,
          budgetType: data.budgetType,
          direction: data.direction,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        categories.push(row);
        return row;
      },
      async findUnique({ where }) {
        return categories.find((c) => c.id === where.id) ?? null;
      },
      async update({ where, data }) {
        const row = categories.find((c) => c.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        row.updatedAt = new Date();
        return row;
      },
    },
    budgetMonth: {
      async findUnique({ where }) {
        if ('id' in where) {
          return budgetMonths.find((bm) => bm.id === where.id) ?? null;
        }
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
    categoryMonth: {
      async findUnique({ where }) {
        return categoryMonths.find((cm) => cm.id === where.id) ?? null;
      },
      async findFirst({ where }) {
        return categoryMonths.find((cm) => cm.categoryId === where.categoryId) ?? null;
      },
      async findMany({ where }) {
        return categoryMonths.filter((cm) => cm.categoryId === where.categoryId);
      },
      async create({ data }) {
        const duplicate = categoryMonths.find(
          (cm) => cm.categoryId === data.categoryId && cm.monthId === data.monthId,
        );
        if (duplicate) throw new FakeUniqueConstraintError();

        const row: FakeCategoryMonth = {
          id: randomUUID(),
          userId: data.userId,
          categoryId: data.categoryId,
          monthId: data.monthId,
          monthlyBudgetCents: data.monthlyBudgetCents,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        categoryMonths.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = categoryMonths.find((cm) => cm.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        row.updatedAt = new Date();
        return row;
      },
      async delete({ where }) {
        const index = categoryMonths.findIndex((cm) => cm.id === where.id);
        if (index === -1) throw new Error('not found');
        const [row] = categoryMonths.splice(index, 1);
        return row!;
      },
    },
    transaction: {
      async findFirst({ where }) {
        if ('categoryMonthId' in where && typeof where.categoryMonthId === 'string') {
          const categoryMonthId = where.categoryMonthId;
          return transactions.find((t) => t.categoryMonthId === categoryMonthId) ?? null;
        }
        const ids = (where.categoryMonthId as { in: string[] }).in;
        return transactions.find((t) => ids.includes(t.categoryMonthId)) ?? null;
      },
    },
  };
}

export type FakePrisma = FakePrismaClient;
