import { createSchema } from 'graphql-yoga';

export interface GraphQLContext {
  userId: string | null;
}

export const schema = createSchema<GraphQLContext>({
  typeDefs: /* GraphQL */ `
    type Query {
      ping: String!
    }
  `,
  resolvers: {
    Query: {
      ping: () => 'pong',
    },
  },
});
