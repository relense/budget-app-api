/**
 * Dev-only seed script (Build Order step 8) — populates a dedicated
 * throwaway account (SEED_EMAIL) with realistic categories, recurring
 * bills, and income sources, for local testing. Idempotent: re-running it
 * deletes and recreates that account's data from scratch, so it's safe to
 * run repeatedly against a dev database. Never touches real user data —
 * this is deliberately not what a real signup gets (that's the separate,
 * generic default-category seeding in authService).
 *
 * No transactions, no savings funds, no bank balance checkpoint — just
 * the catalog + current month's activations, per the explicit scope
 * agreed with the user (see docs/PROGRESS.md).
 *
 * Run with: npm run seed
 */
import { loadEnv } from '../src/lib/env.js';
import { formatMonth } from '../src/lib/monthFormat.js';
import { createPrismaClient, type PrismaClient } from '../src/lib/prisma.js';
import { createBudgetMonthService } from '../src/services/budgetMonths/budgetMonthService.js';
import { createCategoryMonthService } from '../src/services/categories/categoryMonthService.js';
import { createCategoryService } from '../src/services/categories/categoryService.js';
import { createTransactionService } from '../src/services/categories/transactionService.js';
import { createRecurringExpenseService } from '../src/services/recurringExpenses/recurringExpenseService.js';

const SEED_EMAIL = 'seed@example.com';

type BudgetType = 'need' | 'want';

interface ExpenseCategorySeed {
  name: string;
  icon: string;
  color: string;
  budgetType: BudgetType;
  monthlyBudgetCents: number;
}

interface IncomeCategorySeed {
  name: string;
  icon: string;
  color: string;
  expectedAmountCents: number;
}

interface RecurringBillSeed {
  name: string;
  amountCents: number;
}

// Real category set from the user's own Excel tracker — English names per
// their explicit "always name things in English" instruction, budgets and
// need/want (Preciso/Quero) taken directly from the sheet's August budget
// column. Icon/color are placeholders (the sheet has no design scheme);
// cosmetic only, not part of the grilled scope.
const EXPENSE_CATEGORIES: ExpenseCategorySeed[] = [
  { name: 'Shopping', icon: 'cart', color: '#4C6EF5', budgetType: 'need', monthlyBudgetCents: 70000 },
  { name: 'Eating Out', icon: 'utensils', color: '#F76707', budgetType: 'want', monthlyBudgetCents: 12377 },
  { name: 'Gas', icon: 'fuel', color: '#495057', budgetType: 'need', monthlyBudgetCents: 8644 },
  { name: 'Tolls', icon: 'road', color: '#868E96', budgetType: 'want', monthlyBudgetCents: 3320 },
  { name: 'Health', icon: 'heart', color: '#E03131', budgetType: 'need', monthlyBudgetCents: 25000 },
  { name: 'Hobbies', icon: 'star', color: '#7048E8', budgetType: 'want', monthlyBudgetCents: 0 },
  { name: 'Books', icon: 'book', color: '#1971C2', budgetType: 'want', monthlyBudgetCents: 0 },
  { name: 'Clothes & Accessories', icon: 'shirt', color: '#D6336C', budgetType: 'want', monthlyBudgetCents: 0 },
  { name: 'Bakery & Coffee', icon: 'coffee', color: '#A66A2E', budgetType: 'want', monthlyBudgetCents: 0 },
  { name: 'Gifts', icon: 'gift', color: '#F06595', budgetType: 'want', monthlyBudgetCents: 0 },
  { name: 'Night', icon: 'moon', color: '#343A40', budgetType: 'want', monthlyBudgetCents: 0 },
  { name: 'Extras', icon: 'plus-circle', color: '#495057', budgetType: 'want', monthlyBudgetCents: 10905 },
  { name: 'Tech', icon: 'cpu', color: '#0CA678', budgetType: 'want', monthlyBudgetCents: 0 },
];

const FIXED_BILLS_CATEGORY = {
  name: 'Fixed Bills',
  icon: 'file-text',
  color: '#212529',
  budgetType: 'need' as const,
  // Sum of the recurring bills below, matching the Excel's own CONTAS
  // budget total — only actually used the first time a bill activates
  // this category for the month.
  monthlyBudgetCents: 149047,
};

const RECURRING_BILLS: RecurringBillSeed[] = [
  { name: 'Water', amountCents: 4369 },
  { name: 'CGD Bank Fees', amountCents: 416 },
  { name: 'Galp', amountCents: 5667 },
  { name: 'Internet', amountCents: 1500 },
  { name: 'Rent', amountCents: 79600 },
  { name: "Inês's Phone", amountCents: 1000 },
  { name: "Miguel's Phone", amountCents: 500 },
  { name: 'Health Insurance', amountCents: 16266 },
  { name: 'Spotify', amountCents: 1699 },
  { name: 'Apple', amountCents: 299 },
  { name: 'Arche Training', amountCents: 26000 },
  { name: 'Acupuncture', amountCents: 9000 },
  { name: 'Ultracc', amountCents: 894 },
  { name: 'Claude', amountCents: 1837 },
];

