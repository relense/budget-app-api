# Progress

Tracks status against `PLAN.md`'s Build Order. Updated as each step lands.

## Where we left off (2026-08-19)

PR #2 (auth/OTP) and PR #3 (`feature/categories-transactions`, Build Order
step 3) are both reviewed, approved, and merged into `develop`. After PR #3
merged, two repo-wide sweeps landed directly: `budgetType`'s three DB values
were translated from Portuguese (`preciso`/`quero`/`poupanca`) to English
(`need`/`want`/`savings`) across schema, code, and docs; and the migration
history was squashed from 6 migrations down to 1 (`20260818183149_init`) —
safe only because nothing had deployed yet and no real data existed.

Build Order step 4 (Recurring expenses) got its own extensive "grill me"
pass (see `PLAN.md`'s Data Model section for `recurring_expense_templates`/
`recurring_expense_instances`, and its "Recurring expenses vs. transactions",
"Recurring expenses are not categories", and "Category activation is
automatic for recurring expenses" prose sections) and is implemented —
service layer, GraphQL layer, real-Postgres smoke tests. PR #4
(`feature/recurring-expenses` → `develop`) is open, pushed, and has been
through two `pr-reviewer` rounds — round 1 found no blocking issues but
three suggestions, fixed; round 2 (verifying those fixes) found the
`createTemplateForMonth` fix had actually introduced a worse regression
(committed a real, budgeted `CategoryMonth` before validating the
template's own input) — fixed by validating first. Key decisions, in case
the reasoning is needed later:
- `recurring_expense_templates` + `recurring_expense_instances`: a
  recurring expense is its own identity, explicitly *not* a category, even
  though creating/adding one to a month auto-activates its (existing)
  category for that month — the one deliberate exception to categories'
  otherwise-always-manual activation rule.
- No derived default for the auto-created `category_month`'s budget —
  `categoryMonthlyBudgetCents` must be given explicitly when activation
  actually creates a new row.
- Recurring expenses allow **split payments**: `paidThisMonth` is
  `SUM(linked transactions.amountCents) >= instance.amountCents`, not "any
  payment exists."
- `CategoryMonth.recurringCommittedCents` (computed, GraphQL-only) sums a
  category's active recurring expenses for the month, for a future mobile
  "match budget to recurring total" action — flagged under PLAN.md's
  "Notes for Claude Code" so it isn't lost before Phase 2.
- **Soft-delete + undo dropped for `categories` and
  `recurring_expense_templates`**, mid-review-cycle, on an explicit user
  call: either something can be deleted (nothing references it, ever) or
  it's permanently blocked by what references it — no third "soft-deleted
  but still around" state, for any entity built so far. Every entity that
  exists in the schema as of step 4 is now hard-deleted, no undo (see
  PLAN.md's "Soft delete + undo" paragraph). `recurring_expense_templates`
  dropped `deleted_at` this step (migration
  `20260819064613_recurring_expense_template_hard_delete`); `categories`'
  own `deleted_at` removal is **out of scope for this branch** — flagged as
  the next follow-up, its own branch/PR against `develop`, since `categories`
  is already-merged code from step 3.
- **Closing a real concurrency gap surfaced two review rounds in**:
  `updateRecurringExpenseTemplate`'s new categoryId-change guard raced
  against instance creation for the same template. A first attempt (lock
  the template row right before the instance insert) *looked* right but
  was empirically proven broken — a 40-trial real-Postgres concurrent test
  showed 100% inconsistent results, because the category-to-activate
  decision was read *before* the lock, not inside it. The actual fix
  required threading a transactional client through
  `budgetMonthService.resolveBudgetMonthId` and
  `categoryMonthService.ensureActiveForCategory` (both gained a standalone,
  client-parameterized variant, same pattern as `assertOwnedCategory`), so
  the whole "lock → re-read category → activate → insert" sequence runs in
  one real transaction. Re-verified with the same real-Postgres test: 150
  trials, 0 inconsistent. `recurringExpenseInstanceService` no longer
  depends on `categoryMonthService`/`templateService` at all as a result —
  it does its own locked reads/writes now. The in-memory fake Prisma also
  gained real rollback-on-throw simulation for `$transaction`, since
  production code now genuinely depends on that semantics, not just on
  which calls get made.
- **A recurring expense template's category must be `expense`-direction**
  (surfaced by round 4's review, confirmed with the user): nothing
  previously stopped pointing a template at an income category (e.g.
  Salary) — `markRecurringPaid` derives the resulting transaction's
  `direction` from the category, so that would have let a "recurring
  expense" payment land as income. New `invalid_category_direction` error
  reason, enforced in `assertValidTemplateInput`.

PR #4 went through four `pr-reviewer` rounds total: round 1 (3 suggestions,
fixed), round 2 (1 blocking regression + the hard-delete/soft-delete
decision + the concurrency fix above), round 3 (1 blocking fix — a
concurrent-delete race in `updateTemplate`'s locked transaction leaking a
raw Prisma error instead of the typed `template_not_found` — plus
hardening: deep-clone the fake's rollback snapshot, a lock-ordering canary
test), round 4 (**approved**, 2 suggestions — the direction check above and
a stale schema comment — both fixed).

Also added `SERVICES.md`: a living reference listing every service's
functions and the full API surface (GraphQL schema + REST routes), kept
current alongside `PLAN.md`/`GLOSSARY.md` — not a design-rationale doc, a
quick "what exists right now" lookup.

Ran the new `test-auditor` subagent against the branch: all tests passed,
but the GraphQL resolver/context/loader layer wiring `userId` from auth into
every recurring-expense mutation had zero coverage beyond `Query.ping`, plus
a handful of service-layer gaps (`findManyByIds`, cross-user list isolation,
non-integer `amountCents`) that sibling services already covered. Closed all
of it: `schema.recurringExpenses.test.ts` (23 tests — one success + one
`UNAUTHENTICATED` case per recurring-expense query/mutation, plus service-error→`extensions.code`
mapping checks), `errors.test.ts`, `loaders.test.ts`, `context.test.ts`, and
targeted additions to the two recurring-expense service test files. 256 Jest
tests total (was 203).

Since round 4's approval, the src→tests move landed and both the
`pr-reviewer` and `test-auditor` subagents were re-run against the two new
commits (in that order, per the user). `pr-reviewer`: approved, no blocking
issues (two FYI-only nitpicks — a commit-message precision detail and a
note that `findManyByIds`'s lack of a `userId` filter is pre-existing,
already-approved design, not something these commits introduced).
`test-auditor`: found the resolver-level tests added above stub
`loaders: {} as never` and only select scalar fields, so the loader-wiring
field resolvers themselves (`RecurringExpenseTemplate.category`,
`RecurringExpenseInstance.month`/`template`/`transactions`/`paidThisMonth`,
`Transaction.recurringExpenseInstance`/`categoryMonth`) stayed at 0%
coverage — exactly the class of bug ("swap one loader for another") the
first audit round was meant to catch, just one level deeper. Also flagged
the `transactionsByRecurringExpenseInstanceId` loader (untested) and two
mutations (`deleteRecurringExpenseTemplate`, `removeRecurringExpenseFromMonth`)
missing the error-mapping test every sibling mutation has. Fixed all three:
`schema.recurringExpenses.nestedFields.test.ts` builds a context with real
`createGraphQLLoaders` (backed by stubbed services) and selects the nested
fields, so a loader mix-up would actually fail a test now; added the missing
loader and error-mapping cases. 264 Jest tests total (was 256). The
auditor separately flagged that `categories`/`categoryMonths`/`transactions`
and their CRUD mutations still have zero GraphQL-layer tests
(`tests/graphql/schema.test.ts` only checks `Query.ping`) — pre-existing,
predates this PR, left as backlog rather than expanding this PR's scope.

PR #4 is **merged into `develop`.**

`fix/categories-hard-delete` (branched off the now-updated `develop`):
`categories`' long-flagged soft→hard delete follow-up (see round-2's
decision above). Dropped `Category.deletedAt` (migration
`20260819084400_category_hard_delete`); `categoryService.deleteCategory`
now hard-deletes via `prisma.category.delete`, same pattern as
`recurringExpenseTemplateService.deleteTemplate`: pre-check
`category_month` references (unchanged precondition, per `PLAN.md`), then
catch the `P2003` FK-restrict backstop. That backstop turned out to matter
for a second, non-obvious reason beyond the usual check-then-delete race:
`RecurringExpenseTemplate.category` is *also* `onDelete: Restrict`, and a
template can outlive every `category_month` that ever activated its
category (instance removed, then the `category_month` removed too, template
left behind) — so a category can have zero `category_month` rows and still
be undeletable. The pre-check alone can't see that; only the FK catch does.
Verified against real Postgres with a throwaway smoke script (removed after):
plain delete, `category_month`-blocked delete, and this
template-without-a-`category_month` case, all three behaving as expected.
266 Jest tests total (was 264, +2 for this branch: the FK-race canary and
the template-only-reference case).

PR #5 (`fix/categories-hard-delete`) is **merged into `develop`.**

Started the "grill me" interview for step 5 (Month lifecycle) on a fresh
`feature/month-lifecycle` branch; the first question (what creates a user's
first `budget_months` row) surfaced a real, separate product decision the
user wanted instead: **every new signup gets a default starter category
catalog** (Supermarket, Eating Out, Gas/Transport, Health, Hobbies —
catalog only, not auto-activated into any month, budgets stay
user-entered), not just the existing personal seed script. Deliberately
out of Month Lifecycle's scope (it's a signup-flow change, not
locking/carry-forward) — the `feature/month-lifecycle` branch was dropped
(no commits yet) and rebuilt as `feature/default-categories` to do this
first, on its own.

`defaultCategories.ts` holds the fixed list. `authService.verifyOtp`
previously used `user.upsert`, which can't distinguish a genuine first-time
signup from a returning login (both hit the same code path) — needed that
distinction to know when to seed. Replaced with an explicit
create-then-catch-`P2002`-then-`findUnique` pattern. **Caught by the
real-Postgres smoke test, not the fake-Prisma suite**: the first version
nested that recovery `findUnique` inside the same `$transaction` as the
failed `create` — Postgres poisons an entire transaction after any failed
statement (`25P02`) until it's rolled back, so the recovery read failed
too. Fixed by running the create-or-find as standalone statements *before*
opening the transaction that seeds categories + creates the refresh token.
Verified against real Postgres: first signup seeds exactly 5 categories, a
second login doesn't reseed, and two concurrent `verifyOtp` calls for the
same brand-new email still result in one user row and exactly one seeding
pass. 268 Jest tests total (was 266).

`pr-reviewer` on PR #6: **approved**, two suggestions (not blocking).
(1) The first version's code comment framed the standalone-create tradeoff
as a narrow "process crash" window, but the reviewer pointed out it's
broader than that — *any* `$transaction` failure after the user row
commits (DB blip, deadlock, a future bug in the `createMany` call) would
permanently and silently skip seeding for that email on every retry, with
no signal. Fixed properly rather than just correcting the comment: added a
self-healing check — a genuinely returning user always has at least one
`refreshToken` row (even if since revoked, from a real prior login), so
"user exists but has zero refresh tokens ever" reliably means a previous
signup attempt died before its transaction committed (categories and the
refresh token are seeded in that same atomic transaction, so neither one
alone can partially exist). Re-seeds in that case instead of skipping
silently forever. Verified against real Postgres with a second throwaway
smoke script (removed after): a manually-inserted user row with no refresh
tokens gets seeded on next login; a genuine returning user (has a refresh
token + already deleted the extras down to one custom category) does not.
(2) Seeding bypassed `categoryService`'s validation entirely (calls
`tx.category.createMany` directly), so a future rule change there
wouldn't be caught. Exported `assertValidBudgetType` standalone from
`categoryService.ts` (same pattern as `assertOwnedCategory`) and added a
pinning test asserting every `DEFAULT_CATEGORIES` entry passes it — a
rule change now fails the test suite instead of shipping silently-invalid
seed data. Also took the reviewer's nitpick: `hasPrismaErrorCode` was
duplicated in five services; extracted to `src/lib/prismaErrors.ts`.
274 Jest tests total (was 268). `test-auditor` re-run after: verdict
"tests trustworthy," no blocking findings — flagged one gap worth
recording rather than fixing: the concurrent-brand-new-signup race
(two simultaneous `verifyOtp` calls for the same never-before-seen
email) is only verified by the now-removed real-Postgres smoke script,
not by anything in the Jest suite. Deliberately not backfilled with a
fake-based test — `testFakePrisma.ts`'s `$transaction` is a synchronous
passthrough with no real isolation semantics, so a "concurrency" test
against it would be false confidence, the same class of gap that let the
`25P02` bug through in the first place. That race path stays real-DB-only
verified, not regression-tested in CI.

