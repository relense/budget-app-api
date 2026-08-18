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
  categoryMonth: {
    findFirst(args: { where: { categoryId: string } }): Promise<FakeCategoryMonth | null>;
    findMany(args: { where: { categoryId: string } }): Promise<FakeCategoryMonth[]>;
  };
  transaction: {
    findFirst(args: {
      where: { categoryMonthId: string } | { categoryMonthId: { in: string[] } };
    }): Promise<FakeTransaction | null>;
  };
}

interface FakePrismaClient extends FakeDelegates {
  categories: FakeCategory[];
  categoryMonths: FakeCategoryMonth[];
  transactions: FakeTransaction[];
}

/**
 * A minimal in-memory stand-in for the slice of PrismaClient categoryService
 * depends on. Used instead of per-call jest mocks so tests exercise real
 * lookup/update semantics without a live DB.
 */
export function createFakePrisma(): FakePrismaClient {
  const categories: FakeCategory[] = [];
  const categoryMonths: FakeCategoryMonth[] = [];
  const transactions: FakeTransaction[] = [];

  return {
    categories,
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
    categoryMonth: {
      async findFirst({ where }) {
        return categoryMonths.find((cm) => cm.categoryId === where.categoryId) ?? null;
      },
      async findMany({ where }) {
        return categoryMonths.filter((cm) => cm.categoryId === where.categoryId);
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
