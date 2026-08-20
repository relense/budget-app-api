import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveBearerUserId } from '../lib/jwt.js';
import { type AccountService, AccountServiceError } from '../services/account/accountService.js';

const deleteAccountSchema = z.object({
  confirm: z.literal(true),
});

export interface RegisterAccountRoutesOptions {
  accountService: Pick<AccountService, 'exportUserData' | 'deleteAccount'>;
  jwtSecret: string;
}

export async function registerAccountRoutes(
  app: FastifyInstance,
  { accountService, jwtSecret }: RegisterAccountRoutesOptions,
): Promise<void> {
  app.get('/account/export', async (request, reply) => {
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
  });

  app.delete('/account', async (request, reply) => {
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
  });
}