PR #6 (`feature/default-categories`) is **merged into `develop`.**

Resumed step 5's "grill me" interview on `feature/month-lifecycle`.
Confirmed: `budget_months`' first row created lazily (existing pattern);
auto-lock cascade's "empty month" = zero transactions only (activations
alone don't block it); planning horizon (current month + 1, never
further) enforced server-side, not just in the UI; carry-forward
auto-inherits the just-locked month's budget per category. One nuance
surfaced mid-interview that reshapes carry-forward: a user can pre-provision
next month at any time (not gated on locking current first) — adding a
category to a month it's already active in inherits that budget
automatically too, same rule as lock-time carry-forward, not a separate
mechanism. Locking's carry-forward only creates rows for what isn't
already there (so pre-provisioned categories aren't touched again) — shown
to the user as a checkbox list, everything pre-checked by default, uncheck
to opt out (not an opt-in picker).

Implemented the shared piece first (small, self-contained, used by both
manual activation and recurring-expense auto-activation):
`categoryMonthService`'s `addCategoryToMonth` and
`ensureActiveForCategoryOnClient`/`ensureActiveForCategory` all take an
optional `monthlyBudgetCents` now — inherits the category's most recently
created `category_month`'s budget when omitted, still requires one
explicitly the first time a category is ever activated anywhere (nothing
to inherit from). GraphQL: `addCategoryToMonth`'s `monthlyBudgetCents`
argument is now nullable (flagged up front — this is the interface change
CLAUDE.md's rule covers). Verified against real Postgres. 278 Jest tests
total (was 274).

`pr-reviewer` on PR #7: **needs changes (minor)**, caught a real bug. The
first version's doc comment justified sorting candidate `category_month`
rows by `createdAt` instead of real calendar month by claiming the
one-month planning horizon keeps them in chronological order — the
reviewer checked and **that horizon isn't actually enforced anywhere
server-side yet** (still an open item, see below), so a category_month
can be created for any month in any order today. `createdAt` and real
month order can diverge, silently inheriting the wrong budget. Fixed by
sorting by the actual linked `BudgetMonth.month` string instead (a second
`findMany` + a `Map`, not a Prisma `include` — cheap at this row count,
and keeps the fake-Prisma test double simple). Also: the reviewer noted
every inheritance test only ever set up *one* prior activation, so the
"most recent" selection logic itself was untested (a broken
first/last-element bug would have passed) — added a test per call site
that creates three prior activations **out of chronological insertion
order** and asserts the real-latest-month one wins. Two nitpicks also
taken: `resolveBudgetForActivation` now scopes its lookup by `userId` too
(defense-in-depth — both callers already check ownership first) instead
of trusting categoryId alone; and a comment now explains why
`assertValidBudget` is deliberately called twice in `addCategoryToMonth`
(fail-fast outer check, plus the inner one that also has to cover
`ensureActiveForCategoryOnClient`'s callers, which lack the outer one).
280 Jest tests total (was 278). Re-verified the corrected sort against
real Postgres with the same out-of-order scenario the new unit tests use.
Re-ran `pr-reviewer`: **approved**, one trivial nitpick (a stale
`SERVICES.md` line still saying "most recently created" after the fix
changed the rule to "most recent by real month") — fixed.

`test-auditor` on PR #7: **tests trustworthy**, two low-cost suggestions,
both taken. The multi-candidate test's fixture had the real-latest month
also be the first-inserted row, so it ruled out the actual bug that
shipped ("most recently created wins") but not a hypothetical "first
created wins" — reordered the fixture so the real-latest month is
inserted neither first nor last, ruling out both. Also added GraphQL
resolver-level tests for `addCategoryToMonth` (`tests/graphql/schema.categories.test.ts`,
new file) — this mutation had zero GraphQL-layer coverage before, and
this PR is exactly where its `monthlyBudgetCents` argument became
meaningfully different (required → optional), so it's a good time to
start closing that gap rather than a place to widen it further. 283 Jest
tests total (was 280).

PR #7 (`feature/month-lifecycle`, budget-inheritance increment) is
**merged into `develop`.**

Second increment, on a fresh `feature/month-locking` branch (the old
`feature/month-lifecycle` name was reused once already and deleted after
merging, so this one's under its own name). Before writing any of it,
resumed the interview on the three still-open questions and it reshaped
the design significantly — **the auto-lock cascade and automatic
next-month creation are both dropped entirely**, on an explicit user
call: locking was being overcomplicated for an edge case ("a user plans
ahead and doesn't touch it") that mostly won't happen. Revised model,
recorded in full in `PLAN.md`'s Month Lifecycle section (original design
kept alongside, not silently overwritten, since the reasoning matters):
- `lockMonth(month)` does exactly one thing — locks the current
  (earliest unlocked) month. No `carryForward` argument, no cascade walk,
  no automatically-created next month.
- New `deleteBudgetMonth(month)` — hard-deletes an empty, unlocked month
  a user pre-provisioned but decided not to use. Same "remove what
  references it first, then the empty shell becomes deletable" pattern
  `deleteCategory`/`deleteTemplate` already use, backed by the same
  `onDelete: Restrict` FKs `category_month`/`recurring_expense_instance`
  already have to `budget_months`.
- **Carry-forward needed no dedicated mutation at all** — it's just the
  client calling the already-existing `addCategoryToMonth`/
  `addRecurringExpenseToMonth` (omitting the budget to auto-inherit,
  from the increment above) once per item the user checks, using the
  already-existing `categoryMonths(month)`/`recurringExpenseInstances(month)`
  queries against the previous month to populate the checkbox list
  (pre-checked, uncheck to opt out). Same flow whether planning ahead
  proactively or starting the new current month right after locking —
  never an automatic side effect of locking itself, so it can't silently
  clobber a month the user already set up differently.
- New `Query.currentMonth: BudgetMonth!` and a `BudgetMonth` GraphQL type
  (`{ month, locked }`, deliberately no `id` — nothing else in the schema
  references a BudgetMonth by id, and a not-yet-persisted "current month"
  wouldn't have a real one anyway). "Current month" is derived, never
  persisted by the query itself: earliest unlocked row, or today's real
  calendar month if none exists.

Implementation: `budgetMonthService` gained `findCurrentMonth`,
`lockMonth`, `deleteBudgetMonth`, and a `BudgetMonthServiceError` class
(reasons: `budget_month_not_found`, `budget_month_already_locked`,
`budget_month_not_current`, `budget_month_locked`,
`budget_month_has_activations`, `invalid_month`). `lockMonth` rejects
locking anything other than the current month, to protect the "current
is always earliest unlocked" invariant every derivation relies on.
`findCurrentMonth` sorts unlocked rows by the real `month` string, not
`createdAt` or insertion order — deliberately, having just fixed the
identical bug class in PR #7. Test infrastructure: `budgetMonthService`'s
fake-Prisma delegate (shared across every service's test double via
`createFakeBudgetMonthDelegate`) gained `update`/`delete` with the same
FK-restrict simulation pattern as `categoryMonth`/`recurringExpenseTemplate`;
`budgetMonthService.test.ts` switched from its own minimal fake to the
fuller `categories/testFakePrisma.ts` one, since `deleteBudgetMonth` now
genuinely depends on `categoryMonth` — same "one shared fake per
composition graph" rule already established. New `formatMonth(date)`
helper in `lib/monthFormat.ts` (UTC, not local timezone). 311 Jest tests
total (was 283). Verified against real Postgres: derives current month
without creating a row, locks it, current month naturally falls back to
today's real date with no cascade needed, `deleteBudgetMonth` blocked
while referenced and succeeds once empty.

`pr-reviewer` on PR #8: **needs changes** — caught a real, significant
gap. Before this PR, `budget_months.locked` could never actually become
`true` (nothing set it), so every existing "is this month locked" check
across `categoryMonthService`/`transactionService`/
`recurringExpenseInstanceService` was a plain check-then-write with no
row lock — dead code paths that never needed to defend against a real
race. `lockMonth` is what activates it: as shipped, a `createTransaction`/
`addCategoryToMonth`/`addRecurringExpenseToMonth` call landing in the gap
between another request's `lockMonth` check-and-write could still insert
a row into what is (or becomes) a locked month — silently breaking the
"locked = immutable" guarantee the whole feature exists for. Asked the
user how to scope the fix (all-in-now vs. lockMonth-only-now-with-a-
tracked-follow-up, mirroring the categories soft-delete precedent) — went
with fixing it fully now.

Closed it with the same `SELECT ... FOR UPDATE` row-lock pattern already
established for `lockTemplateRow`: new `lockBudgetMonthRow` (standalone,
`budgetMonthService.ts`), taken before checking `locked` in every write
path that needs to respect it — `lockMonth`/`deleteBudgetMonth`
themselves, `categoryMonthService`'s `addCategoryToMonth`/
`ensureActiveForCategoryOnClient`/`removeCategoryFromMonth`/
`updateCategoryMonthBudget` (the last two didn't even run inside a
transaction before this — now do), `transactionService`'s `create`/
`update`/`deleteTransaction` (same — previously no transaction at all,
now wrapped, plus a new `loadCategoryMonthForWrite`/
`assertOwnedTransactionMonthNotLocked` client-parameterized rewrite), and
`recurringExpenseInstanceService`'s `updateInstance`/`removeFromMonth`.
`findCurrentMonth` also gained a client-parameterized
`findCurrentMonthOnClient` so `lockMonth` can re-derive "current" from
inside its own transaction, against the locked row, not the service's
separately-bound connection. Verified against real Postgres with a
30-trial-each concurrent race (`lockMonth` vs `addCategoryToMonth`,
`lockMonth` vs `createTransaction`, throwaway script removed after): 0
inconsistencies across both, and the second one genuinely exercised both
orderings (24/30 the write landed first, 6/30 the lock won and correctly
rejected the write) rather than one side trivially always winning.

Also addressed from the same review round: the `deleteBudgetMonth`
in-code comment overstated what the `category_month` pre-check alone
guarantees — traced it and confirmed `recurring_expense_instance` has
its own direct FK to `budget_months` (not through `category_month`), and
`removeCategoryFromMonth` doesn't check for a referencing instance before
deleting a `category_month` row, so a month can end up with an instance
but zero `category_month` rows. The pre-check can't see that; only the
`P2003` catch does. Corrected the comment and added the regression test
this gap was missing (instance-with-no-category_month still blocks
deletion). Noted but not changed: `removeCategoryFromMonth` not checking
for a referencing `recurring_expense_instance` is itself a small
pre-existing gap, functionally harmless (the FK backstop on
`deleteBudgetMonth` covers it), worth a follow-up note rather than a fix
right now. `BudgetMonth`'s lack of an `id` field (deliberate, see above)
means a normalized GraphQL client can't auto-merge cache updates after
`lockMonth`/`deleteBudgetMonth` — flagged for whoever picks up the
frontend, not a backend concern. 312 Jest tests total (was 311).

`pr-reviewer` round 2 on PR #8: **needs changes** again — the core race
(write vs. `lockMonth`) traced as correctly closed by hand, but this pass
surfaced two more, narrower issues in the same class:
1. **Deadlock risk, new to this round**: `transactionService.update`
   can lock two *different* `budget_months` rows in one transaction when
   `categoryMonthId` moves to a different month — the existing month's
   row, then the target month's row, always in that "old, new" order.
   Two concurrent `update` calls swapping a transaction between the same
   two months in opposite directions would lock them in opposite orders
   and deadlock (Postgres aborts one with `40P01`). Zero test coverage
   existed for `update` actually moving a transaction across months at
   all. Fixed: pre-lock every distinct `budget_months` row a given
   `update` call touches, in canonical (sorted) order, before running the
   existing checks (which harmlessly re-lock rows already held by the
   same transaction). Added the missing cross-month tests. Verified
   against real Postgres: 20 trials of two transactions swapped in
   opposite directions concurrently, 0 deadlocks.
2. **Uncaught raw error, narrower than it looks**: `addCategoryToMonth`/
   `ensureActiveForCategoryOnClient` are the *only* two paths that create
   the first-ever `category_month` for a month (every other path
   operates on a month a `category_month`/`recurring_expense_instance`
   already references, which — thanks to `onDelete: Restrict` — makes
   deletion structurally impossible while they exist). For that one case,
   `assertMonthNotLockedOnClient`'s `budgetMonth?.locked` check silently
   treated "row was deleted" (null, so `?.locked` is `undefined`, falsy)
   the same as "not locked," letting the caller fall through into an
   uncaught FK violation on the insert if a concurrent `deleteBudgetMonth`
   won the race for that same (previously-empty) month. Fixed: explicit
   `!budgetMonth` branch throwing a new `budget_month_not_found` reason
   (added to `CategoryMonthServiceErrorReason`), plus a P2003 catch as a
   backstop (structurally unreachable once the explicit check holds the
   lock for the rest of the transaction, but matches this file's
   established pre-check-plus-FK-catch style elsewhere). Added the
   regression test. Verified against real Postgres: 20 trials of
   `addCategoryToMonth` racing `deleteBudgetMonth` for the same
   never-before-activated month — every rejection came back as a clean
   typed error, zero raw ones.

315 Jest tests total (was 312).

`pr-reviewer` round 3: **needs changes**, once more — found a real issue
introduced by round 2's own deadlock fix. `transactionService.update`'s
new pre-lock step looked up the *target* `categoryMonth` (from the
client-supplied `input.categoryMonthId`) and added its `monthId` to the
lock set with no ownership check — unlike every other lookup in this
file, which checks `userId` before touching a row. Practically: an
unowned/guessed `categoryMonthId` would still cause the server to take a
real row lock on another tenant's `budget_months` row, briefly
contending against their own concurrent writes to that month, before the
existing (unchanged) ownership check inside `loadCategoryMonthForWrite`
rejected the request moments later. No data leak, request still
correctly denied — but a genuine deviation from CLAUDE.md's
multi-tenancy rule, and the only place in the whole fix where a lock was
taken before ownership was verified. Fixed: gate adding the target
month to the lock set on `targetCategoryMonth.userId === userId`, so an
unowned id contributes nothing to the pre-lock step at all. Added the
missing cross-user regression test for `update`'s target `categoryMonthId`
(the `create` path already had the equivalent). Deterministic fix (not
timing-dependent — a simple "don't call the lock function if ownership
fails" gate), so verified with the functional test alone; no additional
real-Postgres concurrency run was needed for this one, unlike the
timing-dependent races earlier in this PR. 316 Jest tests total (was
315).

`pr-reviewer` round 4: **approved** — full end-to-end trace of the
round-3 fix (same-month, cross-month/owned-target, cross-month/unowned-target),
plus a fresh sweep of every `lockBudgetMonthRow`/`lockTemplateRow` call
site in the whole `src/` tree, found nothing else in this class. One
non-blocking nuance, not a bug: the round-3 regression test asserted only
the rejection reason, which `loadCategoryMonthForWrite`'s ownership check
would produce identically whether or not the fix existed — it didn't
actually prove "no lock taken on the other tenant's row," the substance
of what round 3 found. Strengthened it: spies on `$queryRaw` (what
`lockBudgetMonthRow` calls) and asserts the other user's `monthId` never
appears among the ids it was invoked with. Verified this by temporarily
reverting the round-3 fix locally and confirming the test fails exactly
as expected, then restoring it — genuine regression coverage now, not
just "still rejects." 316 Jest tests total, unchanged (one test replaced
with a stronger version of itself, not a net-new one).

Four review rounds on this PR, three of which found something real —
each fix narrower than the last (full multi-file locking gap → a
cross-month deadlock ordering issue → an ownership-check-after-lock gap
in that same fix → a test that didn't prove what it claimed). Worth
naming as a pattern for future concurrency-touching changes in this
codebase: get it reviewed again after *every* fix to a locking fix, not
just once at the end — each round's patch was exactly narrow enough to
introduce its own new edge case.

`test-auditor` after the four review rounds: no failures, four real gaps
found and fixed. (1) `recurringExpenseInstanceService.removeFromMonth`
had zero test coverage of its `month_locked` rejection — one of the two
paths this PR moved into a transaction with a real
`lockBudgetMonthRow`, untested despite the sibling `updateInstance` and
`markRecurringPaid` both having the equivalent test; added it. (2) The
new `budget_month_not_found` reason (on both `BudgetMonthServiceError`
and `CategoryMonthServiceError` — same string, two classes) was never
asserted through the GraphQL error-mapping boundary; added rows to
`errors.test.ts`'s `it.each` table and a `schema.budgetMonths.test.ts`
case for `lockMonth`. (3) `SERVICES.md` still said the month-locked
check on transactions was "inert until Build Order step 5 wires up the
mutation that actually locks a month" — this PR *is* that mutation;
corrected. (4) The most substantive one: round 2's canonical-lock-ordering
deadlock fix (`transactionService.update`'s `.sort()`) had no test
proving the ordering itself, only the end-to-end outcome — a regression
dropping `.sort()` would have passed every existing test. Added a
`$queryRaw`-spy test with **deterministically hand-picked ids** (not the
service's random UUIDs, which would only catch this by a coin flip
depending on how two random UUIDs happened to compare) proving the two
`budget_months` rows are locked in sorted order regardless of which is
"old" and which is "new". Verified by temporarily dropping `.sort()`
locally, confirming the test fails, then restoring it. Also verified the
same way for finding (1)'s reciprocal check the auditor did
independently on the round-3/4 ownership fix. 321 Jest tests total (was
316).

Noted, not implemented — a bigger scope call than a single-PR fix
warrants without asking first: the auditor pointed out every concurrency
guarantee in this PR (and, going back further, `lockTemplateRow`'s) is
verified once by a throwaway real-Postgres script and then deleted, so
none of it is re-checked by anything that runs in CI. This repo has no
integration-test infrastructure at all yet. Worth deciding deliberately
(new test category, Postgres-in-CI implications) rather than bolting on
unprompted — flagging for the user to weigh in on, not doing it silently.

Third increment, on `feature/planning-horizon` (branched off
`feature/month-locking`, not `develop` — depends on that PR's still-unmerged
`findCurrentMonthOnClient`): server-side enforcement of the one-month
planning horizon flagged as outstanding in PR #7 and PR #8's history above.
Added `addMonths(month, delta)` to `monthFormat.ts`. New
`assertWithinPlanningHorizon(currentMonth, month)` in `categoryMonthService`
— a pure sync comparison against an already-derived current month, throwing
the new `category_month_beyond_planning_horizon` reason. Wired into
`addCategoryToMonth` (unconditionally) and the shared
`ensureActiveForCategoryOnClient` (only when actually creating a new
activation — the existing "already active" idempotent-return path is
exempt, so a pre-provisioned month is never retroactively rejected), which
means `recurringExpenseInstanceService`'s auto-activation path inherits the
identical rule for free. `now` threaded through both services' deps for
testability, matching the existing `authService`/`budgetMonthService`
pattern.

Caught a real bug myself before any review: `assertWithinPlanningHorizon`
originally derived "current month" internally, on the same client, after
`resolveBudgetMonthId` had already run for the target month.
`resolveBudgetMonthId` upserts (permanently creates) a `BudgetMonth` row —
and a freshly created row is always unlocked, so it would itself become the
"earliest unlocked" row `findCurrentMonthOnClient` picks up whenever no
other unlocked month exists yet, making current == the very month being
checked and the horizon check self-satisfying for exactly the case (a
brand-new activation, no prior unlocked months) it most needed to catch.
First caught by a new test — `addCategoryToMonth('2026-10', ...)` against a
fresh user was expected to reject but silently succeeded. Fixed by
capturing `current` *before* `resolveBudgetMonthId` runs at both call sites
and turning `assertWithinPlanningHorizon` into a plain sync function taking
the already-derived value, rather than a client/`now`-taking async one that
could re-derive it at the wrong moment. The TOCTOU gap this leaves between
capturing `current` and the later insert is safe to leave open: current can
only advance (via an explicit `lockMonth`), never retreat, so a race can
only make the check *more* permissive by execution time than it was at the
capture point, never less — no invariant this check protects can be
violated by using a slightly stale value. This reasoning hasn't been
reviewer-scrutinized yet, unlike the near-identical claim in PR #8's
history, which is exactly why it's called out explicitly here rather than
assumed settled.

Also fixed a broader, previously-latent test-suite bug surfaced while
chasing the above: most of the existing test suite's hardcoded month
literals (`'2026-08'`, `'2026-09'`) only ever passed because the real
wall-clock date happened to fall inside that window when tests defaulted to
the real clock — not because anything pinned it. Left alone, the whole
suite would have started silently failing once real time passed September
2026, for reasons unrelated to any code change. Injected a fixed
`now = () => new Date('2026-08-15T00:00:00.000Z')` into
`categoryMonthService.test.ts`'s, `transactionService.test.ts`'s, and
`recurringExpenseInstanceService.test.ts`'s `setup()` functions (matching
`budgetMonthService.test.ts`'s existing pattern), even though only the
first was visibly failing — the other two were equally fragile, just not
caught yet. Two pre-existing "inherits by real calendar month, not
insertion order" tests (in `addCategoryToMonth` and `ensureActiveForCategory`)
had to be rewritten: their premise — activating one category across three
non-contiguous months via chained live service calls with no locking in
between — is no longer something a real user could produce once the
horizon is enforced. Rewrote both to push pre-locked historical
`BudgetMonth`/`CategoryMonth` fixture rows directly (bypassing the
service/horizon-check for setup, the same way a real month's history could
only ever be reached by locking each one in turn), keeping the actual
regression coverage (real-month sort order, not insertion order) intact.
Added new tests for the horizon rule itself: rejecting a brand-new
activation beyond current+1, allowing one exactly at current+1, allowing an
already-active far-future month through unchanged (idempotent-return
exemption), and one on the recurring-expense path proving the shared check
applies there too. 330 Jest tests total (was 329 before this increment's
net test additions; two rewritten, six added).

`pr-reviewer` round 1: **needs changes** — caught a real, deterministic bug
(not a race) in the future-only version of the check above: "current" is
the earliest *unlocked* `BudgetMonth` row, and nothing stopped a category
from being newly activated in an arbitrary untouched past month, which
would silently create a fresh (always-unlocked) row there — and that row
would then become the new "earliest unlocked" row, dragging "current"
itself backwards for every later call by that user. Reviewer's repro was
two sequential, non-concurrent calls: activate a category in `2020-01`,
then try to activate a different category in `2026-08` (the real current
month) — the second call was incorrectly rejected as "beyond the planning
horizon" because "current" had been hijacked to `2020-01` by the first
call. This also broke the "TOCTOU gap is safe because current only ever
advances" reasoning the design leaned on — it wasn't just unsafe under a
race, it was wrong in ordinary sequential use.

Brought the finding to the user rather than fixing unilaterally, since it
implied a product decision (should past-month activation be allowed at
all?), not just a code fix. User's call: never allow creating a new month
in the past — a user can revisit a past month if it already exists, but
can't newly activate a category in one that was never touched. Implemented
as a symmetric bound: `assertWithinPlanningHorizon` now rejects any newly
created activation outside `[current, current + 1]`, not just past
`current + 1`. Both call sites (`addCategoryToMonth`,
`ensureActiveForCategoryOnClient`) already captured `current` before
`resolveBudgetMonthId`'s upsert (from the ordering fix earlier in this same
increment) — extending that same ordering to the lower bound closes the
hijack: a rejected month, past or future, now never reaches
`resolveBudgetMonthId` at all, so it can never leave a stray row behind.
`ensureActiveForCategoryOnClient`'s idempotent-return path (a pre-existing
activation is always allowed regardless of the horizon) now determines
"already active" via a read-only `budgetMonth.findUnique` lookup instead of
via `resolveBudgetMonthId`'s upsert, so that path doesn't reopen the same
hole for its own case; the lock check still runs unconditionally right
before either the early return or the create, matching every other write
path in this file. Fixed the 5 tests that broke as a result (two
`month_locked` tests were relying on a *past* locked month, no longer
reachable — moved to a locked *current* month instead, still exercising the
lock check distinctly from the horizon check; three inheritance tests were
using a past month as live-call setup scaffolding — moved to using the
current month instead). Added regression coverage: rejecting a month before
current, and the reviewer's exact two-call hijack repro asserting the
second (legitimate, current-month) activation now succeeds. Also fixed
finding #2 from this same review round — the idempotent-return test's
fixture made "current" trivially equal to the far-future target month
itself (the only unlocked row), so it would have passed even with the
exemption deleted; added a distinct, earlier unlocked row so the test
actually pins "current" somewhere the horizon check would fail if it ran.
And finding #3: `resolveBudgetForActivation`'s docstring still said the
horizon "isn't enforced server-side yet" — corrected. 333 Jest tests total
(was 330).

`pr-reviewer` round 2: **approved**. Confirmed the hijack is closed at both
call sites (a rejected month, past or future, never reaches
`resolveBudgetMonthId`, so it can never leave a row behind), confirmed both
non-blocking round-1 findings were fixed, and confirmed the adjusted/new
tests actually exercise what they claim. One further non-blocking
observation, addressed by tightening a comment rather than the logic
itself (out of scope for this PR — it concerns `lockMonth`): the
TOCTOU-is-always-safe claim in `addCategoryToMonth`'s comment was
technically too strong. `lockMonth` can advance "current" by more than one
month in a single jump if a user has a non-contiguous gap of
pre-provisioned unlocked months (e.g. `2026-08` current, `2026-09` never
provisioned, `2026-10` already pre-provisioned unlocked — locking `2026-08`
jumps current straight to `2026-10`). A call racing in the middle of that
jump, having captured `current = 2026-08` just before it committed, could
in principle still let `2026-09` through even though a fully up-to-date
check would have rejected it — a milder, race-and-precondition-gated echo
of the original hijack. Comment corrected to state this precisely instead
of claiming an absolute guarantee; the underlying question (should
`lockMonth`'s current-advancement itself be bounded to rule this out?) is
left as a follow-up, tracked below. `npm run typecheck`, `npm test` (333
passing), `npm run lint`, `npm run build` all clean.

Discovered, while pushing this branch, that `feature/month-locking` (PR #8)
had already been merged into `develop` (along with `develop` → `main`, both
done by the human outside this session, between conversations) — this
session's local repo still had a stale cached remote-tracking ref from
before that happened. Confirmed via `git merge-base --is-ancestor` that the
merge was a regular (non-squash) merge, so `feature/planning-horizon`'s
history lined up cleanly against `develop` with no rebase needed — just
retargeted the PR's base from the (now-deleted) `feature/month-locking` to
`develop` directly. Opened as **PR #10** (`feature/planning-horizon` →
`develop`), open, both `pr-reviewer` rounds resolved (round 2 approved),
`test-auditor` deliberately skipped this round, awaiting human review.

PR #10 (`feature/planning-horizon`) and PR #11 (docs catch-up) both merged
into `develop`, human-reviewed, resolving next action 1 above.

Picked up next action 2 on a fresh `chore/lockmonth-jump-invariant` branch
(off up-to-date `develop`). Before writing any code, worked through the
mechanism by hand: for the feared scenario (current=2026-08, 2026-09 never
provisioned, 2026-10 pre-provisioned and unlocked — locking 2026-08 jumps
current straight to 2026-10, two months) to ever be *reached*, 2026-10 must
have been created while current was already 2026-09 or later — which
requires 2026-08 to already be locked or gone by then, contradicting the
scenario's premise that 2026-08 is still unlocked and about to be locked.
Since "current" is never cached (always derived live from whichever rows
exist) and the horizon's own lower bound (month >= current, added in PR
#10) means every row that's ever created is within one month of "current"
at creation time, this generalizes by induction: **any row that currently
exists is always within one month of current, no matter what
create/delete/lock sequence produced it** — so locking the current month
can never advance it by more than one month. Brought this reasoning back
to the user rather than just implementing a bound; confirmed the jump
itself (skipping straight to a later pre-provisioned month when the
in-between one was deliberately deleted) is intended behavior, not a bug
— the only open question was whether it could ever exceed one month, and
the answer is no.

Verified rather than just asserted: two new regression tests in
`categoryMonthService.test.ts` (`describe('lockMonth cannot skip more than
one month...')`) — one directly attempts pr-reviewer's construction
(pre-provision September, delete it, try to reach October while August is
still current — rejected as beyond the horizon, proving the precondition
itself is unreachable) and one traces a legitimate multi-lock sequence
confirming each jump lands exactly one month past whatever was just
locked, never further, even once a later month already exists. Both pass
against the real implementation, not just the reasoning. Corrected
`addCategoryToMonth`'s comment (previously left this as an open,
unproven caveat) to state the invariant and point at the tests. No logic
change — the existing code was already correct. 335 Jest tests total (was
333). `npm run typecheck`, `npm run lint` both clean. Opened as **PR #12**
(`chore/lockmonth-jump-invariant` → `develop`).

`pr-reviewer` on PR #12: **approved**, with a real, non-blocking gap in the
write-up rather than the code — the induction argument and both new tests
only walked through `lockMonth` as the mechanism that advances "current,"
but `deleteBudgetMonth` (removing the current, empty, unlocked row) is the
*other* way current advances, and hadn't been explicitly traced. Worked
through it: the same induction holds — a row two months out can only exist
once current has already reached one month out, regardless of whether that
advance happened via a lock or a delete of the (by-then-empty) current row
— but this hadn't been checked or written down anywhere. Broadened the
`addCategoryToMonth` comment to credit both mechanisms, renamed the test
`describe` block to `'lockMonth/deleteBudgetMonth cannot skip more than one
month'`, and replaced the weaker of the two tests (which the reviewer also
flagged as not actually proving anything test 1 didn't already cover) with
one that traces the same multi-step sequence through `deleteBudgetMonth`
instead of `lockMonth`. 336 Jest tests total (was 335).

`chore/lockmonth-jump-invariant` (PR #12) merged into `develop`.

**Recurring expenses redesign — decided, not yet built.** User pushback on
step 4's `recurring_expense_templates`/`recurring_expense_instances` split
("why do we need a template table at all — a month can just have an array
of recurring expenses"), worked through directly rather than defended by
default. The split was modeled on `categories`/`category_month`, but that
analogy doesn't hold: a category is designed to sit dormant in a catalog
with no month, which is exactly why it needs a transversal table separate
from its per-month activation — but `PLAN.md` itself already said a
recurring expense "has no equivalent dormant state — it only exists because
you're tracking paying something now." A thing that's never month-independent
doesn't need a table representing month-independent existence. The one thing
the shared `template_id` bought — grouping "every Rent payment across all
time" for future reporting — was weighed and explicitly rejected as not
worth a schema commitment now: recurring expenses are low-volume (max ~12
occurrences/year per bill; a 10-year history is ~120 rows, trivially
queryable by name/category directly if that's ever needed), unlike
categories, where transaction volume actually justifies a stable id.

Decided replacement, confirmed with the user: a single flat `recurring_expenses`
table, one row per recurring expense per month — `name`, `category_id`,
`budget_type`, `due_day`, `amount_cents`, `month_id`, all on that one row, no
template. `paidThisMonth`/split-payment logic via linked `Transaction`s is
unchanged. Editing a row only ever touches that one month — the old
"apply to future months too?" propagation question no longer exists.
Carrying forward into a new month is **automatic** (unlike category/budget
carry-forward, which stays the existing opt-in per-item flow): whenever a
new month comes into existence — pre-provisioned ahead of locking, or
derived as the new current after locking with nothing already provisioned
— its recurring expenses are copied straight from the previous real month,
fresh and unpaid, no checklist. No cross-month identity of any kind between
one month's row and the next's copy — confirmed explicitly, given the
volume reasoning above. Exact hook point for the auto-copy (tied to
`BudgetMonth` row creation itself vs. specifically `lockMonth`'s derivation
of the new current) is left for this step's build-time grill-me, not
decided yet. Full reasoning and the new schema/API shape are written up in
`PLAN.md`'s Data Model and API Schema sections (old template/instance design
kept alongside, marked superseded rather than deleted) and `GLOSSARY.md`'s
Recurring Expense entry. Not yet implemented — the currently-shipped code
(`recurringExpenseTemplateService`/`recurringExpenseInstanceService`, the
GraphQL `RecurringExpenseTemplate`/`RecurringExpenseInstance` types, all
their mutations) still reflects the old design; see `SERVICES.md` for what's
actually live until this gets built.

**Repo root cleanup.** User wanted the project-level `.md` files out of the
repo root. `GLOSSARY.md`, `PLAN.md`, `PROGRESS.md`, `SCALING.md`,
`SERVICES.md`, `FUNCTIONALITIES.md` moved into a new `docs/` folder.
`CLAUDE.md` moved to `.claude/CLAUDE.md` — confirmed via Claude Code's own
memory documentation that this is an equally-supported auto-discovery
location (not just root `./CLAUDE.md`), so it's still read automatically
every session. Every cross-reference across the docs, `.claude/CLAUDE.md`,
source comments (`src/lib/monthFormat.ts`,
`src/services/auth/defaultCategories.ts`,
`src/services/recurringExpenses/recurringExpenseInstanceService.ts`,
`src/services/categories/categoryMonthService.ts`,
`src/services/budgetMonths/budgetMonthService.ts`), a test comment, and
`prisma/schema.prisma` updated to `docs/`-prefixed paths (docs referencing
each other, as siblings within `docs/`, keep bare filenames).

Next actions, in order:
1. Design/build the recurring-expenses flat redesign: drop
   `recurring_expense_templates`, collapse `recurring_expense_instances`
   into a self-contained `recurring_expenses` table, rework
   `recurringExpenseTemplateService`/`recurringExpenseInstanceService` into
   one service, update the GraphQL schema (`RecurringExpense` type replacing
   both, `createRecurringExpense`/`updateRecurringExpense` replacing the
   template+instance mutation pairs), and decide the auto-copy-forward hook
   point (see above) as part of that step's kickoff interview. This
   supersedes "recurring-template edit propagation" from the prior version
   of this list — the propagation question no longer exists under the new
   design.
2. Small tracked follow-up, not blocking: `removeCategoryFromMonth`
   should check for a referencing `recurring_expenses` row, not just
   `transaction`, before deleting a `category_month` row (carries over
   unchanged from the old `recurring_expense_instance` wording).

## Phase 1 — Backend

- [x] **0. Ground truth** — `.claude/CLAUDE.md`, `docs/GLOSSARY.md`, `docs/PLAN.md`, `docs/SCALING.md` committed (originally flat at the repo root — moved into `.claude/`/`docs/` later, see "Where we left off").
- [x] **1. Project scaffold** — Fastify + TypeScript (ESM, pnpm), GraphQL Yoga
      mounted at `/graphql` with a trivial `Query.ping`, Prisma + Postgres via
      Docker Compose (`@prisma/adapter-pg`, required by Prisma 7's client
      generator), CORS + `@fastify/helmet`, Zod-validated env vars at startup,
      `GET /health` backed by a real DB check, graceful shutdown
      (`SIGTERM`/`SIGINT`) + crash handlers, ESLint + Prettier, Jest + ts-jest.
      Production hardening (masked errors, introspection disabled, query depth
      limit) wired in from the start rather than bolted on later.
      → PR #1 (`chore/backend-scaffold`).
- [x] **2. Auth (OTP)** — `User`/`OtpCode`/`RefreshToken` Prisma models (UUID
      ids, native Postgres `uuid` columns); `authService` (requestOtp,
      verifyOtp, refreshSession, logout, logoutAll) with argon2-hashed OTP
      codes, sha256-hashed refresh tokens, mandatory rotation on refresh;
      `POST /auth/{request-otp,verify-otp,refresh,logout,logout-all}`, the
      first rate-limited 3/15min by IP+email; JWT (jose, HS256, 15 min access
      / 30 day refresh) context builder attaches a nullable `userId` to
      GraphQL context. Email delivery via a console-log `EmailService` (real
      provider deferred, per PLAN.md). Manually smoke-tested end to end
      against real Postgres. → branch `feature/auth-otp`.
- [x] **3. Categories + Transactions** — `budget_months` (schema only, `locked`
      inert until step 5), `categories` (pure catalog), `category_month` (the
      real join — row existence = active, budget lives here, hard-deleted,
      `@@unique([categoryId, monthId])`, `onDelete: Restrict` everywhere as a
      DB-level backstop), `transactions` (FK to `category_month` not
      `category` — structurally enforces "must be active that month"; hard-
      deleted, `direction` server-derived). Four services (`budgetMonthService`,
      `categoryService`, `categoryMonthService`, `transactionService`),
      149 Jest tests including three that seed a `locked: true` row
      directly to prove the locked-month guard works before step 5 has any
      mutation that sets it, plus regression tests added across four
      review rounds (cross-tenant ownership, month-format validation,
      non-integer budget rejection, ownership-check-before-permanent-
      side-effect ordering, a simulated race on `removeCategoryFromMonth`).
      Full GraphQL schema/resolvers/DataLoaders
      (`category`/`categoryMonth`/`budgetMonth`/`transactionsByCategoryMonthId`),
      per-field `requireUserId` auth checks, service errors mapped to
      `GraphQLError` with a stable `extensions.code`. Manually smoke-tested
      end to end against real Postgres repeatedly across review rounds
      (full mutation/query lifecycle, duplicate-add rejection, blocked/
      then-allowed delete, unauthenticated rejection, cross-tenant
      rejection, malformed-month rejection). → PR #3
      (`feature/categories-transactions` → `develop`), reviewed
      (4 rounds) and merged.
- [x] **4. Recurring expenses** — `recurring_expense_templates` (**hard-deleted**,
      transversal catalog — revised mid-review from an initial soft-delete
      design, see "Where we left off" — budget_type restricted to
      `need`/`want`, `savings` rejected at runtime via `invalid_budget_type`)
      + `recurring_expense_instances` (hard-deleted, FK to `budget_months`,
      `@@unique([templateId, monthId])`). Two services:
      `recurringExpenseTemplateService` (create/update/delete — delete
      blocked while any instance exists anywhere, past or future, backed by
      a real `onDelete: Restrict` FK now that it's a hard delete;
      `updateTemplate` blocks a `categoryId` change once any instance exists,
      race-safe via `lockTemplateRow`'s `SELECT ... FOR UPDATE`) and
      `recurringExpenseInstanceService` (`createTemplateForMonth` — template
      create + category activation + instance create all in one real
      transaction, returns `{ template, instance }`; `addRecurringExpenseToMonth`
      reuses a template into a new month, locks the template row and
      re-reads its category *inside* that lock before activating — see
      "Where we left off" for why the lock has to cover that read, not just
      the final insert; `updateInstance`, `removeFromMonth` — blocked while
      any transaction references it; `markRecurringPaid` — always creates a
      *new* `Transaction` linked via `recurringExpenseInstanceId`, callable
      more than once per instance for split payments;
      `sumCommittedCentsForCategoryMonth` backs the new
      `CategoryMonth.recurringCommittedCents` computed field). No longer
      depends on `categoryMonthService`/`templateService` as injected
      services — does its own locked reads/writes via `ensureActiveForCategoryOnClient`
      and `resolveBudgetMonthId`, both new standalone client-parameterized
      functions (same pattern as `assertOwnedCategory`) exported from
      `categoryMonthService`/`budgetMonthService` respectively, so the whole
      activate-then-insert sequence can run inside one transaction instead
      of on separately-bound connections. `transactionService` gained an
      internal-only third `create` param (`recurringExpenseInstanceId`,
      never client-settable) and `listByRecurringExpenseInstanceIds` for
      DataLoader use. 203 Jest tests total (was 149 after step 3), the
      fake-Prisma double consolidated into one shared file per composition
      graph (a lesson carried over from a step-3 review finding) and
      extended to actually simulate transaction rollback-on-throw, since
      production code now depends on that. Full GraphQL schema/resolvers
      (`RecurringExpenseTemplate`/`RecurringExpenseInstance` types, their
      inputs, all seven mutations, both queries) and four new DataLoaders
      (`recurringExpenseTemplateById`, `recurringExpenseInstanceById`,
      `transactionsByRecurringExpenseInstanceId`,
      `recurringCommittedCentsByCategoryMonthId`). Manually smoke-tested end
      to end against real Postgres repeatedly across review rounds (full
      mutation/query lifecycle, split-payment `paidThisMonth` transition,
      `SAVINGS` budgetType rejection, duplicate-add rejection, cross-tenant
      rejection, blocked delete/remove while referenced, unauthenticated
      rejection, real hard-delete-once-unused), plus a dedicated 150-trial
      concurrent-request test against real Postgres proving the
      categoryId-change-vs-instance-creation race is actually closed, not
      just correct in the (non-concurrent) fake. Also validates a
      template's category is `expense`-direction (`invalid_category_direction`)
      — `markRecurringPaid` derives the resulting transaction's `direction`
      from the category, so an income category would otherwise silently
      produce an income transaction from a "recurring expense" payment. →
      PR #4 (`feature/recurring-expenses` → `develop`), merged.

      **Superseded, not yet rebuilt**: the template/instance split
      described above is being replaced by a flat `recurring_expenses`
      design (one row per month, no template) — see "Where we left off"
      above and `PLAN.md`'s Data Model section. Everything in this bullet
      is still what's actually live in `develop` today (per `SERVICES.md`)
      until that rework lands; keeping it as accurate history rather than
      rewriting it away.
- [ ] **5. Month lifecycle** — in progress, three increments merged so far:
      budget-inheritance on category/recurring-expense activation (PR #7,
      merged), `lockMonth`/`deleteBudgetMonth`/`Query.currentMonth` (PR #8,
      merged), server-side planning-horizon enforcement (PR #10, merged).
      Carry-forward turned out to need no
      dedicated mutation (reuses `addCategoryToMonth`/`addRecurringExpenseToMonth`'s
      existing budget-omit-to-inherit behavior) and auto-lock cascade was
      dropped entirely — both revised out of the original scope described
      here during the step's kickoff interview, see `PLAN.md`'s Month
      Lifecycle section for the actual design. Still outstanding: the
      recurring-expenses flat redesign (replaces the old "recurring-template
      edit propagation" item — that question no longer exists under the new
      design, see "Where we left off"), soft-delete + undo for the entities
      that still have it.
- [ ] **6. Savings funds + movements** — CRUD + `addSavingsMovement` updating
      `currentAmountCents`; DataLoader for `SavingsFund.movements`.
- [ ] **7. Income sources** — CRUD; `income_sources.month_id` already
      designed to reference `budget_months`, per step 3's month-modeling
      decision.
- [ ] **8. Seed script** — real categories/funds from the Excel tracker.
- [ ] **9. Basic tests** — auth boundary tests (user A can't read user B's
      data), one DataLoader batching check.

## Phase 2 — Mobile app

Not started. Needs design references (mockups + Excel structure) before any
screen work begins, per `PLAN.md`.

## Phase 3 — Website

Not started.

## Notable deviations / decisions from PLAN.md

- Prisma 7's client generator requires a driver adapter — added
  `@prisma/adapter-pg` (PLAN.md assumed the classic bare-`DATABASE_URL` setup).
- `prisma init` auto-vendors AI-agent skill docs into `.claude/`, `.windsurf/`,
  `.agents/` — removed, unrelated to the app.
- ID strategy for every table (not specified in PLAN.md): UUID v4, stored as
  native Postgres `uuid` columns (`@db.Uuid`), confirmed with the user during
  the auth step since it's a precedent-setting choice.
- OTP hashing: argon2 (not scrypt/sha256) — confirmed with the user; refresh
  tokens use sha256 since they're already high-entropy random secrets, not
  low-entropy codes.
- JWT library: `jose` (ESM-native) over `jsonwebtoken`/`@fastify/jwt`.
- Row cleanup for expired/used `otp_codes` and expired/revoked
  `refresh_tokens` is not implemented yet — PLAN.md flags this as "not urgent
  on day one, but don't let it be never." Still backlog.
- Tests moved out of `src/` into a top-level `tests/` mirroring `src/`'s
  subfolder structure (was co-located `*.test.ts` next to the code it
  tests) — user's explicit preference, to keep `src/` browsable as
  production code only. The three `testFakePrisma.ts` fixtures moved with
  their test files. `tsconfig.json` (rootDir `src`, used by `build`) is
  unchanged; a new `tsconfig.test.json` (rootDir `.`, includes both `src`
  and `tests`, `noEmit`) backs `typecheck`, `ts-jest`, and ESLint's
  type-aware linting instead.
- OTP codes are alphanumeric, not digits-only (GLOSSARY.md/PLAN.md originally
  said "6-digit" — updated to "6-character"): uppercase A-Z + digits 2-9,
  excluding ambiguous characters (0/O, 1/I/L), verified case-insensitively.
  Confirmed with the user; charset/case/length were all explicit choices,
  not defaults.
