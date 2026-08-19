import { describe, expect, it, jest } from '@jest/globals';
import { createShutdownHandler } from '../../src/lib/shutdown.js';

describe('createShutdownHandler', () => {
  it('closes the app before disconnecting prisma', async () => {
    const calls: string[] = [];
    const app = {
      close: jest.fn(async () => {
        calls.push('app.close');
      }),
    };
    const prisma = {
      $disconnect: jest.fn(async () => {
        calls.push('prisma.$disconnect');
      }),
    };
    const logger = { info: jest.fn() };

    const shutdown = createShutdownHandler({
      app: app as never,
      prisma: prisma as never,
      logger: logger as never,
    });

    await shutdown('SIGTERM');

    expect(app.close).toHaveBeenCalledTimes(1);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['app.close', 'prisma.$disconnect']);
  });

  it('still disconnects prisma if closing the app throws', async () => {
    const app = {
      close: jest.fn(async () => {
        throw new Error('close failed');
      }),
    };
    const prisma = { $disconnect: jest.fn(async () => undefined) };
    const logger = { info: jest.fn(), error: jest.fn() };

    const shutdown = createShutdownHandler({
      app: app as never,
      prisma: prisma as never,
      logger: logger as never,
    });

    await shutdown('SIGTERM');

    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
