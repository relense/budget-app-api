import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from './prisma.js';

interface LoggerLike {
  info: (msg: string) => void;
  error: (obj: unknown, msg: string) => void;
}

export interface CreateShutdownHandlerOptions {
  app: Pick<FastifyInstance, 'close'>;
  prisma: Pick<PrismaClient, '$disconnect'>;
  logger: LoggerLike;
}

export function createShutdownHandler({ app, prisma, logger }: CreateShutdownHandlerOptions) {
  return async function shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, shutting down gracefully`);

    try {
      await app.close();
    } catch (error) {
      logger.error(error, 'Error while closing the server');
    } finally {
      await prisma.$disconnect();
    }
  };
}
