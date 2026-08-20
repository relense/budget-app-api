import { createConsoleEmailService } from './lib/email.js';
import { loadEnv } from './lib/env.js';
import { createPrismaClient } from './lib/prisma.js';
import { createShutdownHandler } from './lib/shutdown.js';
import { buildServer } from './server.js';
import { createAuthCleanupService } from './services/auth/authCleanupService.js';
import { createAuthService } from './services/auth/authService.js';

const AUTH_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const env = loadEnv();
const prisma = createPrismaClient(env.DATABASE_URL);
const emailService = createConsoleEmailService(console);
const authService = createAuthService({ prisma, emailService, jwtSecret: env.JWT_SECRET });
const app = await buildServer({ env, prisma, authService });

// Backstop for the piggybacked cleanup on POST /auth/request-otp (see
// routes/auth.ts) — keeps otp_codes/refresh_tokens from growing unbounded
// even through a stretch with no login traffic at all.
const authCleanupService = createAuthCleanupService({ prisma });
const authCleanupInterval = setInterval(() => {
  authCleanupService.cleanupExpiredAuthRecords().catch((error) => {
    app.log.error(error, 'Auth row cleanup failed');
  });
}, AUTH_CLEANUP_INTERVAL_MS);

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
    clearInterval(authCleanupInterval);
    shutdown(signal)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}

await app.listen({ host: '0.0.0.0', port: env.PORT });
