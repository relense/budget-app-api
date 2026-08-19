import type { PrismaClient } from '../../lib/prisma.js';
import { hasPrismaErrorCode } from '../../lib/prismaErrors.js';

export type MovementType = 'deposit' | 'withdraw';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export interface CreateSavingsMovementInput {
  fundId: string;
  amountCents: number;
  type: MovementType;
  date: string;
}

/** fundId deliberately absent — a movement can't be reassigned to a different fund on update, only its own amount/type/date. */
export interface UpdateSavingsMovementInput {
  amountCents: number;
  type: MovementType;
  date: string;
}

export type SavingsMovementServiceErrorReason =
  | 'invalid_amount'
  | 'invalid_date'
  | 'movement_not_found'
  | 'fund_not_found'
  | 'insufficient_funds';

export class SavingsMovementServiceError extends Error {
  constructor(public readonly reason: SavingsMovementServiceErrorReason) {
    super(`SavingsMovement operation failed: ${reason}`);
    this.name = 'SavingsMovementServiceError';
  }
}

export interface SavingsMovementServiceDeps {
  prisma: Pick<PrismaClient, 'savingsFund' | 'savingsMovement' | '$transaction' | '$queryRaw'>;
}

function assertValidAmount(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new SavingsMovementServiceError('invalid_amount');
  }
}

function assertValidDate(date: string): void {
  if (!DATE_REGEX.test(date)) {
    throw new SavingsMovementServiceError('invalid_date');
  }
}

function signedDelta(amountCents: number, type: MovementType): number {
  return type === 'deposit' ? amountCents : -amountCents;
}

/**
 * SUM of every movement against fundId, deposits positive and withdrawals
 * negative — the running net, before initialBalanceCents is added. No
 * userId parameter, unlike the findManyByIds-style batch functions
 * elsewhere — safe because fundId can only ever be one this user owns
 * (every call site here re-checks ownership before calling this), same
 * reasoning as recurringExpenseService.sumCommittedCentsForCategoryMonth.
 */
async function computeNetMovementCents(
  client: Pick<PrismaClient, 'savingsMovement'>,
  fundId: string,
  excludeMovementId?: string,
): Promise<number> {
  const movements = await client.savingsMovement.findMany({ where: { fundId } });
  return movements
    .filter((movement) => movement.id !== excludeMovementId)
    .reduce((sum, movement) => sum + signedDelta(movement.amountCents, movement.type), 0);
}

/**
 * Takes a row lock (SELECT ... FOR UPDATE) on one SavingsFund — must be
 * called inside a $transaction. Every write path below takes this before
 * computing the resulting balance, so two concurrent movements against the
 * same fund can never both read the same "current balance" and both think
 * an overdraft is safe — same reasoning as lockBudgetMonthRow.
 */
async function lockSavingsFundRow(client: Pick<PrismaClient, '$queryRaw'>, fundId: string): Promise<void> {
  await client.$queryRaw`SELECT id FROM savings_funds WHERE id = ${fundId} FOR UPDATE`;
}