const INCOME_CATEGORIES: IncomeCategorySeed[] = [
  { name: 'Obconnect', icon: 'briefcase', color: '#2F9E44', expectedAmountCents: 450000 },
  { name: 'Segurança Social', icon: 'shield', color: '#2F9E44', expectedAmountCents: 81662 },
];

async function seed(prisma: PrismaClient) {
  const budgetMonthService = createBudgetMonthService({ prisma });
  const categoryService = createCategoryService({ prisma });
  const categoryMonthService = createCategoryMonthService({ prisma, budgetMonthService });
  const transactionService = createTransactionService({ prisma, budgetMonthService });
  const recurringExpenseService = createRecurringExpenseService({
    prisma,
    budgetMonthService,
    transactionService,
  });

  const month = formatMonth(new Date());

  const existing = await prisma.user.findUnique({ where: { email: SEED_EMAIL } });
  if (existing) {
    console.log(`Removing existing seed user (${SEED_EMAIL})...`);
    // Order matters: transactions.recurring_expense_id and
    // transactions.category_month_id are both ON DELETE RESTRICT, so
    // transactions must go first. budget_months has an onDelete: Restrict
    // FK to users (see PLAN.md's GDPR note) — Restrict doesn't cascade
    // anything, so it still needs an explicit delete too, or every re-run
    // leaks one more orphaned row (and would now fail the FK outright
    // instead of leaking, if this were ever skipped). Wrapped in a
    // transaction so a failure partway through never leaves this account
    // half-deleted.
    await prisma.$transaction([
      prisma.transaction.deleteMany({ where: { userId: existing.id } }),
      prisma.recurringExpense.deleteMany({ where: { userId: existing.id } }),
      prisma.categoryMonth.deleteMany({ where: { userId: existing.id } }),
      prisma.category.deleteMany({ where: { userId: existing.id } }),
      prisma.budgetMonth.deleteMany({ where: { userId: existing.id } }),
      prisma.user.delete({ where: { id: existing.id } }),
    ]);
  }

  const user = await prisma.user.create({ data: { email: SEED_EMAIL } });
  console.log(`Created seed user ${user.email} (${user.id}), seeding month ${month}...`);

  for (const seed of EXPENSE_CATEGORIES) {
    const category = await categoryService.createCategory(user.id, {
      name: seed.name,
      icon: seed.icon,
      color: seed.color,
      budgetType: seed.budgetType,
      direction: 'expense',
    });
    await categoryMonthService.addCategoryToMonth(user.id, category.id, month, seed.monthlyBudgetCents);
    console.log(`  Category: ${seed.name} (${seed.budgetType}, ${seed.monthlyBudgetCents} cents)`);
  }

  const fixedBills = await categoryService.createCategory(user.id, {
    name: FIXED_BILLS_CATEGORY.name,
    icon: FIXED_BILLS_CATEGORY.icon,
    color: FIXED_BILLS_CATEGORY.color,
    budgetType: FIXED_BILLS_CATEGORY.budgetType,
    direction: 'expense',
  });
  console.log(`  Category: ${FIXED_BILLS_CATEGORY.name} (${FIXED_BILLS_CATEGORY.budgetType})`);

  for (const [index, bill] of RECURRING_BILLS.entries()) {
    await recurringExpenseService.createRecurringExpense(
      user.id,
      {
        name: bill.name,
        amountCents: bill.amountCents,
        categoryId: fixedBills.id,
        budgetType: 'need',
        dueDay: 1,
      },
      month,
      index === 0 ? FIXED_BILLS_CATEGORY.monthlyBudgetCents : undefined,
    );
    console.log(`    Recurring bill: ${bill.name} (${bill.amountCents} cents)`);
  }

  for (const seed of INCOME_CATEGORIES) {
    const category = await categoryService.createCategory(user.id, {
      name: seed.name,
      icon: seed.icon,
      color: seed.color,
      direction: 'income',
    });
    await categoryMonthService.addCategoryToMonth(user.id, category.id, month, seed.expectedAmountCents);
    console.log(`  Income category: ${seed.name} (${seed.expectedAmountCents} cents)`);
  }

  console.log(
    `\nDone. ${EXPENSE_CATEGORIES.length + 1} expense categories, ${RECURRING_BILLS.length} recurring bills, ${INCOME_CATEGORIES.length} income categories seeded for ${SEED_EMAIL} in ${month}.`,
  );
}

async function main() {
  const env = loadEnv();
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to run the seed script against a production environment.');
  }
  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    await seed(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
