import type { BudgetMonthService } from '../budgetMonths/budgetMonthService.js';
import {
  findCurrentMonthOnClient,
  lockBudgetMonthRow,
  resolveBudgetMonthId,
} from '../budgetMonths/budgetMonthService.js';
import { assertOwnedCategory, CategoryServiceError } from './categoryService.js';
import { addMonths, isValidMonthFormat } from '../../lib/monthFormat.js';
import type { PrismaClient } from '../../lib/prisma.js';
import { hasPrismaErrorCode } from '../../lib/prismaErrors.js';

export type CategoryMonthServiceErrorReason =
  | 'category_month_not_found'
  | 'category_month_already_active'
  | 'category_month_has_transactions'
  | 'category_month_budget_required'
  | 'category_month_beyond_planning_horizon'
  | 'month_locked'
  | 'budget_month_not_found'
  | 'invalid_budget'
  | 'invalid_month';

export class CategoryMonthServiceError extends Error {
  constructor(public readonly reason: CategoryMonthServiceErrorReason) {
    super(`CategoryMonth operation failed: ${reason}`);
    this.name = 'CategoryMonthServiceError';
  }
}

export interface CategoryMonthServiceDeps {
  prisma: Pick<
    PrismaClient,
    'category' | 'categoryMonth' | 'transaction' | 'budgetMonth' | '$transaction' | '$queryRaw'
  >;
  budgetMonthService: Pick<BudgetMonthService, 'resolveBudgetMonthId' | 'findBudgetMonthId'>;
  now?: () => Date;
}

function assertValidBudget(monthlyBudgetCents: number): void {
  if (!Number.isInteger(monthlyBudgetCents) || monthlyBudgetCents < 0) {
    throw new CategoryMonthServiceError('invalid_budget');
  }
}

function assertValidMonth(month: string): void {
  if (!isValidMonthFormat(month)) {
    throw new CategoryMonthServiceError('invalid_month');
  }
}

/**
 * When no budget is given explicitly, inherits the category's most
 * recent (by calendar month, not insertion order) category_month's budget
 * — carry-forward / pre-provisioning next month while it's already active —
 * or requires an explicit one if this category has never been active
 * anywhere yet. "Most recent" can still span several months, e.g. a
 * category last active two months ago before a gap — this just picks the
 * latest of whatever activations already exist, it doesn't imply anything
 * about which months are *newly* creatable (see assertWithinPlanningHorizon
 * for that). Scoped by userId too: both call sites already run
 * assertOwnedCategory first, so this is defense-in-depth, not the only
 * thing standing between users.
 */
async function resolveBudgetForActivation(
  client: Pick<PrismaClient, 'categoryMonth' | 'budgetMonth'>,
  userId: string,
  categoryId: string,
  monthlyBudgetCents: number | undefined,
): Promise<number> {
  if (monthlyBudgetCents !== undefined) {
    assertValidBudget(monthlyBudgetCents);
    return monthlyBudgetCents;
  }

  const priorActivations = await client.categoryMonth.findMany({ where: { userId, categoryId } });
  if (priorActivations.length === 0) {
    throw new CategoryMonthServiceError('category_month_budget_required');
  }

  // "YYYY-MM" sorts lexicographically the same as chronologically, so a
  // plain string comparison is enough once each row is paired with its
  // real month — no need to parse dates.
  const budgetMonths = await client.budgetMonth.findMany({
    where: { id: { in: priorActivations.map((row) => row.monthId) } },
  });
  const monthById = new Map(budgetMonths.map((budgetMonth) => [budgetMonth.id, budgetMonth.month]));

  const mostRecent = priorActivations.reduce((latest, row) => {
    const rowMonth = monthById.get(row.monthId) ?? '';
    const latestMonth = monthById.get(latest.monthId) ?? '';
    return rowMonth > latestMonth ? row : latest;
  });
  return mostRecent.monthlyBudgetCents;
}

/**
 * Takes lockBudgetMonthRow before checking `locked` — must be called inside
 * a $transaction. Every write path in this file that needs "is this month
 * locked" goes through this, not a plain read, so it actually serializes
 * against a concurrent lockMonth instead of racing it.
 */
