import type { BudgetMonthService } from '../budgetMonths/budgetMonthService.js';
import {
  findCurrentMonthOnClient,
  lockBudgetMonthRow,
  resolveBudgetMonthIdWithCreatedFlag,
} from '../budgetMonths/budgetMonthService.js';
import { assertOwnedCategory, CategoryServiceError } from './categoryService.js';
import { addMonths, isValidMonthFormat } from '../../lib/monthFormat.js';
import type { PrismaClient } from '../../lib/prisma.js';
import { hasPrismaErrorCode } from '../../lib/prismaErrors.js';
import { withSavepoint } from '../../lib/prismaSavepoint.js';

export type CategoryMonthServiceErrorReason =
  | 'category_month_not_found'
  | 'category_month_already_active'
  | 'category_month_has_transactions'
  | 'category_month_has_recurring_expenses'
  | 'category_has_active_months'
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
    'category' | 'categoryMonth' | 'transaction' | 'budgetMonth' | 'recurringExpense' | '$transaction' | '$queryRaw'
  >;
  budgetMonthService: Pick<BudgetMonthService, 'findBudgetMonthId'>;
  now?: () => Date;
  /**
   * Called once, only when addCategoryToMonth is the action that causes a
   * brand-new BudgetMonth row to be created (never on an already-existing
   * month) — seeds that new month's recurring expenses by copying the
   * previous month's, same trigger recurringExpenseService's own
   * createRecurringExpense uses. Optional, plain function injection (not a
   * full service dependency) specifically so categoryMonthService never
   * has to import recurringExpenseService directly — that service already
   * depends on this one (via ensureActiveForCategoryOnClient), and a
   * two-way file dependency between them would break the one-directional
   * layering every other service in this codebase maintains. Wired in
   * server.ts. Runs its own transaction — see recurringExpenseService's
   * seedNewMonth for why this isn't threaded through the caller's.
   */
  onNewBudgetMonth?: (userId: string, month: string, monthId: string) => Promise<void>;
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
 * (docs/PLAN.md's "Month Lifecycle" section; the future-only cap is the phase-1
 * rule, further-ahead planning is a candidate paid-tier feature). Blocking
 * the past isn't just a symmetry nicety: "current" is derived elsewhere
 * (findCurrentMonthOnClient) as the *earliest unlocked* BudgetMonth row, so
 * if a past month were ever allowed to be newly created here, that
 * freshly-created (always unlocked) row would itself become the new
 * "earliest unlocked" — silently dragging "current" itself backwards for
 * every future call this user makes. Exported standalone so
 * recurringExpenseService's auto-activation path (which shares
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
 * recurringExpenseService's locked-creation flow) can run this as part of
 * that same transaction. No nested transaction here (Prisma doesn't support
 * nesting $transaction calls) — the bound service method below supplies one
 * for regular (non-nested) callers.
 *
 * Returns `monthWasCreated` alongside the categoryMonth row — true only when
 * *this call* is the one that created the BudgetMonth row (never on an
 * already-existing month, and never on the "already active" idempotent
 * return below). recurringExpenseService uses this to decide whether to
 * seed the new month's recurring expenses from the previous one.
 */
export async function ensureActiveForCategoryOnClient(
  client: Pick<PrismaClient, 'category' | 'categoryMonth' | 'budgetMonth' | '$queryRaw' | '$executeRawUnsafe'>,
  userId: string,
  categoryId: string,
  month: string,
  monthlyBudgetCents?: number,
  now: () => Date = () => new Date(),
) {
  assertValidMonth(month);
  await assertOwnedCategory(client, userId, categoryId);

  // Captured before resolveBudgetMonthIdWithCreatedFlag's create below — see
  // assertWithinPlanningHorizon's doc comment for why the ordering matters.
  const current = await findCurrentMonthOnClient(client, userId, now);

  // Read-only — unlike resolveBudgetMonthIdWithCreatedFlag below, never
  // creates a row. Only used to decide whether this call is idempotent
  // (category already active this month, the one case the horizon check
  // doesn't apply to); the row-creating call must not run at all until
  // that's resolved, so a rejected month can't leave a row behind
  // regardless of how this call would otherwise have turned out.
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

  const { id: monthId, wasCreated: monthWasCreated } = await resolveBudgetMonthIdWithCreatedFlag(
    client,
    userId,
    month,
  );
  await assertMonthNotLockedOnClient(client, monthId);

  if (alreadyActive) return { categoryMonth: alreadyActive, monthWasCreated: false };

  const resolvedBudget = await resolveBudgetForActivation(client, userId, categoryId, monthlyBudgetCents);

  // Under withSavepoint, not a plain try/catch — a caught conflict here
  // still needs a follow-up read (the winner lookup below) inside this same
  // transaction, and Postgres aborts the rest of a transaction after any
  // failed statement unless it's wrapped in a SAVEPOINT. Confirmed by a
  // real-Postgres repro, not just theoretical — see withSavepoint's doc
  // comment.
  const attempt = await withSavepoint(client, 'category_month_create', () =>
    client.categoryMonth.create({
      data: { userId, categoryId, monthId, monthlyBudgetCents: resolvedBudget },
    }),
  );
  if (attempt.ok) {
    return { categoryMonth: attempt.value, monthWasCreated };
  }
  if (hasPrismaErrorCode(attempt.error, 'P2002')) {
    // Lost a race to a concurrent create for the same (categoryId,
    // monthId) — fine here, "ensure active" is idempotent by design, just
    // return the winner instead of erroring.
    const winner = await client.categoryMonth.findFirst({ where: { categoryId, monthId } });
    if (winner) return { categoryMonth: winner, monthWasCreated };
  }
  // Belt-and-suspenders, not expected to actually trigger: once
  // assertMonthNotLockedOnClient above passes, this transaction holds the
  // row lock on budget_months for its own remaining lifetime, so a
  // concurrent deleteBudgetMonth can't win the row and delete out from
  // under this insert. Kept anyway, matching this file's established
  // pre-check-plus-FK-catch pattern elsewhere, in case that ordering ever
  // changes.
  if (hasPrismaErrorCode(attempt.error, 'P2003')) {
    throw new CategoryMonthServiceError('budget_month_not_found');
  }
  throw attempt.error;
}

