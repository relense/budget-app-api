import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastify, { type FastifyInstance } from 'fastify';
import { type ValidationRule, NoSchemaIntrospectionCustomRule } from 'graphql';
import depthLimit from 'graphql-depth-limit';
import { createYoga, type Plugin } from 'graphql-yoga';
import { createGraphQLContextBuilder } from './graphql/context.js';
import { schema } from './graphql/schema.js';
import type { Env } from './lib/env.js';
import { verifyAccessToken } from './lib/jwt.js';
import type { PrismaClient } from './lib/prisma.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerAuthRoutes } from './routes/auth.js';
import { createAccountService } from './services/account/accountService.js';
import type { AuthCleanupService } from './services/auth/authCleanupService.js';
import type { AuthService } from './services/auth/authService.js';
import { createBankBalanceService } from './services/bankBalance/bankBalanceService.js';
import { createBudgetMonthService } from './services/budgetMonths/budgetMonthService.js';
import { createCategoryMonthService } from './services/categories/categoryMonthService.js';
import { createCategoryService } from './services/categories/categoryService.js';
import { createTransactionService } from './services/categories/transactionService.js';
import { createRecurringExpenseService } from './services/recurringExpenses/recurringExpenseService.js';
import { createSavingsFundService } from './services/savings/savingsFundService.js';
import { createSavingsMovementService } from './services/savings/savingsMovementService.js';

const MAX_QUERY_DEPTH = 10;
const BEARER_PREFIX = 'Bearer ';

function useValidationRules(rules: ValidationRule[]): Plugin {
  return {
    onValidate({ addValidationRule }) {
      rules.forEach(addValidationRule);
    },
  };
}

export interface BuildServerOptions {
  env: Env;
  prisma: Pick<
    PrismaClient,
    | '$queryRaw'
    | '$transaction'
    | '$executeRawUnsafe'
    | 'category'
    | 'categoryMonth'
    | 'budgetMonth'
    | 'transaction'
    | 'recurringExpense'
    | 'savingsFund'
    | 'savingsMovement'
    | 'user'
    | 'otpCode'
  >;
  authService: Pick<
    AuthService,
    'requestOtp' | 'verifyOtp' | 'refreshSession' | 'logout' | 'logoutAll'
  >;
  authCleanupService: Pick<AuthCleanupService, 'cleanupExpiredAuthRecords'>;
}

export async function buildServer({
  env,
  prisma,
  authService,
  authCleanupService,
}: BuildServerOptions): Promise<FastifyInstance> {
  const app = fastify({ logger: env.NODE_ENV !== 'test' });
  const isProduction = env.NODE_ENV === 'production';

  await app.register(helmet);
  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
  });
  await app.register(rateLimit, { global: false });

  await registerAuthRoutes(app, { authService, authCleanupService, jwtSecret: env.JWT_SECRET });

  const accountService = createAccountService({ prisma });
  await registerAccountRoutes(app, { accountService, jwtSecret: env.JWT_SECRET });

  const budgetMonthService = createBudgetMonthService({ prisma });
  const categoryService = createCategoryService({ prisma });
  const transactionService = createTransactionService({ prisma, budgetMonthService });
  const recurringExpenseService = createRecurringExpenseService({
    prisma,
    budgetMonthService,
    transactionService,
  });
  // onNewBudgetMonth wired here, not imported directly by categoryMonthService
  // — see CategoryMonthServiceDeps's doc comment for why (keeps the
  // one-directional service-layer dependency graph: recurringExpenseService
  // depends on categoryMonthService, never the reverse).
  const categoryMonthService = createCategoryMonthService({
    prisma,
    budgetMonthService,
    onNewBudgetMonth: recurringExpenseService.seedNewMonth,
  });
  const savingsFundService = createSavingsFundService({ prisma });
  const savingsMovementService = createSavingsMovementService({ prisma });
  const bankBalanceService = createBankBalanceService({ prisma });
  const buildGraphQLContext = createGraphQLContextBuilder({
    categoryService,
    categoryMonthService,
    budgetMonthService,
    transactionService,
    recurringExpenseService,
    savingsFundService,
    savingsMovementService,
    bankBalanceService,
  });

  app.get('/health', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.status(200).send({ status: 'ok' });
    } catch (error) {
      app.log.error(error, 'Health check failed');
      return reply.status(503).send({ status: 'error' });
    }
  });

  const yoga = createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    graphiql: !isProduction,
    maskedErrors: isProduction,
    context: async ({ request }) => {
      const authHeader = request.headers.get('authorization');
      const token = authHeader?.startsWith(BEARER_PREFIX)
        ? authHeader.slice(BEARER_PREFIX.length)
        : null;
      const payload = token ? await verifyAccessToken(token, env.JWT_SECRET) : null;
      return buildGraphQLContext(payload?.userId ?? null);
    },
    plugins: [
      useValidationRules(
        isProduction
          ? [NoSchemaIntrospectionCustomRule, depthLimit(MAX_QUERY_DEPTH)]
          : [depthLimit(MAX_QUERY_DEPTH)],
      ),
    ],
  });

  app.route({
    url: yoga.graphqlEndpoint,
    method: ['GET', 'POST', 'OPTIONS'],
    handler: async (req, reply) => {
      const response = await yoga.handleNodeRequestAndResponse(req, reply);
      response.headers.forEach((value, key) => reply.header(key, value));
      reply.status(response.status);
      reply.send(await response.text());
    },
  });

  return app;
}
