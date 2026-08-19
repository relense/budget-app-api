import { randomUUID } from 'node:crypto';
import {
  createFakeBudgetMonthDelegate,
  FakeForeignKeyConstraintError,
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

export interface FakeRecurringExpense {
  id: string;
  userId: string;
  monthId: string;
  categoryId: string;
  name: string;
  amountCents: number;
  budgetType: FakeRecurringBudgetType;
  dueDay: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeTransaction {
  id: string;
  userId: string;
  categoryMonthId: string;
  recurringExpenseId: string | null;
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
  /**
   * No-op — the fake has no real Postgres, so it can't simulate row-level
   * locking. Only proves the code calls it in the right places; real
   * concurrency-safety for lockTemplateRow's callers needs verification
   * against a live database.
   */
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  /**
   * No-op — the fake can't reproduce Postgres's transaction-abort semantics
   * (see withSavepoint's doc comment), so there's nothing for a SAVEPOINT to
   * protect here. Real safety for withSavepoint's callers is verified
   * against a live database.
   */
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
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
      where: { userId: string } | { id: { in: string[] } };
    }): Promise<FakeCategory[]>;
    update(args: {
      where: { id: string };
      data: Partial<Pick<FakeCategory, 'name' | 'icon' | 'color' | 'budgetType' | 'direction'>>;
    }): Promise<FakeCategory>;
    delete(args: { where: { id: string } }): Promise<FakeCategory>;
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
  recurringExpense: {
    create(args: {
      data: {
        userId: string;
        monthId: string;
        categoryId: string;
        name: string;
        amountCents: number;
        budgetType: FakeRecurringBudgetType;
        dueDay: number;
      };
    }): Promise<FakeRecurringExpense>;
    findUnique(args: { where: { id: string } }): Promise<FakeRecurringExpense | null>;
    findFirst(args: {
      where: Partial<Pick<FakeRecurringExpense, 'categoryId' | 'monthId'>>;
    }): Promise<FakeRecurringExpense | null>;
    findMany(args: {
      where:
        | Partial<Pick<FakeRecurringExpense, 'userId' | 'categoryId' | 'monthId'>>
        | { id: { in: string[] } };
    }): Promise<FakeRecurringExpense[]>;
    update(args: {
      where: { id: string };
      data: Partial<
        Pick<FakeRecurringExpense, 'name' | 'amountCents' | 'categoryId' | 'budgetType' | 'dueDay'>
      >;
    }): Promise<FakeRecurringExpense>;
    delete(args: { where: { id: string } }): Promise<FakeRecurringExpense>;
  };
  transaction: {
    findUnique(args: { where: { id: string } }): Promise<FakeTransaction | null>;
    findFirst(args: {
      where:
        | { categoryMonthId: string }
        | { categoryMonthId: { in: string[] } }
        | { recurringExpenseId: string };
    }): Promise<FakeTransaction | null>;
    findMany(args: {
      where:
        | { categoryMonthId: { in: string[] }; userId?: string }
        | { recurringExpenseId: { in: string[] } };
    }): Promise<FakeTransaction[]>;
    create(args: {
      data: {
        userId: string;
        categoryMonthId: string;
        recurringExpenseId?: string | null;
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
  recurringExpenses: FakeRecurringExpense[];
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
  const recurringExpenses: FakeRecurringExpense[] = [];
  const transactions: FakeTransaction[] = [];

  const client: FakePrismaClient = {
    categories,
    budgetMonths,
    categoryMonths,
    recurringExpenses,
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
        recurringExpenses: recurringExpenses.map((row) => ({ ...row })),
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
        recurringExpenses.length = 0;
        recurringExpenses.push(...snapshot.recurringExpenses);
        transactions.length = 0;
        transactions.push(...snapshot.transactions);
        throw error;
      }
    },
    async $queryRaw() {
      return [];
    },
    async $executeRawUnsafe() {
      return 0;
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
        return categories.filter((c) => c.userId === where.userId);
      },
      async update({ where, data }) {
        const row = categories.find((c) => c.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        row.updatedAt = nextTimestamp();
        return row;
      },
      async delete({ where }) {
        const index = categories.findIndex((c) => c.id === where.id);
        if (index === -1) throw new Error('not found');
        // Mimics the real onDelete: Restrict FKs from category_month and
        // recurring_expenses — simulates either landing between an
        // app-level "no active months" check and this delete.
        if (
          categoryMonths.some((cm) => cm.categoryId === where.id) ||
          recurringExpenses.some((re) => re.categoryId === where.id)
        ) {
          throw new FakeForeignKeyConstraintError();
        }
        const [row] = categories.splice(index, 1);
        return row!;
      },
    },
    budgetMonth: createFakeBudgetMonthDelegate(budgetMonths, { categoryMonths, recurringExpenses }),
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
    recurringExpense: {
      async create({ data }) {
        // Mirrors the real @@unique([monthId, name]) — scoped per month,
        // not global (see docs/PLAN.md's Data Model note on why: "Rent" can
        // exist once in October and once in November, just never twice in
        // the same month).
        const duplicate = recurringExpenses.find(
          (re) => re.monthId === data.monthId && re.name === data.name,
        );
        if (duplicate) throw new FakeUniqueConstraintError();

        const row: FakeRecurringExpense = {
          id: randomUUID(),
          userId: data.userId,
          monthId: data.monthId,
          categoryId: data.categoryId,
          name: data.name,
          amountCents: data.amountCents,
          budgetType: data.budgetType,
          dueDay: data.dueDay,
          createdAt: nextTimestamp(),
          updatedAt: nextTimestamp(),
        };
        recurringExpenses.push(row);
        return row;
      },
      async findUnique({ where }) {
        return recurringExpenses.find((re) => re.id === where.id) ?? null;
      },
      async findFirst({ where }) {
        return (
          recurringExpenses.find((re) => {
            if (where.categoryId !== undefined && re.categoryId !== where.categoryId) return false;
            if (where.monthId !== undefined && re.monthId !== where.monthId) return false;
            return true;
          }) ?? null
        );
      },
      async findMany({ where }) {
        if ('id' in where) {
          return recurringExpenses.filter((re) => where.id.in.includes(re.id));
        }
        return recurringExpenses.filter((re) => {
          if (where.userId !== undefined && re.userId !== where.userId) return false;
          if (where.categoryId !== undefined && re.categoryId !== where.categoryId) return false;
          if (where.monthId !== undefined && re.monthId !== where.monthId) return false;
          return true;
        });
      },
      async update({ where, data }) {
        const row = recurringExpenses.find((re) => re.id === where.id);
        if (!row) throw new Error('not found');
        // Mirrors the real @@unique([monthId, name]) on UPDATE too, not
        // just create — a rename can collide just as easily as a fresh
        // insert.
        if (data.name !== undefined) {
          const duplicate = recurringExpenses.find(
            (re) => re.id !== where.id && re.monthId === row.monthId && re.name === data.name,
          );
          if (duplicate) throw new FakeUniqueConstraintError();
        }
        Object.assign(row, data);
        row.updatedAt = nextTimestamp();
        return row;
      },
      async delete({ where }) {
        const index = recurringExpenses.findIndex((re) => re.id === where.id);
        if (index === -1) throw new Error('not found');
        if (transactions.some((t) => t.recurringExpenseId === where.id)) {
          throw new FakeForeignKeyConstraintError();
        }
        const [row] = recurringExpenses.splice(index, 1);
        return row!;
      },
    },
    transaction: {
      async findUnique({ where }) {
        return transactions.find((t) => t.id === where.id) ?? null;
      },
      async findFirst({ where }) {
        if ('recurringExpenseId' in where) {
          return (
            transactions.find((t) => t.recurringExpenseId === where.recurringExpenseId) ??
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
        if ('recurringExpenseId' in where) {
          const ids = where.recurringExpenseId.in;
          return transactions.filter(
            (t) => t.recurringExpenseId !== null && ids.includes(t.recurringExpenseId),
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
          recurringExpenseId: data.recurringExpenseId ?? null,
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