async function assertMonthNotLockedOnClient(
  client: Pick<PrismaClient, 'budgetMonth' | '$queryRaw'>,
  monthId: string,
): Promise<void> {
  await lockBudgetMonthRow(client, monthId);
  const budgetMonth = await client.budgetMonth.findUnique({ where: { id: monthId } });
  if (!budgetMonth) {
    // Only reachable for a month with zero category_month rows so far —
    // resolveBudgetMonthId guarantees the row exists before this runs, so
    // it can only be gone if a concurrent deleteBudgetMonth won the race
    // for this same row (it takes the identical lock first). Surfaced
    // explicitly rather than treating "gone" the same as "not locked"
    // (budgetMonth?.locked would be undefined, falsy) — that would let the
    // caller fall through into an uncaught FK violation on the insert
    // that follows instead of a clean, typed error.
    throw new CategoryMonthServiceError('budget_month_not_found');
  }
  if (budgetMonth.locked) {
    throw new CategoryMonthServiceError('month_locked');
  }
}

/**
 * A brand-new activation is only ever allowed in the current month or the
 * one right after it — never further ahead, and never in the past either
 * (PLAN.md's "Month Lifecycle" section; the future-only cap is the phase-1
 * rule, further-ahead planning is a candidate paid-tier feature). Blocking
 * the past isn't just a symmetry nicety: "current" is derived elsewhere
 * (findCurrentMonthOnClient) as the *earliest unlocked* BudgetMonth row, so
 * if a past month were ever allowed to be newly created here, that
 * freshly-created (always unlocked) row would itself become the new
 * "earliest unlocked" — silently dragging "current" itself backwards for
 * every future call this user makes. Exported standalone so
 * recurringExpenseInstanceService's auto-activation path (which shares
 * ensureActiveForCategoryOnClient) enforces the identical rule, not a
 * separately-maintained copy.
 *
 * Takes the already-derived `currentMonth` rather than deriving it itself:
 * callers must capture that *before* calling resolveBudgetMonthId for the
 * target month. resolveBudgetMonthId upserts (permanently creates) a
 * BudgetMonth row for `month` if none exists yet — calling it before this
 * check would let a since-created row for a month this check is about to
 * reject leak into the permanent record anyway (and, for a past month,
 * hijack "current" as described above) — a rejection must never have
 * side effects.
 */
export function assertWithinPlanningHorizon(currentMonth: string, month: string): void {
  const horizon = addMonths(currentMonth, 1);
  if (month < currentMonth || month > horizon) {
    throw new CategoryMonthServiceError('category_month_beyond_planning_horizon');
  }
}

/**
 * Client-parameterized core of ensureActiveForCategory — exported standalone
 * so a caller that already has its own open transaction (e.g.
 * recurringExpenseInstanceService's locked instance-creation flow) can run
 * this as part of that same transaction. No nested transaction here (Prisma
 * doesn't support nesting $transaction calls) — the bound service method
 * below supplies one for regular (non-nested) callers.
 */
export async function ensureActiveForCategoryOnClient(
  client: Pick<PrismaClient, 'category' | 'categoryMonth' | 'budgetMonth' | '$queryRaw'>,
  userId: string,
  categoryId: string,
  month: string,
  monthlyBudgetCents?: number,
  now: () => Date = () => new Date(),
) {
  assertValidMonth(month);
  await assertOwnedCategory(client, userId, categoryId);

  // Captured before resolveBudgetMonthId's upsert below — see
  // assertWithinPlanningHorizon's doc comment for why the ordering matters.
  const current = await findCurrentMonthOnClient(client, userId, now);

  // Read-only — unlike resolveBudgetMonthId below, never creates a row.
  // Only used to decide whether this call is idempotent (category already
  // active this month, the one case the horizon check doesn't apply to);
  // resolveBudgetMonthId's upsert must not run at all until that's
  // resolved, so a rejected month can't leave a row behind regardless of
  // how this call would otherwise have turned out.
  const existingBudgetMonth = await client.budgetMonth.findUnique({
    where: { userId_month: { userId, month } },
  });
  const alreadyActive = existingBudgetMonth
    ? await client.categoryMonth.findFirst({ where: { categoryId, monthId: existingBudgetMonth.id } })
    : null;

  // Only enforced when this call would actually create a new activation —
  // pre-provisioning a month a category is already active in is always
  // allowed regardless of how far ahead it is, same as the rest of this
  // function's idempotent-if-already-active design.
  if (!alreadyActive) {
    assertWithinPlanningHorizon(current.month, month);
  }

  const monthId = await resolveBudgetMonthId(client, userId, month);
  await assertMonthNotLockedOnClient(client, monthId);

  if (alreadyActive) return alreadyActive;

  const resolvedBudget = await resolveBudgetForActivation(client, userId, categoryId, monthlyBudgetCents);

  try {
    return await client.categoryMonth.create({
      data: { userId, categoryId, monthId, monthlyBudgetCents: resolvedBudget },
    });
  } catch (error) {
    if (hasPrismaErrorCode(error, 'P2002')) {
      // Lost a race to a concurrent create for the same (categoryId,
      // monthId) — fine here, "ensure active" is idempotent by design,
      // just return the winner instead of erroring.
      const winner = await client.categoryMonth.findFirst({ where: { categoryId, monthId } });
      if (winner) return winner;
    }
    // Belt-and-suspenders, not expected to actually trigger: once
    // assertMonthNotLockedOnClient above passes, this transaction holds
    // the row lock on budget_months for its own remaining lifetime, so a
    // concurrent deleteBudgetMonth can't win the row and delete out from
    // under this insert. Kept anyway, matching this file's established
    // pre-check-plus-FK-catch pattern elsewhere, in case that ordering
    // ever changes.
    if (hasPrismaErrorCode(error, 'P2003')) {
      throw new CategoryMonthServiceError('budget_month_not_found');
    }
    throw error;
  }
}

