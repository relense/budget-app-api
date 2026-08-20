import { describe, expect, it, jest } from '@jest/globals';
import { createSavingsFundService } from '../../../src/services/savings/savingsFundService.js';
import { createSavingsMovementService } from '../../../src/services/savings/savingsMovementService.js';
import { createFakePrisma } from './testFakePrisma.js';

function setup() {
  const prisma = createFakePrisma();
  const savingsFundService = createSavingsFundService({ prisma: prisma as never });
  const savingsMovementService = createSavingsMovementService({ prisma: prisma as never });
  return { prisma, savingsFundService, savingsMovementService };
}

describe('createSavingsMovement', () => {
  it('creates a deposit', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 0,
    });

    const movement = await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 10000,
      type: 'deposit',
      date: '2026-08-01',
    });

    expect(movement.amountCents).toBe(10000);
    expect(movement.type).toBe('deposit');
  });

  it('creates a withdrawal that stays within the current balance', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 10000,
    });

    const movement = await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 4000,
      type: 'withdraw',
      date: '2026-08-01',
    });

    expect(movement.type).toBe('withdraw');
    expect(await savingsMovementService.computeCurrentAmountCents(fund.id, 10000)).toBe(6000);
  });

  it('allows a withdrawal that exactly zeroes the balance', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 10000,
    });

    await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 10000,
      type: 'withdraw',
      date: '2026-08-01',
    });

    expect(await savingsMovementService.computeCurrentAmountCents(fund.id, 10000)).toBe(0);
  });

  it('rejects a withdrawal larger than the current balance', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 10000,
    });

    await expect(
      savingsMovementService.createSavingsMovement('user-1', {
        fundId: fund.id,
        amountCents: 10001,
        type: 'withdraw',
        date: '2026-08-01',
      }),
    ).rejects.toMatchObject({ reason: 'insufficient_funds' });
  });

  it('accounts for prior deposits and withdrawals when checking overdraft', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 0,
    });
    await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 10000,
      type: 'deposit',
      date: '2026-08-01',
    });
    await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 6000,
      type: 'withdraw',
      date: '2026-08-05',
    });

    await expect(
      savingsMovementService.createSavingsMovement('user-1', {
        fundId: fund.id,
        amountCents: 5000,
        type: 'withdraw',
        date: '2026-08-10',
      }),
    ).rejects.toMatchObject({ reason: 'insufficient_funds' });
  });

  it('rejects an invalid (zero or negative) amount', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 10000,
    });

    await expect(
      savingsMovementService.createSavingsMovement('user-1', {
        fundId: fund.id,
        amountCents: 0,
        type: 'deposit',
        date: '2026-08-01',
      }),
    ).rejects.toMatchObject({ reason: 'invalid_amount' });
  });

  it('rejects a malformed date', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 10000,
    });

    await expect(
      savingsMovementService.createSavingsMovement('user-1', {
        fundId: fund.id,
        amountCents: 100,
        type: 'deposit',
        date: 'not-a-date',
      }),
    ).rejects.toMatchObject({ reason: 'invalid_date' });
  });

  it('rejects a real-looking but nonexistent calendar date (e.g. February 30)', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 10000,
    });

    await expect(
      savingsMovementService.createSavingsMovement('user-1', {
        fundId: fund.id,
        amountCents: 100,
        type: 'deposit',
        date: '2026-02-30',
      }),
    ).rejects.toMatchObject({ reason: 'invalid_date' });
  });

  it('throws fund_not_found for another user\'s fund', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 10000,
    });

    await expect(
      savingsMovementService.createSavingsMovement('user-2', {
        fundId: fund.id,
        amountCents: 100,
        type: 'deposit',
        date: '2026-08-01',
      }),
    ).rejects.toMatchObject({ reason: 'fund_not_found' });
  });
});

