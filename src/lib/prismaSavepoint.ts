import type { PrismaClient } from './prisma.js';

/**
 * Runs `attempt` under a SAVEPOINT so a caught error (e.g. a unique/FK
 * violation) doesn't poison the rest of an enclosing `$transaction`. Under
 * Postgres, once any statement in a transaction fails, every later
 * statement is rejected with "current transaction is aborted" until a
 * ROLLBACK or ROLLBACK TO SAVEPOINT runs. Prisma's older query engine used
 * to paper over this transparently; the driver-adapter client this project
 * uses (`@prisma/adapter-pg`, see docs/PLAN.md's Prisma 7 note) doesn't —
 * confirmed by a real-Postgres repro, not by the fake-Prisma test double,
 * which can't reproduce Postgres's transaction-abort semantics at all. Any
 * "create, catch a conflict, keep querying the same transaction" pattern
 * needs this.
 *
 * `savepointName` must always be a caller-supplied literal (never
 * request/user-controlled) — interpolated directly into the SQL since
 * Postgres doesn't support parameterizing SAVEPOINT/ROLLBACK TO SAVEPOINT
 * identifiers.
 */
export async function withSavepoint<T>(
  tx: Pick<PrismaClient, '$executeRawUnsafe'>,
  savepointName: string,
  attempt: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  await tx.$executeRawUnsafe(`SAVEPOINT ${savepointName}`);
  try {
    const value = await attempt();
    return { ok: true, value };
  } catch (error) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepointName}`);
    return { ok: false, error };
  }
}
