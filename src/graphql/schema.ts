import { createSchema } from 'graphql-yoga';
import type { GraphQLContext } from './context.js';
import {
  budgetTypeToDb,
  budgetTypeToDbRequired,
  budgetTypeToGraphQL,
  directionToDb,
  directionToGraphQL,
  movementTypeToDb,
  movementTypeToGraphQL,
} from './enumMapping.js';
import { requireUserId, toGraphQLError } from './errors.js';
import type { MutationResolvers, QueryResolvers } from '../generated/graphql.js';

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatNullableDate(date: Date | null): string | null {
  return date ? formatDate(date) : null;
}

/**
 * Full ISO 8601 timestamp, not a bare YYYY-MM-DD — the one place in this
 * schema that needs time-of-day, since BankBalance.checkpointSetAt anchors
 * "everything after this instant", not a calendar date.
 */
function formatTimestamp(date: Date): string {
  return date.toISOString();
}

const typeDefs = /* GraphQL */ `
  enum BudgetType {
    NEED
    WANT
    SAVINGS
  }

  enum Direction {
    EXPENSE
    INCOME
  }

  enum MovementType {
    DEPOSIT
    WITHDRAW
  }

  type BudgetMonth {
    month: String!
    locked: Boolean!
  }

  type Category {
    id: ID!
    name: String!
    icon: String!
    color: String!
    budgetType: BudgetType
    direction: Direction!
  }

  """
  actualAmountCents is the sum of this CategoryMonth's own transactions —
  computed at read time, same pattern as recurringCommittedCents/
  paidThisMonth/achieved. Direction-agnostic: for an expense category it's
  "spent so far", for an income category (income has no dedicated entity —
  it's just a Category with direction: INCOME, see the Query.categoryMonths
  'direction' argument below) it's "received so far", against the same
  monthlyBudgetCents used as the planned/expected number either way.
  """
  type CategoryMonth {
    id: ID!
    month: String!
    monthlyBudgetCents: Int!
    actualAmountCents: Int!
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
    recurringExpense: RecurringExpense
  }

  """
  One flat row per recurring expense per month it exists in — no separate
  template, unlike the superseded design (see docs/PLAN.md). Editing one
  only ever touches this row; carrying it into a new month is automatic
  (see Query.recurringExpenses / Month Lifecycle in docs/PLAN.md).
  """
  type RecurringExpense {
    id: ID!
    month: String!
    name: String!
    amountCents: Int!
    budgetType: BudgetType!
    dueDay: Int!
    category: Category!
    paidThisMonth: Boolean!
    transactions: [Transaction!]!
  }

  """
  A long-running savings goal, unrelated to any single month (see
  docs/GLOSSARY.md's "Category vs. Savings Fund"). currentAmountCents and
  achieved are computed at read time (initialBalanceCents + the net of
  every movement, and currentAmountCents >= targetAmountCents
  respectively) — never stored, so they can't drift out of sync.
  """
  type SavingsFund {
    id: ID!
    name: String!
    targetAmountCents: Int
    initialBalanceCents: Int!
    currentAmountCents: Int!
    startDate: String
    endDate: String
    monthlyTargetCents: Int
    achieved: Boolean!
    movements: [SavingsMovement!]!
  }

  """
  One deposit/withdrawal event against a fund — same relationship to
  SavingsFund as Transaction has to CategoryMonth. Editable/deletable
  after creation; every write re-validates the fund's resulting balance
  can never go negative.
  """
  type SavingsMovement {
    id: ID!
    amountCents: Int!
    type: MovementType!
    date: String!
    fund: SavingsFund!
  }

  """
  A running total independent of any one month, unrelated to Savings
  Funds (deliberately not netted together — see docs/PLAN.md's "Bank
  balance" note). Computed at read time: checkpointAmountCents plus the
  net of every Transaction created after checkpointSetAt. Editing the
  checkpoint (setBankBalanceCheckpoint) overwrites both fields in place —
  no history is kept, and everything before the new checkpointSetAt stops
  counting toward amountCents. checkpointSetAt is a full ISO 8601
  timestamp, not a bare date like every other date field in this schema —
  it anchors an instant, not a calendar day.
  """
  type BankBalance {
    amountCents: Int!
    checkpointAmountCents: Int!
    checkpointSetAt: String!
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

  input RecurringExpenseInput {
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

  input CreateSavingsFundInput {
    name: String!
    targetAmountCents: Int
    initialBalanceCents: Int!
    startDate: String
    endDate: String
    monthlyTargetCents: Int
  }

  """initialBalanceCents deliberately absent — settable only at creation, never here (see the SavingsFund type doc)."""
  input UpdateSavingsFundInput {
    name: String!
    targetAmountCents: Int
    startDate: String
    endDate: String
    monthlyTargetCents: Int
  }

  input CreateSavingsMovementInput {
    fundId: ID!
    amountCents: Int!
    type: MovementType!
    date: String!
  }

  """fundId deliberately absent — a movement can't be reassigned to a different fund on update."""
  input UpdateSavingsMovementInput {
    amountCents: Int!
    type: MovementType!
    date: String!
  }

  type Query {
    ping: String!
    currentMonth: BudgetMonth!
    categories: [Category!]!
    categoryMonths(month: String!, direction: Direction): [CategoryMonth!]!
    transactions(month: String!, categoryId: ID): [Transaction!]!
    recurringExpenses(month: String!): [RecurringExpense!]!
    savingsFunds: [SavingsFund!]!
    bankBalance: BankBalance!
  }

  type Mutation {
    lockMonth(month: String!): BudgetMonth!
    deleteBudgetMonth(month: String!): Boolean!

    createCategory(input: CategoryInput!): Category!
    updateCategory(id: ID!, input: CategoryInput!): Category!
    deleteCategory(id: ID!): Boolean!

    addCategoryToMonth(categoryId: ID!, month: String!, monthlyBudgetCents: Int): CategoryMonth!
    removeCategoryFromMonth(categoryMonthId: ID!): Boolean!
    updateCategoryMonthBudget(categoryMonthId: ID!, monthlyBudgetCents: Int!): CategoryMonth!

    createTransaction(input: TransactionInput!): Transaction!
    updateTransaction(id: ID!, input: TransactionInput!): Transaction!
    deleteTransaction(id: ID!): Boolean!

    createRecurringExpense(
      input: RecurringExpenseInput!
      month: String!
      categoryMonthlyBudgetCents: Int
    ): RecurringExpense!
    updateRecurringExpense(id: ID!, input: RecurringExpenseInput!): RecurringExpense!
    removeRecurringExpenseFromMonth(id: ID!): Boolean!
    markRecurringPaid(id: ID!, input: MarkRecurringPaidInput!): Transaction!

    createSavingsFund(input: CreateSavingsFundInput!): SavingsFund!
    updateSavingsFund(id: ID!, input: UpdateSavingsFundInput!): SavingsFund!
    deleteSavingsFund(id: ID!): Boolean!

    createSavingsMovement(input: CreateSavingsMovementInput!): SavingsMovement!
    updateSavingsMovement(id: ID!, input: UpdateSavingsMovementInput!): SavingsMovement!
    deleteSavingsMovement(id: ID!): Boolean!

    setBankBalanceCheckpoint(amountCents: Int!): BankBalance!
  }
`;

