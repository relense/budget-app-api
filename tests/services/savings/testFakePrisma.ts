import { randomUUID } from 'node:crypto';

let lastTimestampMs = 0;
function nextTimestamp(): Date {
  const now = Date.now();
  lastTimestampMs = now > lastTimestampMs ? now : lastTimestampMs + 1;
  return new Date(lastTimestampMs);
}

export type FakeMovementType = 'deposit' | 'withdraw';

export interface FakeSavingsFund {
  id: string;
  userId: string;
  name: string;
  targetAmountCents: number | null;
  initialBalanceCents: number;
  startDate: Date | null;
  endDate: Date | null;
  monthlyTargetCents: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeSavingsMovement {
  id: string;
  userId: string;
  fundId: string;
  amountCents: number;
  type: FakeMovementType;
  date: Date;
  createdAt: Date;
  updatedAt: Date;
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
   * concurrency-safety for lockSavingsFundRow's callers needs verification
   * against a live database.
   */
  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  savingsFund: {
    create(args: {
      data: {
        userId: string;
        name: string;
        targetAmountCents: number | null;
        initialBalanceCents: number;
        startDate: Date | null;
        endDate: Date | null;
        monthlyTargetCents: number | null;
      };
    }): Promise<FakeSavingsFund>;
    findUnique(args: { where: { id: string } }): Promise<FakeSavingsFund | null>;
    findMany(args: { where: { userId: string } | { id: { in: string[] } } }): Promise<FakeSavingsFund[]>;
    update(args: {
      where: { id: string };
      data: Partial<
        Pick<FakeSavingsFund, 'name' | 'targetAmountCents' | 'startDate' | 'endDate' | 'monthlyTargetCents'>
      >;
    }): Promise<FakeSavingsFund>;
    delete(args: { where: { id: string } }): Promise<FakeSavingsFund>;
  };
  savingsMovement: {
    create(args: {
      data: { userId: string; fundId: string; amountCents: number; type: FakeMovementType; date: Date };
    }): Promise<FakeSavingsMovement>;
    findUnique(args: { where: { id: string } }): Promise<FakeSavingsMovement | null>;
    findFirst(args: { where: { fundId: string } }): Promise<FakeSavingsMovement | null>;
    findMany(args: {
      where: { fundId: string } | { fundId: { in: string[] } };
    }): Promise<FakeSavingsMovement[]>;
    update(args: {
      where: { id: string };
      data: Partial<Pick<FakeSavingsMovement, 'amountCents' | 'type' | 'date'>>;
    }): Promise<FakeSavingsMovement>;
    delete(args: { where: { id: string } }): Promise<FakeSavingsMovement>;
  };
}

interface FakePrismaClient extends FakeDelegates {
  savingsFunds: FakeSavingsFund[];
  savingsMovements: FakeSavingsMovement[];
  $transaction<T>(callback: (tx: FakeDelegates) => Promise<T>): Promise<T>;
}

/**
 * A minimal in-memory stand-in for the slice of PrismaClient
 * savingsFundService/savingsMovementService depend on — same "$transaction
 * simulates rollback-on-throw" pattern as the categories fake, since
 * production code depends on that for the overdraft checks to actually
 * roll back a failed movement write.
 */
export function createFakePrisma(): FakePrismaClient {
  const savingsFunds: FakeSavingsFund[] = [];
  const savingsMovements: FakeSavingsMovement[] = [];

  const client: FakePrismaClient = {
    savingsFunds,
    savingsMovements,
    async $transaction(callback) {
      const snapshot = {
        savingsFunds: savingsFunds.map((row) => ({ ...row })),
        savingsMovements: savingsMovements.map((row) => ({ ...row })),
      };
      try {
        return await callback(client);
      } catch (error) {
        savingsFunds.length = 0;
        savingsFunds.push(...snapshot.savingsFunds);
        savingsMovements.length = 0;
        savingsMovements.push(...snapshot.savingsMovements);
        throw error;
      }
    },
    async $queryRaw() {
      return [];
    },
    savingsFund: {
      async create({ data }) {
        const row: FakeSavingsFund = {
          id: randomUUID(),
          userId: data.userId,
          name: data.name,
          targetAmountCents: data.targetAmountCents,
          initialBalanceCents: data.initialBalanceCents,
          startDate: data.startDate,
          endDate: data.endDate,
          monthlyTargetCents: data.monthlyTargetCents,
          createdAt: nextTimestamp(),
          updatedAt: nextTimestamp(),
        };
        savingsFunds.push(row);
        return row;
      },
      async findUnique({ where }) {
        return savingsFunds.find((f) => f.id === where.id) ?? null;
      },
      async findMany({ where }) {
        if ('id' in where) {
          return savingsFunds.filter((f) => where.id.in.includes(f.id));
        }
        return savingsFunds.filter((f) => f.userId === where.userId);
      },
      async update({ where, data }) {
        const row = savingsFunds.find((f) => f.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        row.updatedAt = nextTimestamp();
        return row;
      },
      async delete({ where }) {
        const index = savingsFunds.findIndex((f) => f.id === where.id);
        if (index === -1) throw new Error('not found');
        // Mimics the real onDelete: Restrict FK from savings_movements —
        // simulates a movement landing between an app-level "no
        // movements" check and this delete.
        if (savingsMovements.some((m) => m.fundId === where.id)) {
          throw new FakeForeignKeyConstraintError();
        }
        const [row] = savingsFunds.splice(index, 1);
        return row!;
      },
    },
    savingsMovement: {
      async create({ data }) {
        const row: FakeSavingsMovement = {
          id: randomUUID(),
          userId: data.userId,
          fundId: data.fundId,
          amountCents: data.amountCents,
          type: data.type,
          date: data.date,
          createdAt: nextTimestamp(),
          updatedAt: nextTimestamp(),
        };
        savingsMovements.push(row);
        return row;
      },
      async findUnique({ where }) {
        return savingsMovements.find((m) => m.id === where.id) ?? null;
      },
      async findFirst({ where }) {
        return savingsMovements.find((m) => m.fundId === where.fundId) ?? null;
      },
      async findMany({ where }) {
        const fundId = where.fundId;
        if (typeof fundId === 'string') {
          return savingsMovements.filter((m) => m.fundId === fundId);
        }
        return savingsMovements.filter((m) => fundId.in.includes(m.fundId));
      },
      async update({ where, data }) {
        const row = savingsMovements.find((m) => m.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        row.updatedAt = nextTimestamp();
        return row;
      },
      async delete({ where }) {
        const index = savingsMovements.findIndex((m) => m.id === where.id);
        if (index === -1) throw new Error('not found');
        const [row] = savingsMovements.splice(index, 1);
        return row!;
      },
    },
  };

  return client;
}

export type FakePrisma = FakePrismaClient;
