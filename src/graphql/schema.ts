import { createSchema } from 'graphql-yoga';
import type { GraphQLContext } from './context.js';
import {
  budgetTypeToDb,
  budgetTypeToDbRequired,
  budgetTypeToGraphQL,
  directionToDb,
  directionToGraphQL,
  type GraphQLBudgetType,
  type GraphQLDirection,
} from './enumMapping.js';
import { requireUserId, toGraphQLError } from './errors.js';

interface CategoryGraphQLInput {
  name: string;
  icon: string;
  color: string;
  budgetType?: GraphQLBudgetType | null;
  direction: GraphQLDirection;
}

interface TransactionGraphQLInput {
  categoryMonthId: string;
  amountCents: number;
  date: string;
  merchant?: string | null;
  note?: string | null;
}

interface RecurringExpenseTemplateGraphQLInput {
  name: string;
  amountCents: number;
  categoryId: string;
  budgetType: GraphQLBudgetType;
  dueDay: number;
}

interface MarkRecurringPaidGraphQLInput {
  amountCents: number;
  date: string;
  merchant?: string | null;
  note?: string | null;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export const schema = createSchema<GraphQLContext>({
  typeDefs: /* GraphQL */ `
    enum BudgetType {
      NEED
      WANT
      SAVINGS
    }

    enum Direction {
      EXPENSE
      INCOME
    }

    type Category {
      id: ID!
      name: String!
      icon: String!
      color: String!
      budgetType: BudgetType
      direction: Direction!
    }

    type CategoryMonth {
      id: ID!
      month: String!
      monthlyBudgetCents: Int!
      recurringCommittedCents: Int!
      category: Category!
      transactions: [Transaction!]!
    }

    type Transaction {
      id: ID!
      amountCents: Int!
      date: String!
      merchant: String
      note: String
      direction: Direction!
      categoryMonth: CategoryMonth!
      recurringExpenseInstance: RecurringExpenseInstance
    }

    type RecurringExpenseTemplate {
      id: ID!
      name: String!
      amountCents: Int!
      budgetType: BudgetType!
      dueDay: Int!
      category: Category!
    }

    type RecurringExpenseInstance {
      id: ID!
      month: String!
      amountCents: Int!
      template: RecurringExpenseTemplate!
      paidThisMonth: Boolean!
      transactions: [Transaction!]!
    }

    input CategoryInput {
      name: String!
      icon: String!
      color: String!
      budgetType: BudgetType
      direction: Direction!
    }

    input TransactionInput {
      categoryMonthId: ID!
      amountCents: Int!
      date: String!
      merchant: String
      note: String
    }

    input RecurringExpenseTemplateInput {
      name: String!
      amountCents: Int!
      categoryId: ID!
      budgetType: BudgetType!
      dueDay: Int!
    }

    input MarkRecurringPaidInput {
      amountCents: Int!
      date: String!
      merchant: String
      note: String
    }

    type Query {
      ping: String!
      categories: [Category!]!
      categoryMonths(month: String!): [CategoryMonth!]!
      transactions(month: String!, categoryId: ID): [Transaction!]!
      recurringExpenseTemplates: [RecurringExpenseTemplate!]!
      recurringExpenseInstances(month: String!): [RecurringExpenseInstance!]!
    }

    type Mutation {
      createCategory(input: CategoryInput!): Category!
      updateCategory(id: ID!, input: CategoryInput!): Category!
      deleteCategory(id: ID!): Boolean!

      addCategoryToMonth(categoryId: ID!, month: String!, monthlyBudgetCents: Int): CategoryMonth!
      removeCategoryFromMonth(categoryMonthId: ID!): Boolean!
      updateCategoryMonthBudget(categoryMonthId: ID!, monthlyBudgetCents: Int!): CategoryMonth!

      createTransaction(input: TransactionInput!): Transaction!
      updateTransaction(id: ID!, input: TransactionInput!): Transaction!
      deleteTransaction(id: ID!): Boolean!

      createRecurringExpenseTemplate(
        input: RecurringExpenseTemplateInput!
        month: String!
        categoryMonthlyBudgetCents: Int
      ): RecurringExpenseTemplate!
      updateRecurringExpenseTemplate(id: ID!, input: RecurringExpenseTemplateInput!): RecurringExpenseTemplate!
      deleteRecurringExpenseTemplate(id: ID!): Boolean!

      addRecurringExpenseToMonth(
        templateId: ID!
        month: String!
        categoryMonthlyBudgetCents: Int
      ): RecurringExpenseInstance!
      updateRecurringExpenseInstance(id: ID!, amountCents: Int!): RecurringExpenseInstance!
      removeRecurringExpenseFromMonth(id: ID!): Boolean!
      markRecurringPaid(id: ID!, input: MarkRecurringPaidInput!): Transaction!
    }
  `,
  resolvers: {
    Query: {
      ping: () => 'pong',
      categories: async (_parent, _args: unknown, context) => {
        const userId = requireUserId(context.userId);
        return context.categoryService.listCatalog(userId);
      },
      categoryMonths: async (_parent, args: { month: string }, context) => {
        const userId = requireUserId(context.userId);
        return context.categoryMonthService.listByMonth(userId, args.month);
      },
      transactions: async (_parent, args: { month: string; categoryId?: string | null }, context) => {
        const userId = requireUserId(context.userId);
        return context.transactionService.list(userId, args.month, args.categoryId ?? undefined);
      },
      recurringExpenseTemplates: async (_parent, _args: unknown, context) => {
        const userId = requireUserId(context.userId);
        return context.templateService.listCatalog(userId);
      },
      recurringExpenseInstances: async (_parent, args: { month: string }, context) => {
        const userId = requireUserId(context.userId);
        return context.instanceService.listByMonth(userId, args.month);
      },
    },
    Mutation: {
      createCategory: async (_parent, args: { input: CategoryGraphQLInput }, context) => {
        const userId = requireUserId(context.userId);
        try {
          return await context.categoryService.createCategory(userId, {
            name: args.input.name,
            icon: args.input.icon,
            color: args.input.color,
            budgetType: budgetTypeToDb(args.input.budgetType),
            direction: directionToDb(args.input.direction),
          });
        } catch (error) {
          toGraphQLError(error);
        }
      },
      updateCategory: async (
        _parent,
        args: { id: string; input: CategoryGraphQLInput },
        context,
      ) => {
        const userId = requireUserId(context.userId);
        try {
          return await context.categoryService.updateCategory(userId, args.id, {
            name: args.input.name,
            icon: args.input.icon,
            color: args.input.color,
            budgetType: budgetTypeToDb(args.input.budgetType),
            direction: directionToDb(args.input.direction),
          });
        } catch (error) {
          toGraphQLError(error);
        }
      },
      deleteCategory: async (_parent, args: { id: string }, context) => {
        const userId = requireUserId(context.userId);
        try {
          await context.categoryService.deleteCategory(userId, args.id);
          return true;
        } catch (error) {
          toGraphQLError(error);
        }
      },
      addCategoryToMonth: async (
        _parent,
        args: { categoryId: string; month: string; monthlyBudgetCents?: number | null },
        context,
      ) => {
        const userId = requireUserId(context.userId);
        try {
          return await context.categoryMonthService.addCategoryToMonth(
            userId,
            args.categoryId,
            args.month,
            args.monthlyBudgetCents ?? undefined,
          );
        } catch (error) {
          toGraphQLError(error);
        }
      },
      removeCategoryFromMonth: async (_parent, args: { categoryMonthId: string }, context) => {
        const userId = requireUserId(context.userId);
        try {
          await context.categoryMonthService.removeCategoryFromMonth(userId, args.categoryMonthId);
          return true;
        } catch (error) {
          toGraphQLError(error);
        }
      },
      updateCategoryMonthBudget: async (
        _parent,
        args: { categoryMonthId: string; monthlyBudgetCents: number },
        context,
      ) => {
        const userId = requireUserId(context.userId);
        try {
          return await context.categoryMonthService.updateCategoryMonthBudget(
            userId,
            args.categoryMonthId,
            args.monthlyBudgetCents,
          );
        } catch (error) {
          toGraphQLError(error);
        }
      },
      createTransaction: async (_parent, args: { input: TransactionGraphQLInput }, context) => {
        const userId = requireUserId(context.userId);
        try {
          return await context.transactionService.create(userId, {
            categoryMonthId: args.input.categoryMonthId,
            amountCents: args.input.amountCents,
            date: args.input.date,
            merchant: args.input.merchant ?? undefined,
            note: args.input.note ?? undefined,
          });
        } catch (error) {
          toGraphQLError(error);
        }
      },
      updateTransaction: async (
        _parent,
        args: { id: string; input: TransactionGraphQLInput },
        context,
      ) => {
        const userId = requireUserId(context.userId);
        try {
          return await context.transactionService.update(userId, args.id, {
            categoryMonthId: args.input.categoryMonthId,
            amountCents: args.input.amountCents,
            date: args.input.date,
            merchant: args.input.merchant ?? undefined,
            note: args.input.note ?? undefined,
          });
        } catch (error) {
          toGraphQLError(error);
        }
      },
      deleteTransaction: async (_parent, args: { id: string }, context) => {
        const userId = requireUserId(context.userId);
        try {
          await context.transactionService.deleteTransaction(userId, args.id);
          return true;
        } catch (error) {
          toGraphQLError(error);
        }
      },
      createRecurringExpenseTemplate: async (
        _parent,
        args: {
          input: RecurringExpenseTemplateGraphQLInput;
          month: string;
          categoryMonthlyBudgetCents?: number | null;
        },
        context,
      ) => {
        const userId = requireUserId(context.userId);
        try {
          const { template } = await context.instanceService.createTemplateForMonth(
            userId,
            {
              name: args.input.name,
              amountCents: args.input.amountCents,
              categoryId: args.input.categoryId,
              budgetType: budgetTypeToDbRequired(args.input.budgetType),
              dueDay: args.input.dueDay,
            },
            args.month,
            args.categoryMonthlyBudgetCents ?? undefined,
          );
          return template;
        } catch (error) {
          toGraphQLError(error);
        }
      },
      updateRecurringExpenseTemplate: async (
        _parent,
        args: { id: string; input: RecurringExpenseTemplateGraphQLInput },
        context,
      ) => {
        const userId = requireUserId(context.userId);
        try {
          return await context.templateService.updateTemplate(userId, args.id, {
            name: args.input.name,
            amountCents: args.input.amountCents,
            categoryId: args.input.categoryId,
            budgetType: budgetTypeToDbRequired(args.input.budgetType),
            dueDay: args.input.dueDay,
          });
        } catch (error) {
          toGraphQLError(error);
        }
      },
      deleteRecurringExpenseTemplate: async (_parent, args: { id: string }, context) => {
        const userId = requireUserId(context.userId);
        try {
          await context.templateService.deleteTemplate(userId, args.id);
          return true;
        } catch (error) {
          toGraphQLError(error);
        }
      },
      addRecurringExpenseToMonth: async (
        _parent,
        args: { templateId: string; month: string; categoryMonthlyBudgetCents?: number | null },
        context,
      ) => {
        const userId = requireUserId(context.userId);
        try {
          return await context.instanceService.addRecurringExpenseToMonth(
            userId,
            args.templateId,
            args.month,
            args.categoryMonthlyBudgetCents ?? undefined,
          );
        } catch (error) {
          toGraphQLError(error);
        }
      },
      updateRecurringExpenseInstance: async (
        _parent,
        args: { id: string; amountCents: number },
        context,
      ) => {
        const userId = requireUserId(context.userId);
        try {
          return await context.instanceService.updateInstance(userId, args.id, args.amountCents);
        } catch (error) {
          toGraphQLError(error);
        }
      },
      removeRecurringExpenseFromMonth: async (_parent, args: { id: string }, context) => {
        const userId = requireUserId(context.userId);
        try {
          await context.instanceService.removeFromMonth(userId, args.id);
          return true;
        } catch (error) {
          toGraphQLError(error);
        }
      },
      markRecurringPaid: async (
        _parent,
        args: { id: string; input: MarkRecurringPaidGraphQLInput },
        context,
      ) => {
        const userId = requireUserId(context.userId);
        try {
          return await context.instanceService.markRecurringPaid(userId, args.id, {
            amountCents: args.input.amountCents,
            date: args.input.date,
            merchant: args.input.merchant ?? undefined,
            note: args.input.note ?? undefined,
          });
        } catch (error) {
          toGraphQLError(error);
        }
      },
    },
    Category: {
      budgetType: (parent: { budgetType: 'need' | 'want' | 'savings' | null }) =>
        budgetTypeToGraphQL(parent.budgetType),
      direction: (parent: { direction: 'expense' | 'income' }) => directionToGraphQL(parent.direction),
    },
    CategoryMonth: {
      month: async (parent: { monthId: string }, _args: unknown, context) => {
        const budgetMonth = await context.loaders.budgetMonthById.load(parent.monthId);
        if (!budgetMonth) {
          throw new Error(`Data integrity error: BudgetMonth ${parent.monthId} not found`);
        }
        return budgetMonth.month;
      },
      category: async (parent: { categoryId: string }, _args: unknown, context) => {
        return context.loaders.categoryById.load(parent.categoryId);
      },
      transactions: async (parent: { id: string }, _args: unknown, context) => {
        return context.loaders.transactionsByCategoryMonthId.load(parent.id);
      },
      recurringCommittedCents: async (parent: { id: string }, _args: unknown, context) => {
        return context.loaders.recurringCommittedCentsByCategoryMonthId.load(parent.id);
      },
    },
    Transaction: {
      date: (parent: { date: Date }) => formatDate(parent.date),
      direction: (parent: { direction: 'expense' | 'income' }) => directionToGraphQL(parent.direction),
      categoryMonth: async (parent: { categoryMonthId: string }, _args: unknown, context) => {
        return context.loaders.categoryMonthById.load(parent.categoryMonthId);
      },
      recurringExpenseInstance: async (
        parent: { recurringExpenseInstanceId: string | null },
        _args: unknown,
        context,
      ) => {
        if (!parent.recurringExpenseInstanceId) return null;
        return context.loaders.recurringExpenseInstanceById.load(parent.recurringExpenseInstanceId);
      },
    },
    RecurringExpenseTemplate: {
      budgetType: (parent: { budgetType: 'need' | 'want' }) => budgetTypeToGraphQL(parent.budgetType),
      category: async (parent: { categoryId: string }, _args: unknown, context) => {
        return context.loaders.categoryById.load(parent.categoryId);
      },
    },
    RecurringExpenseInstance: {
      month: async (parent: { monthId: string }, _args: unknown, context) => {
        const budgetMonth = await context.loaders.budgetMonthById.load(parent.monthId);
        if (!budgetMonth) {
          throw new Error(`Data integrity error: BudgetMonth ${parent.monthId} not found`);
        }
        return budgetMonth.month;
      },
      template: async (parent: { templateId: string }, _args: unknown, context) => {
        const template = await context.loaders.recurringExpenseTemplateById.load(parent.templateId);
        if (!template) {
          throw new Error(`Data integrity error: RecurringExpenseTemplate ${parent.templateId} not found`);
        }
        return template;
      },
      transactions: async (parent: { id: string }, _args: unknown, context) => {
        return context.loaders.transactionsByRecurringExpenseInstanceId.load(parent.id);
      },
      paidThisMonth: async (parent: { id: string; amountCents: number }, _args: unknown, context) => {
        const transactions = await context.loaders.transactionsByRecurringExpenseInstanceId.load(
          parent.id,
        );
        const paidCents = transactions.reduce((sum, transaction) => sum + transaction.amountCents, 0);
        return paidCents >= parent.amountCents;
      },
    },
  },
});