// Typed against the generated Resolvers (see codegen.ts) rather than
// hand-rolled per-field arg interfaces — args/return types are inferred
// straight from these declared types, so a resolver that's drifted from
// the schema (wrong field name, mismatched arg/return type) is now a
// compile error. Every field here is still technically optional to
// codegen (GraphQL allows a default property-access resolver), so a
// brand-new schema field with *no* resolver at all still typechecks —
// that failure mode still only surfaces at request time.
// Exported (not just used below) so tests can assert every Query/Mutation
// field the SDL declares has a matching key here — codegen's generated
// Resolvers types make every field optional (GraphQL allows a default
// property-access resolver), so a brand-new field with no resolver at all
// still typechecks; this is the runtime backstop for that gap, see
// tests/graphql/schema.test.ts.
export const queryResolvers: QueryResolvers<GraphQLContext> = {
  ping: () => 'pong',
  currentMonth: async (_parent, _args, context) => {
    const userId = requireUserId(context.userId);
    return context.budgetMonthService.findCurrentMonth(userId);
  },
  categories: async (_parent, _args, context) => {
    const userId = requireUserId(context.userId);
    return context.categoryService.listCatalog(userId);
  },
  categoryMonths: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    return context.categoryMonthService.listByMonth(
      userId,
      args.month,
      args.direction ? directionToDb(args.direction) : undefined,
    );
  },
  transactions: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    return context.transactionService.list(userId, args.month, args.categoryId ?? undefined);
  },
  recurringExpenses: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    return context.recurringExpenseService.listByMonth(userId, args.month);
  },
  savingsFunds: async (_parent, _args, context) => {
    const userId = requireUserId(context.userId);
    return context.savingsFundService.listCatalog(userId);
  },
  bankBalance: async (_parent, _args, context) => {
    const userId = requireUserId(context.userId);
    return context.bankBalanceService.getBankBalance(userId);
  },
};

