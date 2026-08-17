import { loadEnv } from './lib/env.js';
import { createPrismaClient } from './lib/prisma.js';
import { createShutdownHandler } from './lib/shutdown.js';
import { buildServer } from './server.js';

const env = loadEnv();
const prisma = createPrismaClient(env.DATABASE_URL);
const app = await buildServer({ env, prisma });

process.on('uncaughtException', (error) => {
  app.log.error(error, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  app.log.error(reason, 'Unhandled promise rejection');
  process.exit(1);
});

const shutdown = createShutdownHandler({ app, prisma, logger: app.log });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    shutdown(signal)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}

await app.listen({ host: '0.0.0.0', port: env.PORT });
