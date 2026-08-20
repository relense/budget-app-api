import { isValidCalendarDate } from '../../lib/dateFormat.js';
import type { PrismaClient } from '../../lib/prisma.js';
import { hasPrismaErrorCode } from '../../lib/prismaErrors.js';

export interface SavingsFundInput {
  name: string;
  targetAmountCents?: number;
  initialBalanceCents: number;
  startDate?: string;
  endDate?: string;
  monthlyTargetCents?: number;
}

/**
 * initialBalanceCents deliberately absent — settable only at creation (see
 * SavingsFundInput), never here. currentAmountCents is computed as
 * initialBalanceCents + the net of every movement (see savingsMovementService),
 * so letting it change after movements exist would silently corrupt that
 * derivation for every movement already logged.
 */
export interface UpdateSavingsFundInput {
  name: string;
  targetAmountCents?: number;
  startDate?: string;
  endDate?: string;
  monthlyTargetCents?: number;
}

export type SavingsFundServiceErrorReason =
  | 'invalid_amount'
  | 'invalid_date'
  | 'invalid_date_range'
  | 'fund_not_found'
  | 'fund_has_movements';

export class SavingsFundServiceError extends Error {
  constructor(public readonly reason: SavingsFundServiceErrorReason) {
    super(`SavingsFund operation failed: ${reason}`);
    this.name = 'SavingsFundServiceError';
  }
}

export interface SavingsFundServiceDeps {
  prisma: Pick<PrismaClient, 'savingsFund' | 'savingsMovement'>;
}

function assertValidAmount(amountCents: number | undefined, required: boolean): void {
  if (amountCents === undefined) {
    if (required) throw new SavingsFundServiceError('invalid_amount');
    return;
  }
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new SavingsFundServiceError('invalid_amount');
  }
}

function assertValidDate(date: string | undefined): void {
  if (date !== undefined && !isValidCalendarDate(date)) {
    throw new SavingsFundServiceError('invalid_date');
  }
}

function assertValidDateRange(startDate: string | undefined, endDate: string | undefined): void {
  if (startDate !== undefined && endDate !== undefined && endDate < startDate) {
    throw new SavingsFundServiceError('invalid_date_range');
  }
}

function assertValidFundInput(input: { targetAmountCents?: number; startDate?: string; endDate?: string; monthlyTargetCents?: number }): void {
  assertValidAmount(input.targetAmountCents, false);
  assertValidAmount(input.monthlyTargetCents, false);
  assertValidDate(input.startDate);
  assertValidDate(input.endDate);
  assertValidDateRange(input.startDate, input.endDate);
}

export function createSavingsFundService({ prisma }: SavingsFundServiceDeps) {
  async function findOwnedFund(userId: string, id: string) {
    const fund = await prisma.savingsFund.findUnique({ where: { id } });
    if (!fund || fund.userId !== userId) {
      throw new SavingsFundServiceError('fund_not_found');
    }
    return fund;
  }

  async function listCatalog(userId: string) {
    return prisma.savingsFund.findMany({ where: { userId } });
  }

  /** Batch lookup for DataLoader use — trusts the caller to have already scoped the ids to one user. */
  async function findManyByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return prisma.savingsFund.findMany({ where: { id: { in: ids } } });
  }

  async function createSavingsFund(userId: string, input: SavingsFundInput) {
    assertValidAmount(input.initialBalanceCents, true);
    assertValidFundInput(input);

    return prisma.savingsFund.create({
      data: {
        userId,
        name: input.name,
        targetAmountCents: input.targetAmountCents ?? null,
        initialBalanceCents: input.initialBalanceCents,
        startDate: input.startDate ? new Date(input.startDate) : null,
        endDate: input.endDate ? new Date(input.endDate) : null,
        monthlyTargetCents: input.monthlyTargetCents ?? null,
      },
    });
  }

  async function updateSavingsFund(userId: string, id: string, input: UpdateSavingsFundInput) {
    assertValidFundInput(input);
    await findOwnedFund(userId, id);

    return prisma.savingsFund.update({
      where: { id },
      data: {
        name: input.name,
        targetAmountCents: input.targetAmountCents ?? null,
        startDate: input.startDate ? new Date(input.startDate) : null,
        endDate: input.endDate ? new Date(input.endDate) : null,
        monthlyTargetCents: input.monthlyTargetCents ?? null,
      },
    });
  }

  async function deleteSavingsFund(userId: string, id: string): Promise<void> {
    await findOwnedFund(userId, id);

    const existingMovement = await prisma.savingsMovement.findFirst({ where: { fundId: id } });
    if (existingMovement) {
      throw new SavingsFundServiceError('fund_has_movements');
    }

    try {
      // Hard delete, backed by SavingsMovement.fund's onDelete: Restrict FK
      // — the DB-level backstop closes the race the pre-check above can't
      // (a concurrent movement insert landing between the check and this
      // delete), same pattern as every other hard-deleted entity in this
      // app.
      await prisma.savingsFund.delete({ where: { id } });
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2003')) {
        throw new SavingsFundServiceError('fund_has_movements');
      }
      throw error;
    }
  }

  return {
    listCatalog,
    findManyByIds,
    createSavingsFund,
    updateSavingsFund,
    deleteSavingsFund,
  };
}

export type SavingsFundService = ReturnType<typeof createSavingsFundService>;
