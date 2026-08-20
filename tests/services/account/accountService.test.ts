import { describe, expect, it, jest } from '@jest/globals';
import { AccountServiceError, createAccountService } from '../../../src/services/account/accountService.js';
import { createFakePrisma, FakeRecordNotFoundError } from './testFakePrisma.js';

const USER_A = 'user-a';
const USER_B = 'user-b';

function setup() {
  const prisma = createFakePrisma();
  prisma.users.push(
    {
      id: USER_A,
      email: 'a@example.com',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      bankBalanceCheckpointCents: 1000,
      bankBalanceCheckpointSetAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    {
      id: USER_B,
      email: 'b@example.com',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      bankBalanceCheckpointCents: 0,
      bankBalanceCheckpointSetAt: new Date('2026-01-02T00:00:00.000Z'),
    },
  );
  const accountService = createAccountService({ prisma: prisma as never });
  return { prisma, accountService };
}

function seedFullAccount(prisma: ReturnType<typeof createFakePrisma>, userId: string, suffix: string) {
  prisma.categories.push({ id: `category-${suffix}`, userId, name: 'Groceries' });
  prisma.budgetMonths.push({ id: `month-${suffix}`, userId, month: '2026-01' });
  prisma.categoryMonths.push({
    id: `cm-${suffix}`,
    userId,
    categoryId: `category-${suffix}`,
    monthId: `month-${suffix}`,
  });
  prisma.transactions.push({
    id: `txn-${suffix}`,
    userId,
    categoryMonthId: `cm-${suffix}`,
    recurringExpenseId: null,
    amountCents: 500,
  });
  prisma.recurringExpenses.push({
    id: `re-${suffix}`,
    userId,
    monthId: `month-${suffix}`,
    categoryId: `category-${suffix}`,
  });
  prisma.savingsFunds.push({ id: `fund-${suffix}`, userId, name: 'Vacation' });
  prisma.savingsMovements.push({
    id: `movement-${suffix}`,
    userId,
    fundId: `fund-${suffix}`,
    amountCents: 200,
  });
}

describe('exportUserData', () => {
  it('returns account info plus every domain row for that user only', async () => {
    const { prisma, accountService } = setup();
    seedFullAccount(prisma, USER_A, 'a');
    seedFullAccount(prisma, USER_B, 'b');

    const result = await accountService.exportUserData(USER_A);

    expect(result.account).toEqual({
      id: USER_A,
      email: 'a@example.com',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      bankBalanceCheckpointCents: 1000,
      bankBalanceCheckpointSetAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(result.categories.map((c) => c.id)).toEqual(['category-a']);
    expect(result.budgetMonths.map((m) => m.id)).toEqual(['month-a']);
    expect(result.categoryMonths.map((m) => m.id)).toEqual(['cm-a']);
    expect(result.transactions.map((t) => t.id)).toEqual(['txn-a']);
    expect(result.recurringExpenses.map((r) => r.id)).toEqual(['re-a']);
    expect(result.savingsFunds.map((f) => f.id)).toEqual(['fund-a']);
    expect(result.savingsMovements.map((m) => m.id)).toEqual(['movement-a']);
  });

  it('throws account_not_found for a nonexistent user', async () => {
    const { accountService } = setup();

    await expect(accountService.exportUserData('nobody')).rejects.toMatchObject({
      reason: 'account_not_found',
    });
    await expect(accountService.exportUserData('nobody')).rejects.toBeInstanceOf(AccountServiceError);
  });

  it('runs its reads inside a RepeatableRead transaction for a consistent snapshot', async () => {
    const { prisma, accountService } = setup();
    seedFullAccount(prisma, USER_A, 'a');
    const transactionSpy = jest.spyOn(prisma, '$transaction');

    await accountService.exportUserData(USER_A);

    expect(transactionSpy).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
  });
});

describe('deleteAccount', () => {
  it('removes every domain row for that user, leaves other users untouched', async () => {
    const { prisma, accountService } = setup();
    seedFullAccount(prisma, USER_A, 'a');
    seedFullAccount(prisma, USER_B, 'b');

    await accountService.deleteAccount(USER_A);

    expect(prisma.users.map((u) => u.id)).toEqual([USER_B]);
    expect(prisma.categories.map((c) => c.userId)).toEqual([USER_B]);
    expect(prisma.budgetMonths.map((m) => m.userId)).toEqual([USER_B]);
    expect(prisma.categoryMonths.map((m) => m.userId)).toEqual([USER_B]);
    expect(prisma.transactions.map((t) => t.userId)).toEqual([USER_B]);
    expect(prisma.recurringExpenses.map((r) => r.userId)).toEqual([USER_B]);
    expect(prisma.savingsFunds.map((f) => f.userId)).toEqual([USER_B]);
    expect(prisma.savingsMovements.map((m) => m.userId)).toEqual([USER_B]);
  });

  it('also deletes otp_codes tied to that account email, but not other emails', async () => {
    const { prisma, accountService } = setup();
    prisma.otpCodes.push(
      { id: 'otp-a', email: 'a@example.com' },
      { id: 'otp-b', email: 'b@example.com' },
    );

    await accountService.deleteAccount(USER_A);

    expect(prisma.otpCodes.map((o) => o.id)).toEqual(['otp-b']);
  });

  it('throws account_not_found for a nonexistent user and deletes nothing', async () => {
    const { prisma, accountService } = setup();
    seedFullAccount(prisma, USER_A, 'a');

    await expect(accountService.deleteAccount('nobody')).rejects.toMatchObject({
      reason: 'account_not_found',
    });
    expect(prisma.users).toHaveLength(2);
    expect(prisma.categories).toHaveLength(1);
  });

  it('maps a concurrent-delete race (P2025 on the final user.delete) to account_not_found, not a raw error', async () => {
    const { prisma, accountService } = setup();
    // Simulates a second, concurrent DELETE /account winning the race: the
    // pre-check (user.findUnique) still finds the user, but by the time
    // this transaction's own user.delete runs, someone else already
    // removed the row.
    jest.spyOn(prisma.user, 'delete').mockRejectedValueOnce(new FakeRecordNotFoundError());

    let caught: unknown;
    try {
      await accountService.deleteAccount(USER_A);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AccountServiceError);
    expect(caught).toMatchObject({ reason: 'account_not_found' });
  });

  it('does not remap an unrelated error from the final user.delete into account_not_found', async () => {
    const { prisma, accountService } = setup();
    const boom = new Error('connection reset');
    jest.spyOn(prisma.user, 'delete').mockRejectedValueOnce(boom);

    await expect(accountService.deleteAccount(USER_A)).rejects.toBe(boom);
  });

  it('deletes in dependency order — children before the parents they reference', async () => {
    const { prisma, accountService } = setup();
    seedFullAccount(prisma, USER_A, 'a');

    const savingsMovementSpy = jest.spyOn(prisma.savingsMovement, 'deleteMany');
    const transactionSpy = jest.spyOn(prisma.transaction, 'deleteMany');
    const savingsFundSpy = jest.spyOn(prisma.savingsFund, 'deleteMany');
    const recurringExpenseSpy = jest.spyOn(prisma.recurringExpense, 'deleteMany');
    const categoryMonthSpy = jest.spyOn(prisma.categoryMonth, 'deleteMany');
    const categorySpy = jest.spyOn(prisma.category, 'deleteMany');
    const budgetMonthSpy = jest.spyOn(prisma.budgetMonth, 'deleteMany');
    const otpCodeSpy = jest.spyOn(prisma.otpCode, 'deleteMany');
    const userDeleteSpy = jest.spyOn(prisma.user, 'delete');

    await accountService.deleteAccount(USER_A);

    const order = (spy: { mock: { invocationCallOrder: readonly number[] } }): number =>
      spy.mock.invocationCallOrder[0]!;

    // SavingsMovement -> SavingsFund (Restrict).
    expect(order(savingsMovementSpy)).toBeLessThan(order(savingsFundSpy));
    // Transaction -> CategoryMonth and RecurringExpense (both Restrict).
    expect(order(transactionSpy)).toBeLessThan(order(categoryMonthSpy));
    expect(order(transactionSpy)).toBeLessThan(order(recurringExpenseSpy));
    // RecurringExpense -> Category and BudgetMonth (both Restrict).
    expect(order(recurringExpenseSpy)).toBeLessThan(order(categorySpy));
    expect(order(recurringExpenseSpy)).toBeLessThan(order(budgetMonthSpy));
    // CategoryMonth -> Category and BudgetMonth (both Restrict).
    expect(order(categoryMonthSpy)).toBeLessThan(order(categorySpy));
    expect(order(categoryMonthSpy)).toBeLessThan(order(budgetMonthSpy));
    // Everything else before the user row itself.
    expect(order(categorySpy)).toBeLessThan(order(userDeleteSpy));
    expect(order(budgetMonthSpy)).toBeLessThan(order(userDeleteSpy));
    expect(order(otpCodeSpy)).toBeLessThan(order(userDeleteSpy));
  });
});
