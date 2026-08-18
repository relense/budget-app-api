import { randomUUID } from 'node:crypto';
import { createFakeBudgetMonthDelegate, type FakeBudgetMonth } from '../budgetMonths/testFakePrisma.js';

let lastTimestampMs = 0;
function nextTimestamp(): Date {
  const now = Date.now();
  lastTimestampMs = now > lastTimestampMs ? now : lastTimestampMs + 1;
  return new Date(lastTimestampMs);
}

export type FakeBudgetType = 'need' | 'want' | 'savings';
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

export interface FakeRecurringExpenseTemplate {
  id: string;
  userId: string;
  name: string;
  amountCents: number;
  categoryId: string;
  budgetType: FakeBudgetType;
  dueDay: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeRecurringExpenseInstance {
  id: string;
  userId: string;
  templateId: string;
  monthId: string;
  amountCents: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeTransaction {
  id: string;
  userId: string;
  categoryMonthId: string;
  recurringExpenseInstanceId: string | null;
  amountCents: number;
  date: Date;
  merchant: string | null;
  note: string | null;
  direction: FakeDirection;
  createdAt: Date;
  updatedAt: Date;
}

export class FakeUniqueConstraintError extends Error {
  readonly code = 'P2002';
  constructor() {
    super('Unique constraint failed');
  }
}

export class FakeForeignKeyConstraintError extends Error {
  readonly code = 'P2003';
  constructor() {
    super('Foreign key constraint failed');
  }
}

interface FakeDelegates {
  budgetMonth: ReturnType<typeof createFakeBudgetMonthDelegate>;
  category: {
    findUnique(args: { where: { id: string } }): Promise<FakeCategory | null>;
  };
  categoryMonth: {
    findUnique(args: { where: { id: string } }): Promise<FakeCategoryMonth | null>;
    findFirst(args: {
      where: Partial<Pick<FakeCategoryMonth, 'categoryId' | 'monthId'>>;
    }): Promise<FakeCategoryMonth | null>;
  };
  recurringExpenseTemplate: {
    create(args: {
      data: {
        userId: string;
        name: string;
        amountCents: number;
        categoryId: string;
        budgetType: FakeBudgetType;
        dueDay: number;
      };
    }): Promise<FakeRecurringExpenseTemplate>;
    findUnique(args: { where: { id: string } }): Promise<FakeRecurringExpenseTemplate | null>;
    findMany(args: {
      where: { userId: string; deletedAt: null } | { id: { in: string[] } };
    }): Promise<FakeRecurringExpenseTemplate[]>;
    update(args: {
      where: { id: string };
      data: Partial<
        Pick<
          FakeRecurringExpenseTemplate,
          'name' | 'amountCents' | 'categoryId' | 'budgetType' | 'dueDay' | 'deletedAt'
        >
      >;
    }): Promise<FakeRecurringExpenseTemplate>;
  };
  recurringExpenseInstance: {
    create(args: {
      data: { userId: string; templateId: string; monthId: string; amountCents: number };
    }): Promise<FakeRecurringExpenseInstance>;
    findUnique(args: { where: { id: string } }): Promise<FakeRecurringExpenseInstance | null>;
    findFirst(args: {
      where: Partial<Pick<FakeRecurringExpenseInstance, 'templateId' | 'monthId'>>;
    }): Promise<FakeRecurringExpenseInstance | null>;
    findMany(args: {
      where:
        | Partial<Pick<FakeRecurringExpenseInstance, 'userId' | 'templateId' | 'monthId'>>
        | { id: { in: string[] } };
    }): Promise<FakeRecurringExpenseInstance[]>;
    update(args: {
      where: { id: string };
      data: Partial<Pick<FakeRecurringExpenseInstance, 'amountCents'>>;
    }): Promise<FakeRecurringExpenseInstance>;
    delete(args: { where: { id: string } }): Promise<FakeRecurringExpenseInstance>;
  };
  transaction: {
    findFirst(args: {
      where: { recurringExpenseInstanceId: string };
    }): Promise<FakeTransaction | null>;
    findMany(args: {
      where: { recurringExpenseInstanceId: { in: string[] } };
    }): Promise<FakeTransaction[]>;
    create(args: {
      data: {
        userId: string;
        categoryMonthId: string;
        recurringExpenseInstanceId: string | null;
        amountCents: number;
        date: Date;
        merchant: string | null;
        note: string | null;
        direction: FakeDirection;
      };
    }): Promise<FakeTransaction>;
  };
}

interface FakePrismaClient extends FakeDelegates {
  categories: FakeCategory[];
  budgetMonths: FakeBudgetMonth[];
  categoryMonths: FakeCategoryMonth[];
  recurringExpenseTemplates: FakeRecurringExpenseTemplate[];
  recurringExpenseInstances: FakeRecurringExpenseInstance[];
  transactions: FakeTransaction[];
  $transaction<T>(callback: (tx: FakeDelegates) => Promise<T>): Promise<T>;
}

/**
 * A minimal in-memory stand-in for the slice of PrismaClient the recurring
 * expense services depend on. Used instead of per-call jest mocks so tests
 * exercise real lookup/update semantics without a live DB.
 */
export function createFakePrisma(): FakePrismaClient {
  const categories: FakeCategory[] = [];
  const budgetMonths: FakeBudgetMonth[] = [];
  const categoryMonths: FakeCategoryMonth[] = [];
  const recurringExpenseTemplates: FakeRecurringExpenseTemplate[] = [];
  const recurringExpenseInstances: FakeRecurringExpenseInstance[] = [];
  const transactions: FakeTransaction[] = [];

  const client: FakePrismaClient = {
    categories,
    budgetMonths,
    categoryMonths,
    recurringExpenseTemplates,
    recurringExpenseInstances,
    transactions,
    async $transaction(callback) {
      return callback(client);
    },
    budgetMonth: createFakeBudgetMonthDelegate(budgetMonths),
    category: {
      async findUnique({ where }) {
        return categories.find((c) => c.id === where.id) ?? null;
      },
    },
    categoryMonth: {
      async findUnique({ where }) {
        return categoryMonths.find((cm) => cm.id === where.id) ?? null;
      },
      async findFirst({ where }) {
        return (
          categoryMonths.find((cm) => {
            if (where.categoryId !== undefined && cm.categoryId !== where.categoryId) return false;
            if (where.monthId !== undefined && cm.monthId !== where.monthId) return false;
            return true;
          }) ?? null
        );
      },
    },
    recurringExpenseTemplate: {
      async create({ data }) {
        const row: FakeRecurringExpenseTemplate = {
          id: randomUUID(),
          userId: data.userId,
          name: data.name,
          amountCents: data.amountCents,
          categoryId: data.categoryId,
          budgetType: data.budgetType,
          dueDay: data.dueDay,
          deletedAt: null,
          createdAt: nextTimestamp(),
          updatedAt: nextTimestamp(),
        };
        recurringExpenseTemplates.push(row);
        return row;
      },
      async findUnique({ where }) {
        return recurringExpenseTemplates.find((t) => t.id === where.id) ?? null;
      },
      async findMany({ where }) {
        if ('id' in where) {
          return recurringExpenseTemplates.filter((t) => where.id.in.includes(t.id));
        }
        return recurringExpenseTemplates.filter(
          (t) => t.userId === where.userId && t.deletedAt === null,
        );
      },
      async update({ where, data }) {
        const row = recurringExpenseTemplates.find((t) => t.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        row.updatedAt = nextTimestamp();
        return row;
      },
    },
    recurringExpenseInstance: {
      async create({ data }) {
        const duplicate = recurringExpenseInstances.find(
          (i) => i.templateId === data.templateId && i.monthId === data.monthId,
        );
        if (duplicate) throw new FakeUniqueConstraintError();

        const row: FakeRecurringExpenseInstance = {
          id: randomUUID(),
          userId: data.userId,
          templateId: data.templateId,
          monthId: data.monthId,
          amountCents: data.amountCents,
          createdAt: nextTimestamp(),
          updatedAt: nextTimestamp(),
        };
        recurringExpenseInstances.push(row);
        return row;
      },
      async findUnique({ where }) {
        return recurringExpenseInstances.find((i) => i.id === where.id) ?? null;
      },
      async findFirst({ where }) {
        return (
          recurringExpenseInstances.find((i) => {
            if (where.templateId !== undefined && i.templateId !== where.templateId) return false;
            if (where.monthId !== undefined && i.monthId !== where.monthId) return false;
            return true;
          }) ?? null
        );
      },
      async findMany({ where }) {
        if ('id' in where) {
          return recurringExpenseInstances.filter((i) => where.id.in.includes(i.id));
        }
        return recurringExpenseInstances.filter((i) => {
          if (where.userId !== undefined && i.userId !== where.userId) return false;
          if (where.templateId !== undefined && i.templateId !== where.templateId) return false;
          if (where.monthId !== undefined && i.monthId !== where.monthId) return false;
          return true;
        });
      },
      async update({ where, data }) {
        const row = recurringExpenseInstances.find((i) => i.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        row.updatedAt = nextTimestamp();
        return row;
      },
      async delete({ where }) {
        const index = recurringExpenseInstances.findIndex((i) => i.id === where.id);
        if (index === -1) throw new Error('not found');
        if (transactions.some((t) => t.recurringExpenseInstanceId === where.id)) {
          throw new FakeForeignKeyConstraintError();
        }
        const [row] = recurringExpenseInstances.splice(index, 1);
        return row!;
      },
    },
    transaction: {
      async findFirst({ where }) {
        return (
          transactions.find((t) => t.recurringExpenseInstanceId === where.recurringExpenseInstanceId) ??
          null
        );
      },
      async findMany({ where }) {
        const ids = where.recurringExpenseInstanceId.in;
        return transactions.filter(
          (t) => t.recurringExpenseInstanceId !== null && ids.includes(t.recurringExpenseInstanceId),
        );
      },
      async create({ data }) {
        const row: FakeTransaction = {
          id: randomUUID(),
          userId: data.userId,
          categoryMonthId: data.categoryMonthId,
          recurringExpenseInstanceId: data.recurringExpenseInstanceId,
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
    },
  };

  return client;
}

export type FakePrisma = FakePrismaClient;