describe('updateSavingsMovement', () => {
  it('updates amount/type/date on the row', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 10000,
    });
    const movement = await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 5000,
      type: 'deposit',
      date: '2026-08-01',
    });

    const updated = await savingsMovementService.updateSavingsMovement('user-1', movement.id, {
      amountCents: 7000,
      type: 'deposit',
      date: '2026-08-02',
    });

    expect(updated.amountCents).toBe(7000);
    expect(await savingsMovementService.computeCurrentAmountCents(fund.id, 10000)).toBe(17000);
  });

  it('rejects a real-looking but nonexistent calendar date on update', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 10000,
    });
    const movement = await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 5000,
      type: 'deposit',
      date: '2026-08-01',
    });

    await expect(
      savingsMovementService.updateSavingsMovement('user-1', movement.id, {
        amountCents: 5000,
        type: 'deposit',
        date: '2026-02-30',
      }),
    ).rejects.toMatchObject({ reason: 'invalid_date' });
  });

  it('allows an edit that shrinks the balance to exactly zero', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 0,
    });
    const deposit = await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 5000,
      type: 'deposit',
      date: '2026-08-01',
    });
    await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 3000,
      type: 'withdraw',
      date: '2026-08-05',
    });

    // Shrinking the deposit to 3000 leaves exactly: 3000 - 3000 = 0.
    await savingsMovementService.updateSavingsMovement('user-1', deposit.id, {
      amountCents: 3000,
      type: 'deposit',
      date: '2026-08-01',
    });

    expect(await savingsMovementService.computeCurrentAmountCents(fund.id, 0)).toBe(0);
  });

  it('rejects an edit that would push the balance negative', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 0,
    });
    const deposit = await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 10000,
      type: 'deposit',
      date: '2026-08-01',
    });
    await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 8000,
      type: 'withdraw',
      date: '2026-08-05',
    });

    // Shrinking the deposit to 5000 would leave: 5000 - 8000 = -3000.
    await expect(
      savingsMovementService.updateSavingsMovement('user-1', deposit.id, {
        amountCents: 5000,
        type: 'deposit',
        date: '2026-08-01',
      }),
    ).rejects.toMatchObject({ reason: 'insufficient_funds' });
  });

  it('throws movement_not_found for another user\'s movement', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 10000,
    });
    const movement = await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 100,
      type: 'deposit',
      date: '2026-08-01',
    });

    await expect(
      savingsMovementService.updateSavingsMovement('user-2', movement.id, {
        amountCents: 100,
        type: 'deposit',
        date: '2026-08-01',
      }),
    ).rejects.toMatchObject({ reason: 'movement_not_found' });
  });

  it('throws movement_not_found for a nonexistent id', async () => {
    const { savingsMovementService } = setup();

    await expect(
      savingsMovementService.updateSavingsMovement('user-1', 'missing', {
        amountCents: 100,
        type: 'deposit',
        date: '2026-08-01',
      }),
    ).rejects.toMatchObject({ reason: 'movement_not_found' });
  });

  it('throws movement_not_found (not a raw error) when the movement is deleted between the pre-check and the write', async () => {
    // pr-reviewer (PR #15): a concurrent update/delete of the same
    // movement (double-click, or a race between two devices/tabs) used to
    // surface Prisma's raw P2025 once the write inside the transaction hit
    // an already-gone row — this proves it's now mapped to the same typed
    // error findOwnedMovement itself would throw.
    const { prisma, savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 10000,
    });
    const movement = await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 100,
      type: 'deposit',
      date: '2026-08-01',
    });

    // Simulates the race: the pre-transaction findOwnedMovement check
    // succeeds (as if it ran a moment before a concurrent delete), but the
    // row is gone by the time this call's own write runs.
    const realFindUnique = prisma.savingsMovement.findUnique;
    prisma.savingsMovement.findUnique = (async (args) => {
      const result = await realFindUnique(args);
      prisma.savingsMovements.length = 0;
      return result;
    }) as typeof prisma.savingsMovement.findUnique;

    await expect(
      savingsMovementService.updateSavingsMovement('user-1', movement.id, {
        amountCents: 200,
        type: 'deposit',
        date: '2026-08-01',
      }),
    ).rejects.toMatchObject({ reason: 'movement_not_found' });
  });
});