export function createCategoryMonthService({
  prisma,
  budgetMonthService,
  now = () => new Date(),
}: CategoryMonthServiceDeps) {
  async function findOwnedCategoryMonth(userId: string, categoryMonthId: string) {
    const categoryMonth = await prisma.categoryMonth.findUnique({ where: { id: categoryMonthId } });
    if (!categoryMonth || categoryMonth.userId !== userId) {
      throw new CategoryMonthServiceError('category_month_not_found');
    }
    return categoryMonth;
  }

  async function listByMonth(userId: string, month: string) {
    assertValidMonth(month);

    const monthId = await budgetMonthService.findBudgetMonthId(userId, month);
    if (!monthId) return [];
    return prisma.categoryMonth.findMany({ where: { userId, monthId } });
  }

  /** Batch lookup for DataLoader use — trusts the caller to have already scoped the ids to one user. */
  async function findManyByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return prisma.categoryMonth.findMany({ where: { id: { in: ids } } });
  }

  async function addCategoryToMonth(
    userId: string,
    categoryId: string,
    month: string,
    monthlyBudgetCents?: number,
  ) {
    // Deliberately duplicated with the check inside resolveBudgetForActivation
    // below: this one is a cheap fail-fast before resolveBudgetMonthId's
    // permanent upsert (see the comment on assertOwnedCategory right
    // after), the one inside also has to cover ensureActiveForCategoryOnClient's
    // callers, which don't have this outer check at all.
    if (monthlyBudgetCents !== undefined) assertValidBudget(monthlyBudgetCents);
    assertValidMonth(month);

    // Checked before resolveBudgetMonthId deliberately: that call upserts a
    // permanent BudgetMonth row with no delete path, so a bad categoryId
    // must fail before it, not after — otherwise every failed attempt
    // leaves a corrupt-but-permanent row behind.
    await assertOwnedCategory(prisma, userId, categoryId);

    // Captured before resolveBudgetMonthId's upsert below — see
    // assertWithinPlanningHorizon's doc comment for why the ordering
    // matters (a rejected month must never leave a row behind, and for a
    // rejected *past* month specifically, that row would go on to corrupt
    // "current" itself for every later call). Checked immediately, before
    // resolveBudgetMonthId runs at all — unlike the month-locked check
    // below, this one can't be "re-checked inside the transaction, right
    // before the insert" without reopening the exact bug it exists to
    // prevent, so this is the only check of it there is. The TOCTOU gap
    // between this read and the transaction below is left open
    // deliberately, not just tolerated: "current" only ever advances by
    // lockMonth or deleteBudgetMonth removing the current (empty, unlocked)
    // row (both elsewhere, in budgetMonthService), so a race ordinarily
    // just makes this check slightly more permissive by execution time, not
    // less — never less permissive, and never by more than one month.
    // pr-reviewer flagged a theoretical "milder echo" of the original
    // hijack: could either of those ever jump "current" by *more* than one
    // month (e.g. current=2026-08, 2026-09 never provisioned, 2026-10
    // pre-provisioned and unlocked), making a stale `current` captured here
    // more than one month behind reality? Worked out with the user and
    // proven by the regression tests below ("lockMonth/deleteBudgetMonth
    // cannot skip more than one month"): it can't happen. This horizon
    // check's own lower bound (month >= current) means any BudgetMonth row
    // that exists anywhere is always within one month of whatever "current"
    // was at the moment it was created — by induction, that invariant holds
    // no matter how many creates/deletes/locks happen, since "current" is
    // never cached, only ever derived live from whichever rows currently
    // exist. So a row at current+2 can only exist once current has already
    // reached current+1, i.e. once the month that would otherwise jump
    // current there is already locked or gone — never while it's still
    // pending. The TOCTOU gap is therefore bounded to at most one month of
    // staleness, same as the ordinary case.
    const current = await findCurrentMonthOnClient(prisma, userId, now);
    assertWithinPlanningHorizon(current.month, month);

    const monthId = await budgetMonthService.resolveBudgetMonthId(userId, month);

    try {
      // Re-checked inside the transaction, against the transactional
      // client, right before the insert: narrows (does not fully close,
      // since this is a plain read with no row lock under Postgres's
      // default READ COMMITTED isolation) the window where a concurrent
      // delete of this same category could otherwise land between the
      // check above and the write, leaving a category_month row that
      // references an already-soft-deleted category. The month-locked
      // check, by contrast, *is* fully closed — assertMonthNotLockedOnClient
      // takes lockBudgetMonthRow first, so this serializes against a
      // concurrent lockMonth rather than racing it.
      return await prisma.$transaction(async (tx) => {
        await assertOwnedCategory(tx, userId, categoryId);
        await assertMonthNotLockedOnClient(tx, monthId);
        const resolvedBudget = await resolveBudgetForActivation(tx, userId, categoryId, monthlyBudgetCents);

        return tx.categoryMonth.create({
          data: { userId, categoryId, monthId, monthlyBudgetCents: resolvedBudget },
        });
      });
    } catch (error) {
      if (error instanceof CategoryServiceError || error instanceof CategoryMonthServiceError) {
        throw error;
      }
      if (hasPrismaErrorCode(error, 'P2002')) {
        throw new CategoryMonthServiceError('category_month_already_active');
      }
      // Belt-and-suspenders, same reasoning as ensureActiveForCategoryOnClient's
      // identical catch — not expected to actually trigger once
      // assertMonthNotLockedOnClient holds the row lock for the rest of
      // this transaction.
      if (hasPrismaErrorCode(error, 'P2003')) {
        throw new CategoryMonthServiceError('budget_month_not_found');
      }
      throw error;
    }
  }

  /**
   * Idempotent, unlike addCategoryToMonth: returns the existing category_month
   * if the category is already active that month, only creates one (and only
   * then requires an explicit budget — never derived from anything) if it
   * isn't. For callers (recurring expenses) where "already active" is a
   * success case, not an error — see PLAN.md's step 4 design notes.
   */
  async function ensureActiveForCategory(
    userId: string,
    categoryId: string,
    month: string,
    monthlyBudgetCents?: number,
  ) {
    return prisma.$transaction((tx) =>
      ensureActiveForCategoryOnClient(tx, userId, categoryId, month, monthlyBudgetCents, now),
    );
  }

  async function removeCategoryFromMonth(userId: string, categoryMonthId: string): Promise<void> {
    const categoryMonth = await findOwnedCategoryMonth(userId, categoryMonthId);

    try {
      await prisma.$transaction(async (tx) => {
        await assertMonthNotLockedOnClient(tx, categoryMonth.monthId);

        const referencingTransaction = await tx.transaction.findFirst({
          where: { categoryMonthId },
        });
        if (referencingTransaction) {
          throw new CategoryMonthServiceError('category_month_has_transactions');
        }

        await tx.categoryMonth.delete({ where: { id: categoryMonthId } });
      });
    } catch (error) {
      if (error instanceof CategoryMonthServiceError) {
        throw error;
      }
      // A transaction can be created concurrently, after the check above
      // but before this delete lands — the onDelete: Restrict FK catches
      // it at the DB level. Map that to the same typed error the check
      // above would have thrown, rather than letting a raw Prisma error
      // through (which toGraphQLError doesn't know how to give a clean
      // extensions.code for).
      if (hasPrismaErrorCode(error, 'P2003')) {
        throw new CategoryMonthServiceError('category_month_has_transactions');
      }
      throw error;
    }
  }

  async function updateCategoryMonthBudget(
    userId: string,
    categoryMonthId: string,
    monthlyBudgetCents: number,
  ) {
    assertValidBudget(monthlyBudgetCents);

    const categoryMonth = await findOwnedCategoryMonth(userId, categoryMonthId);

    return prisma.$transaction(async (tx) => {
      await assertMonthNotLockedOnClient(tx, categoryMonth.monthId);

      return tx.categoryMonth.update({
        where: { id: categoryMonthId },
        data: { monthlyBudgetCents },
      });
    });
  }

  return {
    listByMonth,
    findManyByIds,
    addCategoryToMonth,
    ensureActiveForCategory,
    removeCategoryFromMonth,
    updateCategoryMonthBudget,
  };
}

export type CategoryMonthService = ReturnType<typeof createCategoryMonthService>;
