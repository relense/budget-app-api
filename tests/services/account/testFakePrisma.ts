export interface FakeUser {
  id: string;
  email: string;
  createdAt: Date;
  bankBalanceCheckpointCents: number;
  bankBalanceCheckpointSetAt: Date;
}

export interface FakeCategory {
  id: string;
  userId: string;
  name: string;
}

export interface FakeBudgetMonth {
  id: string;
  userId: string;
  month: string;
}

export interface FakeCategoryMonth {
  id: string;
  userId: string;
  categoryId: string;
  monthId: string;
}

export interface FakeTransaction {
  id: string;
  userId: string;
  categoryMonthId: string;
  recurringExpenseId: string | null;
  amountCents: number;
}

export interface FakeRecurringExpense {
  id: string;
  userId: string;
  monthId: string;
  categoryId: string;
}

export interface FakeSavingsFund {
  id: string;
  userId: string;
  name: string;
}

export interface FakeSavingsMovement {
  id: string;
  userId: string;
  fundId: string;
  amountCents: number;
}

export interface FakeOtpCode {
  id: string;
  email: string;
}

interface FakeDelegates {
  user: {
    findUnique(args: { where: { id: string } }): Promise<FakeUser | null>;
    delete(args: { where: { id: string } }): Promise<FakeUser>;
  };
  category: {
    findMany(args: { where: { userId: string } }): Promise<FakeCategory[]>;
    deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
  };
  budgetMonth: {
    findMany(args: { where: { userId: string } }): Promise<FakeBudgetMonth[]>;
    deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
  };
  categoryMonth: {
    findMany(args: { where: { userId: string } }): Promise<FakeCategoryMonth[]>;
    deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
  };
  transaction: {
    findMany(args: { where: { userId: string } }): Promise<FakeTransaction[]>;
    deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
  };
  recurringExpense: {
    findMany(args: { where: { userId: string } }): Promise<FakeRecurringExpense[]>;
    deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
  };
  savingsFund: {
    findMany(args: { where: { userId: string } }): Promise<FakeSavingsFund[]>;
    deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
  };
  savingsMovement: {
    findMany(args: { where: { userId: string } }): Promise<FakeSavingsMovement[]>;
    deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
  };
  otpCode: {
    deleteMany(args: { where: { email: string } }): Promise<{ count: number }>;
  };
}

interface FakePrismaClient extends FakeDelegates {
  users: FakeUser[];
  categories: FakeCategory[];
  budgetMonths: FakeBudgetMonth[];
  categoryMonths: FakeCategoryMonth[];
  transactions: FakeTransaction[];
  recurringExpenses: FakeRecurringExpense[];
  savingsFunds: FakeSavingsFund[];
  savingsMovements: FakeSavingsMovement[];
  otpCodes: FakeOtpCode[];
  $transaction<T>(callback: (tx: FakeDelegates) => Promise<T>): Promise<T>;
}

function byUserId<T extends { userId: string }>(rows: T[], userId: string): T[] {
  return rows.filter((row) => row.userId === userId);
}

function deleteByUserId<T extends { userId: string }>(rows: T[], userId: string): { count: number } {
  const before = rows.length;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]!.userId === userId) rows.splice(i, 1);
  }
  return { count: before - rows.length };
}

export function createFakePrisma(): FakePrismaClient {
  const users: FakeUser[] = [];
  const categories: FakeCategory[] = [];
  const budgetMonths: FakeBudgetMonth[] = [];
  const categoryMonths: FakeCategoryMonth[] = [];
  const transactions: FakeTransaction[] = [];
  const recurringExpenses: FakeRecurringExpense[] = [];
  const savingsFunds: FakeSavingsFund[] = [];
  const savingsMovements: FakeSavingsMovement[] = [];
  const otpCodes: FakeOtpCode[] = [];

  const client: FakePrismaClient = {
    users,
    categories,
    budgetMonths,
    categoryMonths,
    transactions,
    recurringExpenses,
    savingsFunds,
    savingsMovements,
    otpCodes,
    user: {
      async findUnique({ where }) {
        return users.find((u) => u.id === where.id) ?? null;
      },
      async delete({ where }) {
        const index = users.findIndex((u) => u.id === where.id);
        if (index === -1) throw new Error('not found');
        const [row] = users.splice(index, 1);
        return row!;
      },
    },
    category: {
      async findMany({ where }) {
        return byUserId(categories, where.userId);
      },
      async deleteMany({ where }) {
        return deleteByUserId(categories, where.userId);
      },
    },
    budgetMonth: {
      async findMany({ where }) {
        return byUserId(budgetMonths, where.userId);
      },
      async deleteMany({ where }) {
        return deleteByUserId(budgetMonths, where.userId);
      },
    },
    categoryMonth: {
      async findMany({ where }) {
        return byUserId(categoryMonths, where.userId);
      },
      async deleteMany({ where }) {
        return deleteByUserId(categoryMonths, where.userId);
      },
    },
    transaction: {
      async findMany({ where }) {
        return byUserId(transactions, where.userId);
      },
      async deleteMany({ where }) {
        return deleteByUserId(transactions, where.userId);
      },
    },
    recurringExpense: {
      async findMany({ where }) {
        return byUserId(recurringExpenses, where.userId);
      },
      async deleteMany({ where }) {
        return deleteByUserId(recurringExpenses, where.userId);
      },
    },
    savingsFund: {
      async findMany({ where }) {
        return byUserId(savingsFunds, where.userId);
      },
      async deleteMany({ where }) {
        return deleteByUserId(savingsFunds, where.userId);
      },
    },
    savingsMovement: {
      async findMany({ where }) {
        return byUserId(savingsMovements, where.userId);
      },
      async deleteMany({ where }) {
        return deleteByUserId(savingsMovements, where.userId);
      },
    },
    otpCode: {
      async deleteMany({ where }) {
        const before = otpCodes.length;
        for (let i = otpCodes.length - 1; i >= 0; i -= 1) {
          if (otpCodes[i]!.email === where.email) otpCodes.splice(i, 1);
        }
        return { count: before - otpCodes.length };
      },
    },
    async $transaction(callback) {
      return callback(client);
    },
  };

  return client;
}

export type FakePrisma = FakePrismaClient;