export function createCategoryMonthService({
  prisma,
  budgetMonthService,
  now = () => new Date(),
  onNewBudgetMonth,
}: CategoryMonthServiceDeps) {
  async function findOwnedCategoryMonth(userId: string, categoryMonthId: string) {
    const categoryMonth = await prisma.categoryMonth.findUnique({ where: { id: categoryMonthId } });
    if (!categoryMonth || categoryMonth.userId !== userId) {
      throw new CategoryMonthServiceError('category_month_not_found');
    }
    return categoryMonth;
  }

  /**
   * direction, when given, filters to categoryMonths whose own Category has
   * that direction — resolved via a second, small `category.findMany`
   * rather than a relation filter pushed into the categoryMonth query
   * itself, since the result set here is bounded the same way a month's
   * transactions are. Scoped by `userId` even though every categoryId on a
   * categoryMonth row is already guaranteed to belong to this user
   * (ensureActiveForCategoryOnClient calls assertOwnedCategory before any
   * categoryMonth row is ever created) — defense-in-depth, same reasoning
   * as resolveBudgetForActivation's redundant userId filter above.
   */
  async function listByMonth(userId: string, month: string, direction?: 'expense' | 'income') {
    assertValidMonth(month);

    const monthId = await budgetMonthService.findBudgetMonthId(userId, month);
    if (!monthId) return [];
    const categoryMonths = await prisma.categoryMonth.findMany({ where: { userId, monthId } });
    if (!direction) return categoryMonths;

    const categories = await prisma.category.findMany({
      where: { userId, id: { in: categoryMonths.map((cm) => cm.categoryId) } },
    });
    const directionByCategoryId = new Map(categories.map((c) => [c.id, c.direction]));
    return categoryMonths.filter((cm) => directionByCategoryId.get(cm.categoryId) === direction);
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

    // Checked before resolveBudgetMonthIdWithCreatedFlag deliberately: that
    // call permanently creates a BudgetMonth row, so a bad categoryId must
    // fail before it, not after — otherwise every failed attempt leaves a
    // corrupt-but-permanent row behind.
    await assertOwnedCategory(prisma, userId, categoryId);

    // Captured before resolveBudgetMonthIdWithCreatedFlag's create below —
    // see assertWithinPlanningHorizon's doc comment for why the ordering
    // matters (a rejected month must never leave a row behind, and for a
    // rejected *past* month specifically, that row would go on to corrupt
    // "current" itself for every later call). Checked immediately, before
    // that call runs at all — unlike the month-locked check below, this one
    // can't be "re-checked inside the transaction, right before the insert"
    // without reopening the exact bug it exists to prevent, so this is the
    // only check of it there is. The TOCTOU gap between this read and the
    // transaction below is left open deliberately, not just tolerated:
    // "current" only ever advances by lockMonth or deleteBudgetMonth
    // removing the current (empty, unlocked) row (both elsewhere, in
    // budgetMonthService), so a race ordinarily just makes this check
    // slightly more permissive by execution time, not less — never less
    // permissive, and never by more than one month. pr-reviewer flagged a
    // theoretical "milder echo" of the original hijack: could either of
    // those ever jump "current" by *more* than one month (e.g.
    // current=2026-08, 2026-09 never provisioned, 2026-10 pre-provisioned
    // and unlocked), making a stale `current` captured here more than one
    // month behind reality? Worked out with the user and proven by the
    // regression tests below ("lockMonth/deleteBudgetMonth cannot skip more
    // than one month"): it can't happen. This horizon check's own lower
    // bound (month >= current) means any BudgetMonth row that exists
    // anywhere is always within one month of whatever "current" was at the
    // moment it was created — by induction, that invariant holds no matter
    // how many creates/deletes/locks happen, since "current" is never
    // cached, only ever derived live from whichever rows currently exist.
    // So a row at current+2 can only exist once current has already
    // reached current+1, i.e. once the month that would otherwise jump
    // current there is already locked or gone — never while it's still
    // pending. The TOCTOU gap is therefore bounded to at most one month of
    // staleness, same as the ordinary case.
    const current = await findCurrentMonthOnClient(prisma, userId, now);
    assertWithinPlanningHorizon(current.month, month);

    let created;
    let monthWasCreated = false;
    try {
      // resolveBudgetMonthIdWithCreatedFlag and the categoryMonth insert
      // must share one transaction, not two separate ones — pr-reviewer
      // caught that splitting them let a failure in the second (e.g.
      // category_month_budget_required) leave the just-created BudgetMonth
      // row committed from the first, permanently and silently losing the
      // carry-forward trigger for that month: a retry would then find the
      // row already exists and report wasCreated: false, even though this
      // was genuinely the first successful activity there. One transaction
      // means any failure — including the categoryId re-check and the
      // month-locked check below — rolls back the BudgetMonth creation
      // along with everything else, so there's never an orphaned row for a
      // rejected attempt to hide behind.
      created = await prisma.$transaction(async (tx) => {
        const { id: monthId, wasCreated } = await resolveBudgetMonthIdWithCreatedFlag(tx, userId, month);
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
        await assertOwnedCategory(tx, userId, categoryId);
        await assertMonthNotLockedOnClient(tx, monthId);
        const resolvedBudget = await resolveBudgetForActivation(tx, userId, categoryId, monthlyBudgetCents);

        const categoryMonth = await tx.categoryMonth.create({
          data: { userId, categoryId, monthId, monthlyBudgetCents: resolvedBudget },
        });
        monthWasCreated = wasCreated;
        return categoryMonth;
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

    // Fired after the transaction above has already committed, not inside
    // it — seeding owns its own atomicity boundary (see onNewBudgetMonth's
    // doc comment on CategoryMonthServiceDeps for why). Only when this call
    // is genuinely the one that created the month — never on an
    // already-existing one — and never allowed to fail the category-add the
    // user actually asked for: caught and swallowed, not rethrown, since
    // that already succeeded above and carry-forward seeding is best-effort
    // (pr-reviewer flagged the missing try/catch here — a transient error
    // inside seedNewMonth would otherwise report the whole mutation as
    // failed even though the category was in fact added).
    if (monthWasCreated && onNewBudgetMonth) {
      try {
        await onNewBudgetMonth(userId, month, created.monthId);
      } catch {
        // Best-effort — the category-add above already succeeded and is
        // what's returned; a missed carry-forward here just means the new
        // month's recurring expenses need adding manually.
      }
    }

    return created;
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

        // Folded in alongside the flat recurring_expenses rebuild (see
        // docs/PROGRESS.md): a recurring expense references its category
        // and month directly (no categoryMonthId FK — see the schema), so
        // "referenced by a recurring expense" means matching on both. Same
        // reasoning as the transaction check above — a category_month with
        // an active recurring expense against it can't be removed out from
        // under it.
        const referencingRecurringExpense = await tx.recurringExpense.findFirst({
          where: { categoryId: categoryMonth.categoryId, monthId: categoryMonth.monthId },
        });
        if (referencingRecurringExpense) {
          throw new CategoryMonthServiceError('category_month_has_recurring_expenses');
        }

        await tx.categoryMonth.delete({ where: { id: categoryMonthId } });

        // A Category is meant to be a reusable, dormant-when-inactive
        // catalog entry, but the mobile client never manages it directly —
        // the only user-facing way to remove one is from a month's budget
        // screen (see docs/PLAN.md). So if this was its last remaining
        // CategoryMonth anywhere, also delete the underlying Category here,
        // reusing categoryService.deleteCategory's own "any CategoryMonth
        // left, past or future" check — otherwise a fully dormant category
        // becomes permanent, invisible clutter with no UI that could ever
        // reach it again to clean it up.
        const stillActiveElsewhere = await tx.categoryMonth.findFirst({
          where: { categoryId: categoryMonth.categoryId },
        });
        if (!stillActiveElsewhere) {
          try {
            await tx.category.delete({ where: { id: categoryMonth.categoryId } });
          } catch (error) {
            // A concurrent addCategoryToMonth/createRecurringExpense can
            // reactivate this category between the check above and this
            // delete — the onDelete: Restrict FK catches it. Thrown here
            // (not left to the outer catch) so it isn't mislabeled as
            // category_month_has_transactions, which is about this month
            // specifically, not the category as a whole.
            if (hasPrismaErrorCode(error, 'P2003')) {
              throw new CategoryMonthServiceError('category_has_active_months');
            }
            throw error;
          }
        }
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
    removeCategoryFromMonth,
    updateCategoryMonthBudget,
  };
}

export type CategoryMonthService = ReturnType<typeof createCategoryMonthService>;
