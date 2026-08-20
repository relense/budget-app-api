import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: './src/graphql/schema.ts',
  generates: {
    './src/generated/graphql.ts': {
      plugins: ['typescript', 'typescript-resolvers'],
      config: {
        contextType: '../graphql/context.js#GraphQLContext',
        useIndexSignature: true,
        useTypeImports: true,
        // String literal unions, not real TS enums — matches the
        // hand-written GraphQLBudgetType/GraphQLDirection/GraphQLMovementType
        // convention these generated types replace (enumMapping.ts), and
        // stays structurally compatible with the plain strings graphql-yoga
        // actually sends over the wire.
        enumsAsTypes: true,
        // Resolvers in this app return domain/Prisma-shaped objects, not
        // already-GraphQL-shaped ones — every service is a thin wrapper
        // over Prisma with no DTO conversion, and enum/date conversion
        // happens per-field in nested resolvers (Category.budgetType,
        // Transaction.date, etc.), not before returning. Without this,
        // TypeScript checks every resolver's return value against the
        // final GraphQL type (uppercase enums, no userId/timestamps) and
        // every one of them fails to typecheck. Aliased on import (`as
        // Prisma...`) since the mapper target's name would otherwise
        // collide with the generated GraphQL type of the same name.
        // BudgetMonth deliberately not mapped — its GraphQL type is just
        // { month, locked }, no enum/date conversion and no nested
        // resolvers, and findCurrentMonth can synthesize a row that was
        // never actually persisted, so the default (plain generated type)
        // is the correct, and only accurate, parent shape.
        mappers: {
          Category: './prisma/client.js#Category as PrismaCategory',
          CategoryMonth: './prisma/client.js#CategoryMonth as PrismaCategoryMonth',
          Transaction: './prisma/client.js#Transaction as PrismaTransaction',
          RecurringExpense: './prisma/client.js#RecurringExpense as PrismaRecurringExpense',
          SavingsFund: './prisma/client.js#SavingsFund as PrismaSavingsFund',
          SavingsMovement: './prisma/client.js#SavingsMovement as PrismaSavingsMovement',
          BankBalance:
            '../services/bankBalance/bankBalanceService.js#BankBalance as DomainBankBalance',
        },
      },
    },
  },
};

export default config;
