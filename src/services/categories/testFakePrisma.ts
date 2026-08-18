import { randomUUID } from 'node:crypto';
import {
  createFakeBudgetMonthDelegate,
  type FakeBudgetMonth,
  type FakeBudgetMonthDelegate,
} from '../budgetMonths/testFakePrisma.js';

// A plain `new Date()` can collide within the same millisecond when a test
// creates several rows back-to-back, which breaks createdAt-tiebreaker
// ordering assertions. Monotonically increasing instead.
let lastTimestampMs = 0;
function nextTimestamp(): Date {
  const now = Date.now();
  lastTimestampMs = now > lastTimestampMs ? now : lastTimestampMs + 1;
  return new Date(lastTimestampMs);
}

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

/** Mimics the shape of Prisma's PrismaClientKnownRequestError for P2002 (unique constraint). */
export class FakeUniqueConstraintError extends Error {
  readonly code = 'P2002';
  constructor() {
    super('Unique constraint failed');
  }
}

interface FakeDelegates {
  budgetMonth: FakeBudgetMonthDelegate;
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
    findMany(args: {
      where: { userId: string; deletedAt: null } | { id: { in: string[] } };
    }): Promise<FakeCategory[]>;
    update(args: {
      where: { id: string };
      data: Partial<
        Pick<FakeCategory, 'name' | 'icon' | 'color' | 'budgetType' | 'direction' | 'deletedAt'>
      >;
    }): Promise<FakeCategory>;
  };
  categoryMonth: {
    findUnique(args: { where: { id: string } }): Promise<FakeCategoryMonth | null>;
    findFirst(args: { where: { categoryId: string } }): Promise<FakeCategoryMonth | null>;
    findMany(args: {
      where:
        | Partial<Pick<FakeCategoryMonth, 'userId' | 'categoryId' | 'monthId'>>
        | { id: { in: string[] } };
    }): Promise<FakeCategoryMonth[]>;
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
    findUnique(args: { where: { id: string } }): Promise<FakeTransaction | null>;
    findFirst(args: {
      where: { categoryMonthId: string } | { categoryMonthId: { in: string[] } };
    }): Promise<FakeTransaction | null>;
    findMany(args: {
      where: { categoryMonthId: { in: string[] }; userId?: string };
    }): Promise<FakeTransaction[]>;
    create(args: {
      data: {
        userId: string;
        categoryMonthId: string;
        amountCents: number;
        date: Date;
        merchant: string | null;
        note: string | null;
        direction: FakeDirection;
      };
    }): Promise<FakeTransaction>;
    update(args: {
      where: { id: string };
      data: Partial<
        Pick<
          FakeTransaction,
          'categoryMonthId' | 'amountCents' | 'date' | 'merchant' | 'note' | 'direction'
        >
      >;
    }): Promise<FakeTransaction>;
    delete(args: { where: { id: string } }): Promise<FakeTransaction>;
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
          createdAt: nextTimestamp(),
          updatedAt: nextTimestamp(),
        };
        categories.push(row);
        return row;
      },
      async findUnique({ where }) {
        return categories.find((c) => c.id === where.id) ?? null;
      },
      async findMany({ where }) {
        if ('id' in where) {
          return categories.filter((c) => where.id.in.includes(c.id));
        }
        return categories.filter((c) => c.userId === where.userId && c.deletedAt === null);
      },
      async update({ where, data }) {
        const row = categories.find((c) => c.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        row.updatedAt = nextTimestamp();
        return row;
      },
    },
    budgetMonth: createFakeBudgetMonthDelegate(budgetMonths),
    categoryMonth: {
      async findUnique({ where }) {
        return categoryMonths.find((cm) => cm.id === where.id) ?? null;
      },
      async findFirst({ where }) {
        return categoryMonths.find((cm) => cm.categoryId === where.categoryId) ?? null;
      },
      async findMany({ where }) {
        if ('id' in where) {
          return categoryMonths.filter((cm) => where.id.in.includes(cm.id));
        }
        return categoryMonths.filter((cm) => {
          if (where.userId !== undefined && cm.userId !== where.userId) return false;
          if (where.categoryId !== undefined && cm.categoryId !== where.categoryId) return false;
          if (where.monthId !== undefined && cm.monthId !== where.monthId) return false;
          return true;
        });
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
          createdAt: nextTimestamp(),
          updatedAt: nextTimestamp(),
        };
        categoryMonths.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = categoryMonths.find((cm) => cm.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        row.updatedAt = nextTimestamp();
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
      async findUnique({ where }) {
        return transactions.find((t) => t.id === where.id) ?? null;
      },
      async findFirst({ where }) {
        if ('categoryMonthId' in where && typeof where.categoryMonthId === 'string') {
          const categoryMonthId = where.categoryMonthId;
          return transactions.find((t) => t.categoryMonthId === categoryMonthId) ?? null;
        }
        const ids = (where.categoryMonthId as { in: string[] }).in;
        return transactions.find((t) => ids.includes(t.categoryMonthId)) ?? null;
      },
      async findMany({ where }) {
        const ids = where.categoryMonthId.in;
        return transactions.filter(
          (t) => ids.includes(t.categoryMonthId) && (where.userId === undefined || t.userId === where.userId),
        );
      },
      async create({ data }) {
        const row: FakeTransaction = {
          id: randomUUID(),
          userId: data.userId,
          categoryMonthId: data.categoryMonthId,
          amountCents: data.amountCents,
          date: data.date,
          merchant: data.merchant,
          note: data.note,
          direction: data.direction,
          createdAt: nextTimestamp(),
          updatedAt: nextTimestamp(),
        };
        transactions.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = transactions.find((t) => t.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        row.updatedAt = nextTimestamp();
        return row;
      },
      async delete({ where }) {
        const index = transactions.findIndex((t) => t.id === where.id);
        if (index === -1) throw new Error('not found');
        const [row] = transactions.splice(index, 1);
        return row!;
      },
    },
  };
}

export type FakePrisma = FakePrismaClient;