describe('deleteSavingsMovement', () => {
  it('deletes a movement and adjusts the balance', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 0,
    });
    const movement = await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 10000,
      type: 'deposit',
      date: '2026-08-01',
    });

    await savingsMovementService.deleteSavingsMovement('user-1', movement.id);

    expect(await savingsMovementService.computeCurrentAmountCents(fund.id, 0)).toBe(0);
  });

  it('allows deleting a movement that leaves the balance at exactly zero', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 0,
    });
    await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 3000,
      type: 'deposit',
      date: '2026-08-01',
    });
    await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 3000,
      type: 'withdraw',
      date: '2026-08-05',
    });
    const extraDeposit = await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 2000,
      type: 'deposit',
      date: '2026-08-10',
    });

    // Deleting the extra deposit leaves exactly: 3000 - 3000 = 0.
    await savingsMovementService.deleteSavingsMovement('user-1', extraDeposit.id);

    expect(await savingsMovementService.computeCurrentAmountCents(fund.id, 0)).toBe(0);
  });

  it('rejects deleting a deposit that a later withdrawal already depends on', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 0,
    });
    const deposit = await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 10000,
      type: 'deposit',
      date: '2026-08-01',
    });
    await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 8000,
      type: 'withdraw',
      date: '2026-08-05',
    });

    // Deleting the deposit would leave: 0 - 8000 = -8000.
    await expect(
      savingsMovementService.deleteSavingsMovement('user-1', deposit.id),
    ).rejects.toMatchObject({ reason: 'insufficient_funds' });
  });

  it('throws movement_not_found for another user\'s movement', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 10000,
    });
    const movement = await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 100,
      type: 'deposit',
      date: '2026-08-01',
    });

    await expect(
      savingsMovementService.deleteSavingsMovement('user-2', movement.id),
    ).rejects.toMatchObject({ reason: 'movement_not_found' });
  });

  it('throws movement_not_found (not a raw error) when the movement is already gone by the time the write runs', async () => {
    // pr-reviewer (PR #15): same concurrent-double-submit reasoning as
    // updateSavingsMovement's identical regression test above.
    const { prisma, savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 10000,
    });
    const movement = await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 100,
      type: 'deposit',
      date: '2026-08-01',
    });

    const realFindUnique = prisma.savingsMovement.findUnique;
    prisma.savingsMovement.findUnique = (async (args) => {
      const result = await realFindUnique(args);
      prisma.savingsMovements.length = 0;
      return result;
    }) as typeof prisma.savingsMovement.findUnique;

    await expect(
      savingsMovementService.deleteSavingsMovement('user-1', movement.id),
    ).rejects.toMatchObject({ reason: 'movement_not_found' });
  });
});

describe('listByFundIds', () => {
  it('batches multiple fund ids into a single lookup and groups by fund', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fundA = await savingsFundService.createSavingsFund('user-1', { name: 'A', initialBalanceCents: 0 });
    const fundB = await savingsFundService.createSavingsFund('user-1', { name: 'B', initialBalanceCents: 0 });
    await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fundA.id,
      amountCents: 100,
      type: 'deposit',
      date: '2026-08-01',
    });
    await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fundB.id,
      amountCents: 200,
      type: 'deposit',
      date: '2026-08-01',
    });

    const rows = await savingsMovementService.listByFundIds([fundA.id, fundB.id]);

    expect(rows.map((r) => r.fundId).sort()).toEqual([fundA.id, fundB.id].sort());
  });

  it('returns an empty array for an empty id list', async () => {
    const { savingsMovementService } = setup();

    expect(await savingsMovementService.listByFundIds([])).toEqual([]);
  });
});

describe('row locking', () => {
  it('locks the fund row (via $queryRaw ... FOR UPDATE) on every write path', async () => {
    const { prisma, savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 10000,
    });
    const queryRawSpy = jest.fn(prisma.$queryRaw);
    prisma.$queryRaw = queryRawSpy as typeof prisma.$queryRaw;

    const movement = await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 1000,
      type: 'deposit',
      date: '2026-08-01',
    });
    expect(queryRawSpy).toHaveBeenCalledTimes(1);

    await savingsMovementService.updateSavingsMovement('user-1', movement.id, {
      amountCents: 1500,
      type: 'deposit',
      date: '2026-08-01',
    });
    expect(queryRawSpy).toHaveBeenCalledTimes(2);

    await savingsMovementService.deleteSavingsMovement('user-1', movement.id);
    expect(queryRawSpy).toHaveBeenCalledTimes(3);

    for (const call of queryRawSpy.mock.calls) {
      const [strings] = call as [TemplateStringsArray, ...unknown[]];
      expect(strings.join('')).toContain('FOR UPDATE');
    }
  });
});

describe('computeCurrentAmountCents', () => {
  it('returns initialBalanceCents alone when there are no movements', async () => {
    const { savingsMovementService } = setup();

    expect(await savingsMovementService.computeCurrentAmountCents('no-such-fund', 5000)).toBe(5000);
  });

  it('nets deposits and withdrawals against the initial balance', async () => {
    const { savingsMovementService, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 1000,
    });
    await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 5000,
      type: 'deposit',
      date: '2026-08-01',
    });
    await savingsMovementService.createSavingsMovement('user-1', {
      fundId: fund.id,
      amountCents: 2000,
      type: 'withdraw',
      date: '2026-08-05',
    });

    expect(await savingsMovementService.computeCurrentAmountCents(fund.id, 1000)).toBe(4000);
  });
});
