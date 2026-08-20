import { describe, expect, it } from '@jest/globals';
import { createSavingsFundService } from '../../../src/services/savings/savingsFundService.js';
import { createFakePrisma } from './testFakePrisma.js';

function setup() {
  const prisma = createFakePrisma();
  const savingsFundService = createSavingsFundService({ prisma: prisma as never });
  return { prisma, savingsFundService };
}

describe('createSavingsFund', () => {
  it('creates a fund with every field given', async () => {
    const { savingsFundService } = setup();

    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Emergency Fund',
      targetAmountCents: 500000,
      initialBalanceCents: 100000,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      monthlyTargetCents: 20000,
    });

    expect(fund.name).toBe('Emergency Fund');
    expect(fund.targetAmountCents).toBe(500000);
    expect(fund.initialBalanceCents).toBe(100000);
  });

  it('creates a fund with only the required fields', async () => {
    const { savingsFundService } = setup();

    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 0,
    });

    expect(fund.targetAmountCents).toBeNull();
    expect(fund.startDate).toBeNull();
    expect(fund.endDate).toBeNull();
    expect(fund.monthlyTargetCents).toBeNull();
  });

  it('rejects a negative initialBalanceCents', async () => {
    const { savingsFundService } = setup();

    await expect(
      savingsFundService.createSavingsFund('user-1', { name: 'X', initialBalanceCents: -1 }),
    ).rejects.toMatchObject({ reason: 'invalid_amount' });
  });

  it('rejects a negative targetAmountCents', async () => {
    const { savingsFundService } = setup();

    await expect(
      savingsFundService.createSavingsFund('user-1', {
        name: 'X',
        initialBalanceCents: 0,
        targetAmountCents: -1,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_amount' });
  });

  it('rejects a malformed startDate', async () => {
    const { savingsFundService } = setup();

    await expect(
      savingsFundService.createSavingsFund('user-1', {
        name: 'X',
        initialBalanceCents: 0,
        startDate: 'not-a-date',
      }),
    ).rejects.toMatchObject({ reason: 'invalid_date' });
  });

  it('rejects a real-looking but nonexistent calendar startDate (e.g. April 31)', async () => {
    const { savingsFundService } = setup();

    await expect(
      savingsFundService.createSavingsFund('user-1', {
        name: 'X',
        initialBalanceCents: 0,
        startDate: '2026-04-31',
      }),
    ).rejects.toMatchObject({ reason: 'invalid_date' });
  });

  it('rejects an endDate before startDate', async () => {
    const { savingsFundService } = setup();

    await expect(
      savingsFundService.createSavingsFund('user-1', {
        name: 'X',
        initialBalanceCents: 0,
        startDate: '2026-06-01',
        endDate: '2026-01-01',
      }),
    ).rejects.toMatchObject({ reason: 'invalid_date_range' });
  });

  it('rejects a negative monthlyTargetCents', async () => {
    const { savingsFundService } = setup();

    await expect(
      savingsFundService.createSavingsFund('user-1', {
        name: 'X',
        initialBalanceCents: 0,
        monthlyTargetCents: -1,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_amount' });
  });

  it('rejects a malformed endDate given alone (no startDate)', async () => {
    const { savingsFundService } = setup();

    await expect(
      savingsFundService.createSavingsFund('user-1', {
        name: 'X',
        initialBalanceCents: 0,
        endDate: 'not-a-date',
      }),
    ).rejects.toMatchObject({ reason: 'invalid_date' });
  });
});

describe('updateSavingsFund', () => {
  it('updates the editable fields, leaving initialBalanceCents untouched', async () => {
    const { savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 5000,
    });

    const updated = await savingsFundService.updateSavingsFund('user-1', fund.id, {
      name: 'Wedding Fund',
      targetAmountCents: 300000,
    });

    expect(updated.name).toBe('Wedding Fund');
    expect(updated.targetAmountCents).toBe(300000);
    expect(updated.initialBalanceCents).toBe(5000);
  });

  it('throws fund_not_found for another user\'s fund', async () => {
    const { savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 0,
    });

    await expect(
      savingsFundService.updateSavingsFund('user-2', fund.id, { name: 'Hijacked' }),
    ).rejects.toMatchObject({ reason: 'fund_not_found' });
  });

  it('throws fund_not_found for a nonexistent id', async () => {
    const { savingsFundService } = setup();

    await expect(
      savingsFundService.updateSavingsFund('user-1', 'missing', { name: 'X' }),
    ).rejects.toMatchObject({ reason: 'fund_not_found' });
  });

  it('validates input the same way createSavingsFund does', async () => {
    const { savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 0,
    });

    await expect(
      savingsFundService.updateSavingsFund('user-1', fund.id, { name: 'X', targetAmountCents: -1 }),
    ).rejects.toMatchObject({ reason: 'invalid_amount' });
  });

  it('rejects a malformed startDate on update', async () => {
    const { savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 0,
    });

    await expect(
      savingsFundService.updateSavingsFund('user-1', fund.id, { name: 'X', startDate: 'not-a-date' }),
    ).rejects.toMatchObject({ reason: 'invalid_date' });
  });

  it('rejects an endDate before startDate on update', async () => {
    const { savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 0,
    });

    await expect(
      savingsFundService.updateSavingsFund('user-1', fund.id, {
        name: 'X',
        startDate: '2026-06-01',
        endDate: '2026-01-01',
      }),
    ).rejects.toMatchObject({ reason: 'invalid_date_range' });
  });
});

