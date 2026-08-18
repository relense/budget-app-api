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
}

export interface FakeRefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  deviceLabel: string | null;
  expiresAt: Date;
  revoked: boolean;
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
  };
  user: {
    upsert(args: {
      where: { email: string };
      create: { email: string };
      update: Record<string, never>;
    }): Promise<FakeUser>;
  };
  refreshToken: {
    create(args: {
      data: { userId: string; tokenHash: string; deviceLabel: string | null; expiresAt: Date };
    }): Promise<FakeRefreshToken>;
    findFirst(args: { where: { tokenHash: string } }): Promise<FakeRefreshToken | null>;
    update(args: {
      where: { id: string };
      data: Partial<Pick<FakeRefreshToken, 'revoked'>>;
    }): Promise<FakeRefreshToken>;
    updateMany(args: {
      where: { tokenHash: string } | { userId: string };
      data: Partial<Pick<FakeRefreshToken, 'revoked'>>;
    }): Promise<{ count: number }>;
  };
}

interface FakePrismaClient extends FakeDelegates {
  otpCodes: FakeOtpCode[];
  users: FakeUser[];
  refreshTokens: FakeRefreshToken[];
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

  const client: FakePrismaClient = {
    otpCodes,
    users,
    refreshTokens,
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
    },
    user: {
      async upsert({ where, create }) {
        const existing = users.find((u) => u.email === where.email);
        if (existing) return existing;
        const row: FakeUser = { id: randomUUID(), email: create.email };
        users.push(row);
        return row;
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
        };
        refreshTokens.push(row);
        return row;
      },
      async findFirst({ where }) {
        return refreshTokens.find((row) => row.tokenHash === where.tokenHash) ?? null;
      },
      async update({ where, data }) {
        const row = refreshTokens.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
      async updateMany({ where, data }) {
        const matches = refreshTokens.filter((row) =>
          'tokenHash' in where ? row.tokenHash === where.tokenHash : row.userId === where.userId,
        );
        matches.forEach((row) => Object.assign(row, data));
        return { count: matches.length };
      },
    },
    async $transaction(callback) {
      return callback(client);
    },
  };

  return client;
}

export type FakePrisma = FakePrismaClient;
