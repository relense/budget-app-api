import { randomUUID } from 'node:crypto';

export type FakeDirection = 'expense' | 'income';

export interface FakeUser {
  id: string;
  bankBalanceCheckpointCents: number;
  bankBalanceCheckpointSetAt: Date;
}

export interface FakeTransaction {
  id: string;
  userId: string;
  amountCents: number;
  direction: FakeDirection;
  createdAt: Date;
}

interface FakeDelegates {
  user: {
    findUnique(args: { where: { id: string } }): Promise<FakeUser | null>;
    update(args: {
      where: { id: string };
      data: { bankBalanceCheckpointCents: number; bankBalanceCheckpointSetAt: Date };
    }): Promise<FakeUser>;
  };
  transaction: {
    findMany(args: {
      where: { userId: string; createdAt: { gt: Date } };
    }): Promise<FakeTransaction[]>;
  };
}

interface FakePrismaClient extends FakeDelegates {
  users: FakeUser[];
  transactions: FakeTransaction[];
}

/**
 * Minimal in-memory stand-in for the slice of PrismaClient
 * bankBalanceService depends on. transactions here are seeded directly
 * (via the `transactions` array), bypassing the categories domain's full
 * category/categoryMonth chain entirely — bankBalanceService only ever
 * reads transactions, so a flat { userId, amountCents, direction,
 * createdAt } row is all it needs, decoupled from the categories fake.
 */
export function createFakePrisma(): FakePrismaClient {
  const users: FakeUser[] = [];
  const transactions: FakeTransaction[] = [];

  const client: FakePrismaClient = {
    users,
    transactions,
    user: {
      async findUnique({ where }) {
        return users.find((u) => u.id === where.id) ?? null;
      },
      async update({ where, data }) {
        const row = users.find((u) => u.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
    },
    transaction: {
      async findMany({ where }) {
        return transactions.filter(
          (t) => t.userId === where.userId && t.createdAt.getTime() > where.createdAt.gt.getTime(),
        );
      },
    },
  };

  return client;
}

export type FakePrisma = FakePrismaClient;

export function seedUser(prisma: FakePrismaClient, user: Partial<FakeUser> & { id: string }): FakeUser {
  const row: FakeUser = {
    bankBalanceCheckpointCents: 0,
    bankBalanceCheckpointSetAt: new Date('2026-01-01T00:00:00.000Z'),
    ...user,
  };
  prisma.users.push(row);
  return row;
}

export function seedTransaction(
  prisma: FakePrismaClient,
  transaction: Partial<FakeTransaction> & { userId: string; amountCents: number; direction: FakeDirection },
): FakeTransaction {
  const row: FakeTransaction = {
    id: randomUUID(),
    createdAt: new Date(),
    ...transaction,
  };
  prisma.transactions.push(row);
  return row;
}
