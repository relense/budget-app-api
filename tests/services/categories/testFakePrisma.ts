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

export type FakeBudgetType = 'need' | 'want' | 'savings';
export type FakeRecurringBudgetType = 'need' | 'want';
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
  budgetType: FakeRecurringBudgetType;
  dueDay: number;
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

/** Mimics the shape of Prisma's PrismaClientKnownRequestError for P2002 (unique constraint). */
export class FakeUniqueConstraintError extends Error {
  readonly code = 'P2002';
  constructor() {
    super('Unique constraint failed');
  }
}

/** Mimics the shape of Prisma's PrismaClientKnownRequestError for P2003 (foreign key constraint). */
export class FakeForeignKeyConstraintError extends Error {
  readonly code = 'P2003';
  constructor() {
    super('Foreign key constraint failed');
  }
}

interface FakeDelegates {
  /**
   * No-op — the fake has no real Postgres, so it can't simulate row-level
   * locking. Only proves the code calls it in the right places; real
   * concurrency-safety for lockTemplateRow's callers needs verification
   * against a live database.
   */
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
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
    findUnique(args: {
      where: { id: string } | { categoryId_monthId: { categoryId: string; monthId: string } };
    }): Promise<FakeCategoryMonth | null>;
    findFirst(args: {
      where: Partial<Pick<FakeCategoryMonth, 'categoryId' | 'monthId'>>;
    }): Promise<FakeCategoryMonth | null>;
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
  recurringExpenseTemplate: {
    create(args: {
      data: {
        userId: string;
        name: string;
        amountCents: number;
        categoryId: string;
        budgetType: FakeRecurringBudgetType;
        dueDay: number;
      };
    }): Promise<FakeRecurringExpenseTemplate>;
    findUnique(args: { where: { id: string } }): Promise<FakeRecurringExpenseTemplate | null>;
    findMany(args: {
      where: { userId: string } | { categoryId: string } | { id: { in: string[] } };
    }): Promise<FakeRecurringExpenseTemplate[]>;
    update(args: {
      where: { id: string };
      data: Partial<
        Pick<FakeRecurringExpenseTemplate, 'name' | 'amountCents' | 'categoryId' | 'budgetType' | 'dueDay'>
      >;
    }): Promise<FakeRecurringExpenseTemplate>;
    delete(args: { where: { id: string } }): Promise<FakeRecurringExpenseTemplate>;
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
    findUnique(args: { where: { id: string } }): Promise<FakeTransaction | null>;
    findFirst(args: {
      where:
        | { categoryMonthId: string }
        | { categoryMonthId: { in: string[] } }
        | { recurringExpenseInstanceId: string };
    }): Promise<FakeTransaction | null>;
    findMany(args: {
      where:
        | { categoryMonthId: { in: string[] }; userId?: string }
        | { recurringExpenseInstanceId: { in: string[] } };
    }): Promise<FakeTransaction[]>;
    create(args: {
      data: {
        userId: string;
        categoryMonthId: string;
        recurringExpenseInstanceId?: string | null;
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
  recurringExpenseTemplates: FakeRecurringExpenseTemplate[];
  recurringExpenseInstances: FakeRecurringExpenseInstance[];
  transactions: FakeTransaction[];
  $transaction<T>(callback: (tx: FakeDelegates) => Promise<T>): Promise<T>;
}

/**
 * A minimal in-memory stand-in for the slice of PrismaClient the category
 * and recurring-expense services depend on (kept as one shared fake rather
 * than one per service — they compose each other too much to keep separate
 * copies in sync). Used instead of per-call jest mocks so tests exercise
 * real lookup/update semantics without a live DB. $transaction is a plain
 * pass-through (no real isolation) — same simplification the auth
 * service's fake makes, since these tests care about the resulting calls,
 * not true DB transaction semantics — with one exception: rollback-on-throw
 * is simulated (snapshot every array, restore it if the callback throws),
 * since real code now depends on a thrown error inside $transaction
 * actually undoing everything the callback wrote, not just the final step.
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
      // Deep-cloned, not just a shallow array copy — the delegates below
      // mutate rows in place via Object.assign(row, data), so a shallow
      // snapshot would restore array membership on rollback but leave an
      // in-place update from earlier in the same transaction un-undone.
      const snapshot = {
        categories: categories.map((row) => ({ ...row })),
        budgetMonths: budgetMonths.map((row) => ({ ...row })),
        categoryMonths: categoryMonths.map((row) => ({ ...row })),
        recurringExpenseTemplates: recurringExpenseTemplates.map((row) => ({ ...row })),
        recurringExpenseInstances: recurringExpenseInstances.map((row) => ({ ...row })),
        transactions: transactions.map((row) => ({ ...row })),
      };
      try {
        return await callback(client);
      } catch (error) {
        categories.length = 0;
        categories.push(...snapshot.categories);
        budgetMonths.length = 0;
        budgetMonths.push(...snapshot.budgetMonths);
        categoryMonths.length = 0;
        categoryMonths.push(...snapshot.categoryMonths);
        recurringExpenseTemplates.length = 0;
        recurringExpenseTemplates.push(...snapshot.recurringExpenseTemplates);
        recurringExpenseInstances.length = 0;
        recurringExpenseInstances.push(...snapshot.recurringExpenseInstances);
        transactions.length = 0;
        transactions.push(...snapshot.transactions);
        throw error;
      }
    },
    async $queryRaw() {
      return [];
    },
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
        if ('categoryId_monthId' in where) {
          const { categoryId, monthId } = where.categoryId_monthId;
          return (
            categoryMonths.find((cm) => cm.categoryId === categoryId && cm.monthId === monthId) ?? null
          );
        }
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
        // Mimics the real onDelete: Restrict FK from transactions —
        // simulates a transaction landing between an app-level "no
        // referencing transactions" check and this delete.
        if (transactions.some((t) => t.categoryMonthId === where.id)) {
          throw new FakeForeignKeyConstraintError();
        }
        const [row] = categoryMonths.splice(index, 1);
        return row!;
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
        if ('categoryId' in where) {
          return recurringExpenseTemplates.filter((t) => t.categoryId === where.categoryId);
        }
        return recurringExpenseTemplates.filter((t) => t.userId === where.userId);
      },
      async update({ where, data }) {
        const row = recurringExpenseTemplates.find((t) => t.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        row.updatedAt = nextTimestamp();
        return row;
      },
      async delete({ where }) {
        const index = recurringExpenseTemplates.findIndex((t) => t.id === where.id);
        if (index === -1) throw new Error('not found');
        // Mimics the real onDelete: Restrict FK from recurring_expense_instances —
        // simulates an instance landing between an app-level "no active
        // instances" check and this delete.
        if (recurringExpenseInstances.some((i) => i.templateId === where.id)) {
          throw new FakeForeignKeyConstraintError();
        }
        const [row] = recurringExpenseTemplates.splice(index, 1);
        return row!;
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
      async findUnique({ where }) {
        return transactions.find((t) => t.id === where.id) ?? null;
      },
      async findFirst({ where }) {
        if ('recurringExpenseInstanceId' in where) {
          return (
            transactions.find((t) => t.recurringExpenseInstanceId === where.recurringExpenseInstanceId) ??
            null
          );
        }
        if ('categoryMonthId' in where && typeof where.categoryMonthId === 'string') {
          const categoryMonthId = where.categoryMonthId;
          return transactions.find((t) => t.categoryMonthId === categoryMonthId) ?? null;
        }
        const ids = (where.categoryMonthId as { in: string[] }).in;
        return transactions.find((t) => ids.includes(t.categoryMonthId)) ?? null;
      },
      async findMany({ where }) {
        if ('recurringExpenseInstanceId' in where) {
          const ids = where.recurringExpenseInstanceId.in;
          return transactions.filter(
            (t) => t.recurringExpenseInstanceId !== null && ids.includes(t.recurringExpenseInstanceId),
          );
        }
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
          recurringExpenseInstanceId: data.recurringExpenseInstanceId ?? null,
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

  return client;
}

export type FakePrisma = FakePrismaClient;