describe('deleteSavingsFund', () => {
  it('deletes a fund with no movements', async () => {
    const { prisma, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 0,
    });

    await savingsFundService.deleteSavingsFund('user-1', fund.id);

    expect(prisma.savingsFunds).toHaveLength(0);
  });

  it('throws fund_has_movements while a movement references it', async () => {
    const { prisma, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 0,
    });
    prisma.savingsMovements.push({
      id: 'movement-1',
      userId: 'user-1',
      fundId: fund.id,
      amountCents: 1000,
      type: 'deposit',
      date: new Date('2026-08-01'),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(savingsFundService.deleteSavingsFund('user-1', fund.id)).rejects.toMatchObject({
      reason: 'fund_has_movements',
    });
  });

  it('throws fund_not_found for another user\'s fund', async () => {
    const { savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 0,
    });

    await expect(savingsFundService.deleteSavingsFund('user-2', fund.id)).rejects.toMatchObject({
      reason: 'fund_not_found',
    });
  });

  it('throws fund_has_movements (not a raw FK error) when a movement is created between the check and the delete', async () => {
    const { prisma, savingsFundService } = setup();
    const fund = await savingsFundService.createSavingsFund('user-1', {
      name: 'Wedding',
      initialBalanceCents: 0,
    });

    prisma.savingsMovement.findFirst = (async () => {
      prisma.savingsMovements.push({
        id: 'movement-race',
        userId: 'user-1',
        fundId: fund.id,
        amountCents: 1000,
        type: 'deposit',
        date: new Date('2026-08-01'),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return null;
    }) as typeof prisma.savingsMovement.findFirst;

    await expect(savingsFundService.deleteSavingsFund('user-1', fund.id)).rejects.toMatchObject({
      reason: 'fund_has_movements',
    });
  });
});

describe('listCatalog', () => {
  it('returns only the requesting user\'s funds', async () => {
    const { savingsFundService } = setup();
    await savingsFundService.createSavingsFund('user-1', { name: 'A', initialBalanceCents: 0 });
    await savingsFundService.createSavingsFund('user-2', { name: 'B', initialBalanceCents: 0 });

    const funds = await savingsFundService.listCatalog('user-1');

    expect(funds.map((f) => f.name)).toEqual(['A']);
  });
});

describe('findManyByIds', () => {
  it('batches multiple ids into a single lookup', async () => {
    const { savingsFundService } = setup();
    const a = await savingsFundService.createSavingsFund('user-1', { name: 'A', initialBalanceCents: 0 });
    const b = await savingsFundService.createSavingsFund('user-1', { name: 'B', initialBalanceCents: 0 });

    const rows = await savingsFundService.findManyByIds([a.id, b.id, 'missing']);

    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('returns an empty array for an empty id list', async () => {
    const { savingsFundService } = setup();

    expect(await savingsFundService.findManyByIds([])).toEqual([]);
  });
});
