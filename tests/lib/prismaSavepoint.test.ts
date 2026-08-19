import { describe, expect, it, jest } from '@jest/globals';
import { withSavepoint } from '../../src/lib/prismaSavepoint.js';

function fakeTx() {
  const calls: string[] = [];
  return {
    calls,
    $executeRawUnsafe: jest.fn(async (query: string) => {
      calls.push(query);
      return 0;
    }),
  };
}

describe('withSavepoint', () => {
  it('issues SAVEPOINT then RELEASE SAVEPOINT on success, and returns the attempt\'s value', async () => {
    const tx = fakeTx();

    const result = await withSavepoint(tx as never, 'my_savepoint', async () => 'ok');

    expect(result).toEqual({ ok: true, value: 'ok' });
    expect(tx.calls).toEqual(['SAVEPOINT my_savepoint', 'RELEASE SAVEPOINT my_savepoint']);
  });

  it('issues SAVEPOINT then ROLLBACK TO SAVEPOINT on a thrown error, and returns it instead of rethrowing', async () => {
    const tx = fakeTx();
    const thrown = new Error('conflict');

    const result = await withSavepoint(tx as never, 'my_savepoint', async () => {
      throw thrown;
    });

    expect(result).toEqual({ ok: false, error: thrown });
    expect(tx.calls).toEqual(['SAVEPOINT my_savepoint', 'ROLLBACK TO SAVEPOINT my_savepoint']);
  });

  it('never issues RELEASE SAVEPOINT when the attempt fails', async () => {
    const tx = fakeTx();

    await withSavepoint(tx as never, 'my_savepoint', async () => {
      throw new Error('conflict');
    });

    expect(tx.calls).not.toContain('RELEASE SAVEPOINT my_savepoint');
  });

  it('never issues ROLLBACK TO SAVEPOINT when the attempt succeeds', async () => {
    const tx = fakeTx();

    await withSavepoint(tx as never, 'my_savepoint', async () => 'ok');

    expect(tx.calls).not.toContain('ROLLBACK TO SAVEPOINT my_savepoint');
  });

  it('reuses the same savepoint name across repeated calls without erroring (matches seedNewMonth\'s per-item loop)', async () => {
    const tx = fakeTx();

    const first = await withSavepoint(tx as never, 'seed_recurring_expense', async () => 'a');
    const second = await withSavepoint(tx as never, 'seed_recurring_expense', async () => {
      throw new Error('collision');
    });
    const third = await withSavepoint(tx as never, 'seed_recurring_expense', async () => 'c');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(third).toEqual({ ok: true, value: 'c' });
    expect(tx.calls).toEqual([
      'SAVEPOINT seed_recurring_expense',
      'RELEASE SAVEPOINT seed_recurring_expense',
      'SAVEPOINT seed_recurring_expense',
      'ROLLBACK TO SAVEPOINT seed_recurring_expense',
      'SAVEPOINT seed_recurring_expense',
      'RELEASE SAVEPOINT seed_recurring_expense',
    ]);
  });
});
