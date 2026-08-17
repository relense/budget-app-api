import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fastify, { type FastifyInstance } from 'fastify';
import { type ValidationRule, NoSchemaIntrospectionCustomRule } from 'graphql';
import depthLimit from 'graphql-depth-limit';
import { createYoga, type Plugin } from 'graphql-yoga';
import { schema } from './graphql/schema.js';
import type { Env } from './lib/env.js';
import type { PrismaClient } from './lib/prisma.js';

const MAX_QUERY_DEPTH = 10;

function useValidationRules(rules: ValidationRule[]): Plugin {
  return {
    onValidate({ addValidationRule }) {
      rules.forEach(addValidationRule);
    },
  };
}

export interface BuildServerOptions {
  env: Env;
  prisma: Pick<PrismaClient, '$queryRaw'>;
}

export async function buildServer({ env, prisma }: BuildServerOptions): Promise<FastifyInstance> {
  const app = fastify({ logger: env.NODE_ENV !== 'test' });
  const isProduction = env.NODE_ENV === 'production';

  await app.register(helmet);
  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
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