export const mutationResolvers: MutationResolvers<GraphQLContext> = {
  lockMonth: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    try {
      return await context.budgetMonthService.lockMonth(userId, args.month);
    } catch (error) {
      toGraphQLError(error);
    }
  },
  deleteBudgetMonth: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    try {
      await context.budgetMonthService.deleteBudgetMonth(userId, args.month);
      return true;
    } catch (error) {
      toGraphQLError(error);
    }
  },
  createCategory: async (_parent, args, context) => {
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
  updateCategory: async (_parent, args, context) => {
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
  deleteCategory: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    try {
      await context.categoryService.deleteCategory(userId, args.id);
      return true;
    } catch (error) {
      toGraphQLError(error);
    }
  },
  addCategoryToMonth: async (_parent, args, context) => {
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
  removeCategoryFromMonth: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    try {
      await context.categoryMonthService.removeCategoryFromMonth(userId, args.categoryMonthId);
      return true;
    } catch (error) {
      toGraphQLError(error);
    }
  },
  updateCategoryMonthBudget: async (_parent, args, context) => {
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
  createTransaction: async (_parent, args, context) => {
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
  updateTransaction: async (_parent, args, context) => {
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
  deleteTransaction: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    try {
      await context.transactionService.deleteTransaction(userId, args.id);
      return true;
    } catch (error) {
      toGraphQLError(error);
    }
  },
  createRecurringExpense: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    try {
      return await context.recurringExpenseService.createRecurringExpense(
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
    } catch (error) {
      toGraphQLError(error);
    }
  },
  updateRecurringExpense: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    try {
      return await context.recurringExpenseService.updateRecurringExpense(userId, args.id, {
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
  removeRecurringExpenseFromMonth: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    try {
      await context.recurringExpenseService.removeFromMonth(userId, args.id);
      return true;
    } catch (error) {
      toGraphQLError(error);
    }
  },
  markRecurringPaid: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    try {
      return await context.recurringExpenseService.markRecurringPaid(userId, args.id, {
        amountCents: args.input.amountCents,
        date: args.input.date,
        merchant: args.input.merchant ?? undefined,
        note: args.input.note ?? undefined,
      });
    } catch (error) {
      toGraphQLError(error);
    }
  },
  createSavingsFund: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    try {
      return await context.savingsFundService.createSavingsFund(userId, {
        name: args.input.name,
        targetAmountCents: args.input.targetAmountCents ?? undefined,
        initialBalanceCents: args.input.initialBalanceCents,
        startDate: args.input.startDate ?? undefined,
        endDate: args.input.endDate ?? undefined,
        monthlyTargetCents: args.input.monthlyTargetCents ?? undefined,
      });
    } catch (error) {
      toGraphQLError(error);
    }
  },
  updateSavingsFund: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    try {
      return await context.savingsFundService.updateSavingsFund(userId, args.id, {
        name: args.input.name,
        targetAmountCents: args.input.targetAmountCents ?? undefined,
        startDate: args.input.startDate ?? undefined,
        endDate: args.input.endDate ?? undefined,
        monthlyTargetCents: args.input.monthlyTargetCents ?? undefined,
      });
    } catch (error) {
      toGraphQLError(error);
    }
  },
  deleteSavingsFund: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    try {
      await context.savingsFundService.deleteSavingsFund(userId, args.id);
      return true;
    } catch (error) {
      toGraphQLError(error);
    }
  },
  createSavingsMovement: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    try {
      return await context.savingsMovementService.createSavingsMovement(userId, {
        fundId: args.input.fundId,
        amountCents: args.input.amountCents,
        type: movementTypeToDb(args.input.type),
        date: args.input.date,
      });
    } catch (error) {
      toGraphQLError(error);
    }
  },
  updateSavingsMovement: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    try {
      return await context.savingsMovementService.updateSavingsMovement(userId, args.id, {
        amountCents: args.input.amountCents,
        type: movementTypeToDb(args.input.type),
        date: args.input.date,
      });
    } catch (error) {
      toGraphQLError(error);
    }
  },
  deleteSavingsMovement: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    try {
      await context.savingsMovementService.deleteSavingsMovement(userId, args.id);
      return true;
    } catch (error) {
      toGraphQLError(error);
    }
  },
  setBankBalanceCheckpoint: async (_parent, args, context) => {
    const userId = requireUserId(context.userId);
    try {
      return await context.bankBalanceService.setBankBalanceCheckpoint(userId, args.amountCents);
    } catch (error) {
      toGraphQLError(error);
    }
  },
};

