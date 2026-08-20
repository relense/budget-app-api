import { describe, expect, it } from '@jest/globals';
import { createBankBalanceService } from '../../../src/services/bankBalance/bankBalanceService.js';
import { createFakePrisma, seedTransaction, seedUser } from './testFakePrisma.js';

function setup(now: () => Date = () => new Date('2026-08-20T12:00:00.000Z')) {
  const prisma = createFakePrisma();
  const bankBalanceService = createBankBalanceService({ prisma: prisma as never, now });
  return { prisma, bankBalanceService };
}

describe('getBankBalance', () => {
  it('defaults to 0 plus the net of every transaction, for a user who never set a checkpoint', async () => {
    const { prisma, bankBalanceService } = setup();
    seedUser(prisma, {
      id: 'user-1',
      bankBalanceCheckpointCents: 0,
      bankBalanceCheckpointSetAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    seedTransaction(prisma, {
      userId: 'user-1',
      amountCents: 450000,
      direction: 'income',
      createdAt: new Date('2026-08-05T00:00:00.000Z'),
    });
    seedTransaction(prisma, {
      userId: 'user-1',
      amountCents: 5000,
      direction: 'expense',
      createdAt: new Date('2026-08-06T00:00:00.000Z'),
    });

    const balance = await bankBalanceService.getBankBalance('user-1');

    expect(balance).toEqual({
      amountCents: 445000,
      checkpointAmountCents: 0,
      checkpointSetAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('ignores transactions created before or exactly at the checkpoint', async () => {
    const { prisma, bankBalanceService } = setup();
    const checkpointSetAt = new Date('2026-08-10T00:00:00.000Z');
    seedUser(prisma, { id: 'user-1', bankBalanceCheckpointCents: 300000, bankBalanceCheckpointSetAt: checkpointSetAt });
    seedTransaction(prisma, {
      userId: 'user-1',
      amountCents: 100000,
      direction: 'income',
      createdAt: new Date('2026-08-09T23:59:59.999Z'),
    });
    seedTransaction(prisma, {
      userId: 'user-1',
      amountCents: 999999,
      direction: 'income',
      createdAt: checkpointSetAt,
    });
    seedTransaction(prisma, {
      userId: 'user-1',
      amountCents: 20000,
      direction: 'expense',
      createdAt: new Date('2026-08-10T00:00:00.001Z'),
    });

    const balance = await bankBalanceService.getBankBalance('user-1');

    expect(balance.amountCents).toBe(280000); // 300000 - 20000, both earlier transactions excluded
  });

  it('only counts a transaction backdated to before the checkpoint if it was actually entered after it', async () => {
    // The checkpoint anchors on createdAt (real insertion time), not the
    // transaction's own logical `date` — a user backfilling a July expense
    // the day after setting the checkpoint should still see it counted.
    const { prisma, bankBalanceService } = setup();
    const checkpointSetAt = new Date('2026-08-10T00:00:00.000Z');
    seedUser(prisma, { id: 'user-1', bankBalanceCheckpointCents: 100000, bankBalanceCheckpointSetAt: checkpointSetAt });
    seedTransaction(prisma, {
      userId: 'user-1',
      amountCents: 5000,
      direction: 'expense',
      createdAt: new Date('2026-08-11T00:00:00.000Z'), // entered after the checkpoint
    });

    const balance = await bankBalanceService.getBankBalance('user-1');

    expect(balance.amountCents).toBe(95000);
  });

  it('never mixes in another user\'s transactions', async () => {
    const { prisma, bankBalanceService } = setup();
    seedUser(prisma, { id: 'user-1', bankBalanceCheckpointCents: 0 });
    seedUser(prisma, { id: 'user-2', bankBalanceCheckpointCents: 0 });
    seedTransaction(prisma, {
      userId: 'user-2',
      amountCents: 999999,
      direction: 'income',
      createdAt: new Date('2026-08-05T00:00:00.000Z'),
    });

    const balance = await bankBalanceService.getBankBalance('user-1');

    expect(balance.amountCents).toBe(0);
  });

  it('can go negative', async () => {
    const { prisma, bankBalanceService } = setup();
    seedUser(prisma, { id: 'user-1', bankBalanceCheckpointCents: 1000 });
    seedTransaction(prisma, {
      userId: 'user-1',
      amountCents: 5000,
      direction: 'expense',
      createdAt: new Date('2026-08-05T00:00:00.000Z'),
    });

    const balance = await bankBalanceService.getBankBalance('user-1');

    expect(balance.amountCents).toBe(-4000);
  });
});

describe('setBankBalanceCheckpoint', () => {
  it('overwrites the checkpoint amount and sets checkpointSetAt to now', async () => {
    const { prisma, bankBalanceService } = setup(() => new Date('2026-08-20T12:00:00.000Z'));
    seedUser(prisma, { id: 'user-1', bankBalanceCheckpointCents: 1000 });

    const balance = await bankBalanceService.setBankBalanceCheckpoint('user-1', 3000000);

    expect(balance).toEqual({
      amountCents: 3000000,
      checkpointAmountCents: 3000000,
      checkpointSetAt: new Date('2026-08-20T12:00:00.000Z'),
    });
  });

  it('accepts a negative amount', async () => {
    const { prisma, bankBalanceService } = setup();
    seedUser(prisma, { id: 'user-1' });

    const balance = await bankBalanceService.setBankBalanceCheckpoint('user-1', -50000);

    expect(balance.checkpointAmountCents).toBe(-50000);
  });

  it('rejects a non-integer amount', async () => {
    const { prisma, bankBalanceService } = setup();
    seedUser(prisma, { id: 'user-1' });

    await expect(bankBalanceService.setBankBalanceCheckpoint('user-1', 100.5)).rejects.toMatchObject({
      reason: 'invalid_amount',
    });
  });

  it('resets what counts toward the balance — a transaction entered before the new checkpoint no longer counts', async () => {
    const { prisma, bankBalanceService } = setup(() => new Date('2026-08-20T12:00:00.000Z'));
    seedUser(prisma, {
      id: 'user-1',
      bankBalanceCheckpointCents: 0,
      bankBalanceCheckpointSetAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    seedTransaction(prisma, {
      userId: 'user-1',
      amountCents: 999999,
      direction: 'income',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    await bankBalanceService.setBankBalanceCheckpoint('user-1', 500000);
    const balance = await bankBalanceService.getBankBalance('user-1');

    expect(balance.amountCents).toBe(500000);
  });
});
