import { createSchema } from 'graphql-yoga';

export const schema = createSchema({
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