export function createSavingsMovementService({ prisma }: SavingsMovementServiceDeps) {
  async function findOwnedFund(client: Pick<PrismaClient, 'savingsFund'>, userId: string, fundId: string) {
    const fund = await client.savingsFund.findUnique({ where: { id: fundId } });
    if (!fund || fund.userId !== userId) {
      throw new SavingsMovementServiceError('fund_not_found');
    }
    return fund;
  }

  async function findOwnedMovement(userId: string, id: string) {
    const movement = await prisma.savingsMovement.findUnique({ where: { id } });
    if (!movement || movement.userId !== userId) {
      throw new SavingsMovementServiceError('movement_not_found');
    }
    return movement;
  }

  async function createSavingsMovement(userId: string, input: CreateSavingsMovementInput) {
    assertValidAmount(input.amountCents);
    assertValidDate(input.date);
    // Cheap fail-fast before opening a transaction for a request that's
    // going to fail regardless.
    await findOwnedFund(prisma, userId, input.fundId);

    return prisma.$transaction(async (tx) => {
      await lockSavingsFundRow(tx, input.fundId);
      const fund = await findOwnedFund(tx, userId, input.fundId);
      const net = await computeNetMovementCents(tx, input.fundId);
      const resultingBalance = fund.initialBalanceCents + net + signedDelta(input.amountCents, input.type);
      if (resultingBalance < 0) {
        throw new SavingsMovementServiceError('insufficient_funds');
      }

      return tx.savingsMovement.create({
        data: {
          userId,
          fundId: input.fundId,
          amountCents: input.amountCents,
          type: input.type,
          date: new Date(input.date),
        },
      });
    });
  }

  async function updateSavingsMovement(userId: string, id: string, input: UpdateSavingsMovementInput) {
    assertValidAmount(input.amountCents);
    assertValidDate(input.date);
    const existing = await findOwnedMovement(userId, id);

    return prisma.$transaction(async (tx) => {
      await lockSavingsFundRow(tx, existing.fundId);
      const fund = await findOwnedFund(tx, userId, existing.fundId);
      const netExcludingThis = await computeNetMovementCents(tx, existing.fundId, id);
      const resultingBalance =
        fund.initialBalanceCents + netExcludingThis + signedDelta(input.amountCents, input.type);
      if (resultingBalance < 0) {
        throw new SavingsMovementServiceError('insufficient_funds');
      }

      try {
        // Re-checked here, not just via the pre-transaction findOwnedMovement
        // above: a concurrent update/delete of this same movement (e.g. a
        // double-click, or a race between two devices) could have removed
        // the row in the gap between that check and this write, landing
        // after this call serializes on the fund's lock. Mapped to the same
        // typed error findOwnedMovement would have thrown, rather than
        // letting Prisma's raw P2025 through — same "pre-check plus DB-level
        // backstop" pattern this codebase already uses for referential
        // integrity (e.g. deleteSavingsFund's P2003 catch), applied here to
        // existence instead. Caught and immediately rethrown, with no
        // further query on tx afterward, so this doesn't reopen the
        // transaction-poisoning issue withSavepoint exists for (see
        // src/lib/prismaSavepoint.ts) — a plain rollback on throw is safe.
        return await tx.savingsMovement.update({
          where: { id },
          data: {
            amountCents: input.amountCents,
            type: input.type,
            date: new Date(input.date),
          },
        });
      } catch (error) {
        if (hasPrismaErrorCode(error, 'P2025')) {
          throw new SavingsMovementServiceError('movement_not_found');
        }
        throw error;
      }
    });
  }

  async function deleteSavingsMovement(userId: string, id: string): Promise<void> {
    const existing = await findOwnedMovement(userId, id);

    await prisma.$transaction(async (tx) => {
      await lockSavingsFundRow(tx, existing.fundId);
      const fund = await findOwnedFund(tx, userId, existing.fundId);
      const netExcludingThis = await computeNetMovementCents(tx, existing.fundId, id);
      const resultingBalance = fund.initialBalanceCents + netExcludingThis;
      if (resultingBalance < 0) {
        // Removing this movement's effect would make the fund's balance
        // negative — e.g. deleting a deposit that a later, still-logged
        // withdrawal already depends on to stay non-negative.
        throw new SavingsMovementServiceError('insufficient_funds');
      }

      try {
        // Same concurrent-double-submit reasoning as updateSavingsMovement's
        // identical catch above.
        await tx.savingsMovement.delete({ where: { id } });
      } catch (error) {
        if (hasPrismaErrorCode(error, 'P2025')) {
          throw new SavingsMovementServiceError('movement_not_found');
        }
        throw error;
      }
    });
  }

  /** Batch lookup for DataLoader use — trusts the caller to have already scoped the ids to one user. */
  async function listByFundIds(fundIds: string[]) {
    if (fundIds.length === 0) return [];
    return prisma.savingsMovement.findMany({ where: { fundId: { in: fundIds } } });
  }

  /**
   * currentAmountCents for a fund — initialBalanceCents plus the net of
   * every movement against it. Computed fresh, never stored (see
   * SavingsFund's schema comment) — same reasoning as
   * recurringExpenseService.sumCommittedCentsForCategoryMonth.
   */
  async function computeCurrentAmountCents(fundId: string, initialBalanceCents: number): Promise<number> {
    const net = await computeNetMovementCents(prisma, fundId);
    return initialBalanceCents + net;
  }

  return {
    createSavingsMovement,
    updateSavingsMovement,
    deleteSavingsMovement,
    listByFundIds,
    computeCurrentAmountCents,
  };
}

export type SavingsMovementService = ReturnType<typeof createSavingsMovementService>;
