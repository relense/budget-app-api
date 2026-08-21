import { randomUUID } from 'node:crypto';

export interface FakeOtpCode {
  id: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
  used: boolean;
  failedAttempts: number;
  createdAt: Date;
}

export interface FakeUser {
  id: string;
  email: string;
  defaultCategoriesSeededAt: Date | null;
}

export type FakeBudgetType = 'need' | 'want' | 'savings';
export type FakeDirection = 'expense' | 'income';

export interface FakeCategory {
  id: string;
  userId: string;
  name: string;
  icon: string;
  color: string;
  budgetType: FakeBudgetType;
  direction: FakeDirection;
}

/** Mimics the shape of Prisma's PrismaClientKnownRequestError for P2002 (unique constraint). */
export class FakeUniqueConstraintError extends Error {
  readonly code = 'P2002';
  constructor() {
    super('Unique constraint failed');
  }
}

export interface FakeRefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  deviceLabel: string | null;
  expiresAt: Date;
  revoked: boolean;
  revokedAt: Date | null;
}

interface FakeDelegates {
  otpCode: {
    create(args: {
      data: { email: string; codeHash: string; expiresAt: Date };
    }): Promise<FakeOtpCode>;
    findFirst(args: { where: { email: string } }): Promise<FakeOtpCode | null>;
    update(args: {
      where: { id: string };
      data: Partial<Pick<FakeOtpCode, 'used'>> & {
        failedAttempts?: number | { increment: number };
      };
    }): Promise<FakeOtpCode>;
    findMany(args: {
      where: { expiresAt: { lt: Date } } | { used: true };
      select: { id: true };
      take: number;
    }): Promise<Array<{ id: string }>>;
    deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }>;
  };
  user: {
    create(args: { data: { email: string } }): Promise<FakeUser>;
    findUnique(args: { where: { email: string } }): Promise<FakeUser | null>;
    update(args: {
      where: { id: string };
      data: Partial<Pick<FakeUser, 'defaultCategoriesSeededAt'>>;
    }): Promise<FakeUser>;
  };
  category: {
    createMany(args: {
      data: Array<Omit<FakeCategory, 'id'>>;
    }): Promise<{ count: number }>;
  };
  refreshToken: {
    create(args: {
      data: { userId: string; tokenHash: string; deviceLabel: string | null; expiresAt: Date };
    }): Promise<FakeRefreshToken>;
    findFirst(args: {
      where: { tokenHash: string } | { userId: string };
    }): Promise<FakeRefreshToken | null>;
    update(args: {
      where: { id: string };
      data: Partial<Pick<FakeRefreshToken, 'revoked' | 'revokedAt'>>;
    }): Promise<FakeRefreshToken>;
    updateMany(args: {
      where: Partial<Pick<FakeRefreshToken, 'id' | 'tokenHash' | 'userId' | 'revoked'>>;
      data: Partial<Pick<FakeRefreshToken, 'revoked' | 'revokedAt'>>;
    }): Promise<{ count: number }>;
    findMany(args: {
      where: { expiresAt: { lt: Date } } | { revoked: true; revokedAt: { lt: Date } };
      select: { id: true };
      take: number;
    }): Promise<Array<{ id: string }>>;
    deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }>;
  };
}

interface FakePrismaClient extends FakeDelegates {
  otpCodes: FakeOtpCode[];
  users: FakeUser[];
  refreshTokens: FakeRefreshToken[];
  categories: FakeCategory[];
  $transaction<T>(callback: (tx: FakeDelegates) => Promise<T>): Promise<T>;
}

/**
 * A minimal in-memory stand-in for the slice of PrismaClient authService
 * depends on. Used instead of per-call jest mocks so tests exercise real
 * lookup/update semantics (including $transaction) without a live DB.
 */
