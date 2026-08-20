import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveBearerUserId } from '../lib/jwt.js';
import { type AccountService, AccountServiceError } from '../services/account/accountService.js';

const deleteAccountSchema = z.object({
  confirm: z.literal(true),
});

// Both routes are already authenticated (a valid access token is required),
// so this is defense-in-depth against a leaked/stolen token or a buggy
// client retry loop, not the primary defense the way OTP rate limiting is.
const EXPORT_RATE_LIMIT_MAX = 5;
const EXPORT_RATE_LIMIT_WINDOW = '15 minutes';
const DELETE_RATE_LIMIT_MAX = 5;
const DELETE_RATE_LIMIT_WINDOW = '1 hour';

export interface RegisterAccountRoutesOptions {
  accountService: Pick<AccountService, 'exportUserData' | 'deleteAccount'>;
  jwtSecret: string;
}

export async function registerAccountRoutes(
  app: FastifyInstance,
  { accountService, jwtSecret }: RegisterAccountRoutesOptions,
): Promise<void> {
  app.get(
    '/account/export',
    {
      config: {
        rateLimit: { max: EXPORT_RATE_LIMIT_MAX, timeWindow: EXPORT_RATE_LIMIT_WINDOW },
      },
    },
    async (request, reply) => {
      const userId = await resolveBearerUserId(request, jwtSecret);
      if (!userId) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      try {
        const data = await accountService.exportUserData(userId);
        return reply.status(200).send(data);
      } catch (error) {
        if (error instanceof AccountServiceError && error.reason === 'account_not_found') {
          return reply.status(404).send({ error: 'account_not_found' });
        }
        throw error;
      }
    },
  );

  app.delete(
    '/account',
    {
      config: {
        rateLimit: { max: DELETE_RATE_LIMIT_MAX, timeWindow: DELETE_RATE_LIMIT_WINDOW },
      },
    },
    async (request, reply) => {
      const userId = await resolveBearerUserId(request, jwtSecret);
      if (!userId) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      const parsed = deleteAccountSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', issues: parsed.error.issues });
      }

      try {
        await accountService.deleteAccount(userId);
        return reply.status(204).send();
      } catch (error) {
        if (error instanceof AccountServiceError && error.reason === 'account_not_found') {
          return reply.status(404).send({ error: 'account_not_found' });
        }
        throw error;
      }
    },
  );
}