export const schema = createSchema<GraphQLContext>({
  typeDefs,
  resolvers: {
    Query: queryResolvers,
    Mutation: mutationResolvers,
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
      actualAmountCents: async (parent: { id: string }, _args: unknown, context) => {
        const transactions = await context.loaders.transactionsByCategoryMonthId.load(parent.id);
        return transactions.reduce((sum, transaction) => sum + transaction.amountCents, 0);
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
      recurringExpense: async (
        parent: { recurringExpenseId: string | null },
        _args: unknown,
        context,
      ) => {
        if (!parent.recurringExpenseId) return null;
        return context.loaders.recurringExpenseById.load(parent.recurringExpenseId);
      },
    },
    RecurringExpense: {
      budgetType: (parent: { budgetType: 'need' | 'want' }) => budgetTypeToGraphQL(parent.budgetType),
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
        return context.loaders.transactionsByRecurringExpenseId.load(parent.id);
      },
      paidThisMonth: async (parent: { id: string; amountCents: number }, _args: unknown, context) => {
        const transactions = await context.loaders.transactionsByRecurringExpenseId.load(parent.id);
        const paidCents = transactions.reduce((sum, transaction) => sum + transaction.amountCents, 0);
        return paidCents >= parent.amountCents;
      },
    },
    SavingsFund: {
      startDate: (parent: { startDate: Date | null }) => formatNullableDate(parent.startDate),
      endDate: (parent: { endDate: Date | null }) => formatNullableDate(parent.endDate),
      currentAmountCents: async (parent: { id: string }, _args: unknown, context) => {
        return context.loaders.currentAmountCentsBySavingsFundId.load(parent.id);
      },
      achieved: async (
        parent: { id: string; targetAmountCents: number | null },
        _args: unknown,
        context,
      ) => {
        if (parent.targetAmountCents === null) return false;
        const currentAmountCents = await context.loaders.currentAmountCentsBySavingsFundId.load(parent.id);
        return currentAmountCents >= parent.targetAmountCents;
      },
      movements: async (parent: { id: string }, _args: unknown, context) => {
        return context.loaders.movementsBySavingsFundId.load(parent.id);
      },
    },
    SavingsMovement: {
      date: (parent: { date: Date }) => formatDate(parent.date),
      type: (parent: { type: 'deposit' | 'withdraw' }) => movementTypeToGraphQL(parent.type),
      fund: async (parent: { fundId: string }, _args: unknown, context) => {
        const fund = await context.loaders.savingsFundById.load(parent.fundId);
        if (!fund) {
          throw new Error(`Data integrity error: SavingsFund ${parent.fundId} not found`);
        }
        return fund;
      },
    },
    BankBalance: {
      checkpointSetAt: (parent: { checkpointSetAt: Date }) => formatTimestamp(parent.checkpointSetAt),
    },
  },
});