export function createFakePrisma(): FakePrismaClient {
  const otpCodes: FakeOtpCode[] = [];
  const users: FakeUser[] = [];
  const refreshTokens: FakeRefreshToken[] = [];
  const categories: FakeCategory[] = [];

  const client: FakePrismaClient = {
    otpCodes,
    users,
    refreshTokens,
    categories,
    otpCode: {
      async create({ data }) {
        const row: FakeOtpCode = {
          id: randomUUID(),
          email: data.email,
          codeHash: data.codeHash,
          expiresAt: data.expiresAt,
          used: false,
          failedAttempts: 0,
          createdAt: new Date(),
        };
        otpCodes.push(row);
        return row;
      },
      async findFirst({ where }) {
        const matches = otpCodes
          .filter((row) => row.email === where.email)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return matches[0] ?? null;
      },
      async update({ where, data }) {
        const row = otpCodes.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        if (data.used !== undefined) row.used = data.used;
        if (typeof data.failedAttempts === 'number') {
          row.failedAttempts = data.failedAttempts;
        } else if (data.failedAttempts !== undefined) {
          row.failedAttempts += data.failedAttempts.increment;
        }
        return row;
      },
      async findMany({ where, take }) {
        const matches =
          'used' in where
            ? otpCodes.filter((row) => row.used === true)
            : otpCodes.filter((row) => row.expiresAt.getTime() < where.expiresAt.lt.getTime());
        return matches.slice(0, take).map((row) => ({ id: row.id }));
      },
      async deleteMany({ where }) {
        const ids = new Set(where.id.in);
        const before = otpCodes.length;
        for (let i = otpCodes.length - 1; i >= 0; i -= 1) {
          if (ids.has(otpCodes[i]!.id)) otpCodes.splice(i, 1);
        }
        return { count: before - otpCodes.length };
      },
    },
    user: {
      async create({ data }) {
        if (users.some((u) => u.email === data.email)) {
          throw new FakeUniqueConstraintError();
        }
        const row: FakeUser = {
          id: randomUUID(),
          email: data.email,
          defaultCategoriesSeededAt: null,
        };
        users.push(row);
        return row;
      },
      async findUnique({ where }) {
        return users.find((u) => u.email === where.email) ?? null;
      },
      async update({ where, data }) {
        const row = users.find((u) => u.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
    },
    category: {
      async createMany({ data }) {
        const rows: FakeCategory[] = data.map((entry) => ({ id: randomUUID(), ...entry }));
        categories.push(...rows);
        return { count: rows.length };
      },
    },
    refreshToken: {
      async create({ data }) {
        const row: FakeRefreshToken = {
          id: randomUUID(),
          userId: data.userId,
          tokenHash: data.tokenHash,
          deviceLabel: data.deviceLabel,
          expiresAt: data.expiresAt,
          revoked: false,
          revokedAt: null,
        };
        refreshTokens.push(row);
        return row;
      },
      async findFirst({ where }) {
        if ('tokenHash' in where) {
          return refreshTokens.find((row) => row.tokenHash === where.tokenHash) ?? null;
        }
        return refreshTokens.find((row) => row.userId === where.userId) ?? null;
      },
      async update({ where, data }) {
        const row = refreshTokens.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
      async updateMany({ where, data }) {
        const matches = refreshTokens.filter((row) => {
          if (where.id !== undefined && row.id !== where.id) return false;
          if (where.tokenHash !== undefined && row.tokenHash !== where.tokenHash) return false;
          if (where.userId !== undefined && row.userId !== where.userId) return false;
          if (where.revoked !== undefined && row.revoked !== where.revoked) return false;
          return true;
        });
        matches.forEach((row) => Object.assign(row, data));
        return { count: matches.length };
      },
      async findMany({ where, take }) {
        const matches =
          'revoked' in where
            ? refreshTokens.filter(
                (row) =>
                  row.revoked === true &&
                  row.revokedAt !== null &&
                  row.revokedAt.getTime() < where.revokedAt.lt.getTime(),
              )
            : refreshTokens.filter(
                (row) => row.expiresAt.getTime() < where.expiresAt.lt.getTime(),
              );
        return matches.slice(0, take).map((row) => ({ id: row.id }));
      },
      async deleteMany({ where }) {
        const ids = new Set(where.id.in);
        const before = refreshTokens.length;
        for (let i = refreshTokens.length - 1; i >= 0; i -= 1) {
          if (ids.has(refreshTokens[i]!.id)) refreshTokens.splice(i, 1);
        }
        return { count: before - refreshTokens.length };
      },
    },
    async $transaction(callback) {
      return callback(client);
    },
  };

  return client;
}

export type FakePrisma = FakePrismaClient;
