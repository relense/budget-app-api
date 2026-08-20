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

**Recurring expenses flat redesign — built.** Picked up the decided design
from "Where we left off" above on a fresh `feature/recurring-expenses-flat-redesign`
branch (off up-to-date `develop`, after the docs PR merged). Grilled the
remaining open points before writing code: copy-forward-on-first-touch
budget inheritance (auto-activation is silent, inherits the category's most
recent budget — same rule `addCategoryToMonth` already uses when budget is
omitted, since there's no user interaction at that moment to prompt for
one); duplicate-name uniqueness scope (`@@unique([monthId, name])` — per
month, not global, confirmed explicitly: "Rent" can exist once in October
and once in November, just never twice in the same month); folded the small
tracked `removeCategoryFromMonth` follow-up into this same branch, as
planned.

Schema: dropped `recurring_expense_templates`/`recurring_expense_instances`,
added the flat `recurring_expenses` table exactly as designed, renamed
`transactions.recurring_expense_instance_id` → `recurring_expense_id`. One
migration (`20260819173541_recurring_expenses_flat_redesign`), no
data-migration concerns (nothing deployed). Replaced
`recurringExpenseTemplateService`/`recurringExpenseInstanceService` with a
single `recurringExpenseService` (`createRecurringExpense`,
`updateRecurringExpense`, `removeFromMonth`, `markRecurringPaid`,
`listByMonth`, `findManyByIds`, `sumCommittedCentsForCategoryMonth`,
`seedNewMonth`). Auto-copy-forward hook point resolved: hooked into
`resolveBudgetMonthIdWithCreatedFlag` (new — same resolution as
`resolveBudgetMonthId` but also reports whether *this* call created the
row), used by both `categoryMonthService.addCategoryToMonth` (via a new
optional `onNewBudgetMonth` deps hook, wired to
`recurringExpenseService.seedNewMonth` in `server.ts` — kept as plain
function injection rather than a direct import specifically so
`categoryMonthService` never has to depend on `recurringExpenseService`,
preserving the one-directional service-layer dependency graph) and
`ensureActiveForCategoryOnClient` (now returns `{ categoryMonth,
monthWasCreated }`, consumed directly by `recurringExpenseService.createRecurringExpense`).
Whichever action is the first to touch a brand-new month — a category add
or an unrelated new recurring expense — triggers the carry-forward, not
just locking. GraphQL layer rebuilt to match (`RecurringExpense` type,
`createRecurringExpense`/`updateRecurringExpense` mutations replacing the
template+instance pairs, single `recurringExpenses(month)` query, DataLoaders
consolidated). 24 new tests for `recurringExpenseService` (was 0 after
deleting the old template/instance suites), 286 Jest tests total.

**Real-Postgres discovery: a caught conflict inside `$transaction` poisons
the rest of it.** Manually smoke-testing the new carry-forward against real
Postgres (not just the fake) crashed with `25P02 current transaction is
aborted` — traced to a minimal repro: `create` inside `$transaction`,
`catch` the P2002, then run *any* further query on that same `tx` — Postgres
rejects everything after a failed statement until a `ROLLBACK`/`SAVEPOINT`,
and this project's Prisma 7 + `@prisma/adapter-pg` setup doesn't paper over
that the way the older query engine used to. This wasn't limited to the new
code — `ensureActiveForCategoryOnClient`'s existing "lost the race, return
the winner" `categoryMonth.create` catch (shipped in step 3/4) had the
identical shape and was never actually exercised against real Postgres in
that branch before now, only against the fake (which can't reproduce
Postgres transaction-abort semantics at all). `authService.ts`'s
`verifyOtp` had already independently discovered and worked around the same
issue (see its own doc comment) by keeping its create-then-catch outside
any transaction entirely.

Fixed with a new shared `withSavepoint(tx, name, attempt)` helper
(`src/lib/prismaSavepoint.ts`) — wraps an attempt in a real Postgres
`SAVEPOINT`/`ROLLBACK TO SAVEPOINT` so a caught conflict can be recovered
from mid-transaction. Applied to the three affected spots:
`resolveBudgetMonthIdWithCreatedFlag`, `ensureActiveForCategoryOnClient`
(the pre-existing one), and `seedNewMonth`'s per-item carry-forward loop.
`addCategoryToMonth`'s call to `resolveBudgetMonthIdWithCreatedFlag` also
had to move inside its own `prisma.$transaction(...)` — `SAVEPOINT`
requires an active transaction, and that call previously ran on the raw,
non-transactional client. Fake Prisma gained a no-op `$executeRawUnsafe`
stub, matching the existing "real concurrency safety verified against a
live database, not the fake" pattern already established for row locking.
Re-verified end to end against real Postgres afterward, including a genuine
concurrent race (two simultaneous first-touches of the same brand-new
month, one via `createRecurringExpense` and one via `addCategoryToMonth`,
run with `Promise.all`) — no crash, carry-forward happened exactly once,
no duplicate rows.

`pr-reviewer` on `feature/recurring-expenses-flat-redesign`, round 1: found
one blocking issue — `addCategoryToMonth` ran
`resolveBudgetMonthIdWithCreatedFlag` and the `categoryMonth` insert in two
separate transactions, so a failure in the second (e.g.
`category_month_budget_required`) left the first transaction's
`BudgetMonth` row committed anyway, permanently and silently losing the
carry-forward trigger for that month on retry (`wasCreated: false` even
though the retry was genuinely the first successful activity there). Fixed
by merging both into one transaction, matching `createRecurringExpense`'s
already-correct pattern; re-verified against real Postgres with the exact
failing-then-retrying sequence. Also addressed two suggestions from the
same round: `onNewBudgetMonth`/`seedNewMonth` calls now wrapped in
try/catch and swallowed, matching their own doc comments' already-stated
"never allowed to fail the action that already succeeded" intent (the code
didn't actually enforce that before); and a new test proving
`seedNewMonth`'s per-item collision skip continues to the next item rather
than just not throwing overall. Plus a nitpick: `withSavepoint` now
releases its savepoint on the success path. 288 Jest tests total (was 286).

Round 2 (verifying those fixes): **approved**. Traced the merged
transaction's control flow and confirmed the bug is genuinely closed, both
try/catch swallows are correctly scoped, and the new collision-continuation
test proves what it claims. Two minor non-blocking notes for a future
pass, not blockers for this PR: no test yet exercises the swallow itself
(a test that makes `seedNewMonth` throw and asserts the outer call still
succeeds), and the swallowed path has no logging — a genuine bug there
would currently be invisible in production. Tracked here rather than
addressed now, since round 2 explicitly called them out as follow-up
material.

`test-auditor` on `feature/recurring-expenses-flat-redesign`: suite
trustworthy (307 tests at the time, all passing, no `.skip`/`.only`, no
cross-test ordering dependency), but flagged real gaps — most notably that
`withSavepoint` (the fix motivating this whole PR's prep commit) had *zero*
dedicated Jest coverage, since the fake Prisma's `$executeRawUnsafe` is a
no-op and nothing asserted the actual SQL sequence it issues. Also flagged:
no test distinguishing `monthWasCreated: true` from `false` with
`onNewBudgetMonth` actually wired (a `&&` → always-true regression would've
passed every existing test); zero coverage on several `recurringExpenseService`
negative paths (`removeFromMonth`'s `month_locked`/not-found/P2003-race,
`markRecurringPaid`'s not-found paths and its own CategoryMonth-not-found
data-integrity check, `findManyByIds`); and `updateRecurringExpense`'s
category-reassignment/auto-activation branch, untested because every
existing test happened to reuse the same category on create and update.
Also closed round 2's two follow-up notes (above) while at it: a test
proving `withSavepoint` issues `SAVEPOINT`/`RELEASE SAVEPOINT` correctly
via a spy, and two tests that actually exercise the `onNewBudgetMonth`/
`seedNewMonth` swallow (make it throw, assert the outer mutation still
succeeds) rather than just asserting the try/catch exists. Logging on the
swallowed path still not done — no logger dependency exists anywhere in
the service layer yet, so this stays a real "consider it later" rather
than a quick add. 307 Jest tests total (was 288 before this pass, +19).

`feature/recurring-expenses-flat-redesign` merged into `develop`. Picked up
Build Order step 6 (Savings funds + movements) on a fresh
`feature/savings-funds` branch. Kickoff interview resolved every open
point from `PLAN.md`'s original sketch, confirmed with the user before any
code was written:
- **Hard-deleted, not soft-deleted** — revised out during this step's own
  kickoff interview, before any soft-delete code ever existed for it,
  matching every other entity in the app (see `PLAN.md`'s Data Model
  revision note).
- **Deleting a fund is blocked while movements reference it** — same
  "remove what's in it first" pattern as everywhere else, not a cascade.
- **Overdraft is rejected** ("can't withdraw money you don't have"), and —
  confirmed explicitly — that rule holds on every write, not just create:
  editing or deleting a movement is re-checked against the resulting
  balance too (e.g. can't delete a deposit a later withdrawal already
  depends on).
- **Movements are editable and deletable** — the original sketch only had
  `addSavingsMovement`, no update/delete, which the user flagged as
  looking like an oversight given every other money-entry type in this app
  supports both. `fundId` deliberately stays non-reassignable on update
  (moving money between funds would mean atomically rebalancing two
  overdraft checks at once — out of scope).
- **`currentAmountCents`/`achieved` computed at read time, not stored
  columns** — despite `PLAN.md`'s original schema listing
  `current_amount_cents` as a plain column. Weighed explicitly: the user
  raised the "many movements" scaling concern directly, the answer covered
  both that migrating to a stored+maintained column later is cheap (one
  migration, backfill, update three write paths) and that the actual scale
  doesn't warrant it now (a personal fund realistically accumulates a few
  thousand movements over a decade at most — negligible for Postgres to
  sum) — same reasoning already used for `recurringCommittedCents`/
  `paidThisMonth`.
- **`achieved` is always `false` when no `targetAmountCents` is set** — "no
  target means there's nothing to have achieved."
- Movement mutations return `SavingsMovement` (with a `fund` field to
  traverse back), not `SavingsFund` directly as the original sketch had —
  needed anyway once update/delete exist, and consistent with every other
  "log an event" mutation in this schema (`createTransaction`,
  `markRecurringPaid`).

Built: `savingsFundService` (CRUD, hard-delete blocked by referencing
movements) and `savingsMovementService` (create/update/delete, each
re-validating the resulting balance under a real row lock —
`lockSavingsFundRow`, `SELECT ... FOR UPDATE`, same pattern as
`lockBudgetMonthRow` — so two concurrent movements against the same fund
can never both read the same balance and both think an overdraft is safe).
GraphQL layer: `SavingsFund`/`SavingsMovement` types, `MovementType` enum,
`savingsFunds` query, six mutations, three new DataLoaders
(`savingsFundById`, `movementsBySavingsFundId`,
`currentAmountCentsBySavingsFundId`). 361 Jest tests total (was 307),
including a dedicated concurrent-race test against real Postgres (two
withdrawals each individually safe but together overdrawing) — exactly one
succeeds, the balance never goes negative.

`pr-reviewer` on `feature/savings-funds`, round 1: found one real, if
narrow, gap — `updateSavingsMovement`/`deleteSavingsMovement` fetched the
target movement before opening their transaction, then never re-verified
it still existed once inside the fund's row lock. A concurrent update/delete
of the same movement (double-click, or a race between two devices) could
let the second caller's write hit an already-gone row, surfacing Prisma's
raw P2025 instead of the typed `movement_not_found` every other not-found
path produces. Explicitly not the PR #14 transaction-poisoning bug —
confirmed nothing caught the error and kept querying the same `tx`
afterward, it just propagated and rolled back cleanly. Fixed by mapping
P2025 to `movement_not_found`, same "pre-check plus DB-level backstop"
pattern as `deleteSavingsFund`'s P2003 catch elsewhere in this file. Two
nitpicks also addressed: `schema.prisma`/`PLAN.md` now document why
`savings_movements`' index is `(userId, fundId)` rather than the
`(userId, date)` `PLAN.md`'s general guidance originally suggested
(deliberate — matches the real query patterns). Two other round-1
observations turned out to be non-issues on re-check (`docs/SERVICES.md`
already listed `computeCurrentAmountCents`; `MovementType` runtime
validation has no caller to validate against today). 363 Jest tests total
(was 361, +2 regression tests simulating the race). Re-verified against
real Postgres with a genuine concurrent double-delete.

Round 2 (verifying the fix): **approved**. Confirmed the catch is scoped
correctly (doesn't mask `insufficient_funds` or swallow unrelated errors),
no further `tx` query happens after the catch, and both regression tests
genuinely exercise the race rather than a mocked shortcut.

PR #15 went through a second `test-auditor` round after the fixes above:
verdict **tests trustworthy**, all 8 findings genuinely closed with
meaningful assertions (no fake-passing tests introduced), only one small
new gap surfaced — `SavingsFund.startDate`/`endDate`'s date-formatting
resolvers had zero coverage (existing tests only proved the values were
passed *into* the service, never that they come back out formatted, or
null-passthrough, correctly). Fixed with two cases (dates set / both null)
added to `Query.savingsFunds`' existing test. 378 Jest tests total (was
377). `pr-reviewer` (2 rounds) and `test-auditor` (2 rounds) both closed.
**PR #15 merged into `develop`.**

### Step 7 (Income sources) — grill me pivoted the design before any code existed

Kicked off the standard grill-me for step 7 and got as far as nailing down
a first batch of decisions the same way savings funds was (hard-delete not
soft — reversing `PLAN.md`'s original sketch; `actualAmountCents` directly
editable, not a separate `markReceived` event; unique name per month, same
`@@unique([monthId, name])` shape as recurring expenses; same planning
horizon as everything else) — but then the user pushed back on the
*entity itself*, the same way step 4's "why do we need templates?"
pushback rebuilt recurring expenses. Direct quote-level reasoning: a
`Transaction` already has `direction`, and `direction` actually lives on
`Category` (not just derived per-transaction) — so an income-direction
Category, activated into a month via `CategoryMonth`, already gives
"one planned number for the month, satisfied by N actual Transactions,"
which is *exactly* the recurring-expense pattern (`amountCents` planned,
`paidThisMonth` = `SUM(transactions) >= planned`) minus the extra row.
Nothing new needs to exist.

**Decided (not yet built):**
- **No new `income_sources` table.** `income_sources` was never migrated —
  no schema/migration ever existed for it, so there's nothing to tear
  down, only `PLAN.md`/`GLOSSARY.md` prose to mark superseded (same
  "kept side by side, not deleted" convention as the recurring-expense
  template/instance section) once this actually gets built.
- Income is: an income-direction `Category` (e.g. "Salary", "Freelance" —
  the user confirmed a couple of income categories is fine, that's the
  "2 different places" case), added to a month via the *existing*
  `addCategoryToMonth`, with `monthlyBudgetCents` reused as-is for
  "expected amount this month" — **not renamed**, to avoid an interface
  break on an already-shipped field, just semantically doing double duty
  for both directions now. Each actual paycheck/deposit is a normal
  `Transaction` against that `CategoryMonth`.
- **New computed field**: `CategoryMonth.actualAmountCents` (name not
  finalized) — `SUM(transactions.amountCents)` for that `CategoryMonth`,
  same read-time-computed pattern as `paidThisMonth`/
  `recurringCommittedCents`/`achieved`. Scoped to **both directions**, not
  income-only — the user explicitly wants "spent so far" for expense
  categories too ("I always helps to know the total spent this month next
  to how much you can still spend"), which today isn't exposed at all
  (frontend would have to sum the `transactions` array itself).
- **New optional `direction` arg on `categoryMonths(month)`** — powers a
  dedicated "Income" screen (or "Expenses" screen) without client-side
  filtering. Confirmed there's no gap here: `direction` is knowable
  up-front from the Category, before any Transaction exists, same as an
  expense category shows €0 spent before its first transaction.
- None of this is built yet — no branch, no schema changes, no code. Pure
  design discussion this session.

### A second, bigger feature surfaced mid-grill: running "bank balance" — not in `PLAN.md` at all, explicitly deferred to its own step/PR

While explaining *why* income matters, the user described wanting an
always-visible total ("I have 75k, I receive 4500, now I have 79500")
distinct from any single month's number, and confirmed a month going
negative is fine/expected — the overall balance is what actually has to
stay honest, not each month in isolation. Decided so far:
- **Computed at read time**, same house pattern as everything else
  derived — not incrementally maintained.
- **Anchored to a user-editable checkpoint, not full transaction history.**
  Explicit user call: "we assume the bank value he now added is already
  all the money he has and the transactions only affect from that point
  forward." So: a value (+ the timestamp it was set) the user can set or
  overwrite at any time, even mid-month — first-time users can enter `0`
  and correct it later. Whenever it's edited, everything before that
  timestamp stops counting; the running balance from then on is
  `checkpointAmountCents + net(Transactions dated after checkpointSetAt)`.
- **Savings Fund deposits/withdrawals do NOT affect this balance** —
  explicit user call, deliberately kept as two separate visible numbers
  (mirrors their Excel: bank money vs. invested/saved money shown
  separately, specifically to avoid the "confusing once split across 10
  investments" problem of a single blended net-worth figure).
- **Not yet decided**: exact GraphQL field names, where the checkpoint
  value + its timestamp live (likely a new field pair on `User`, no such
  precedent exists yet), whether setting/editing it needs its own
  dedicated mutation, validation bounds. Deliberately not grilled to
  completion yet — agreed to ship as its own follow-up step/PR after
  Income sources, with its own short grill, rather than bundling two
  unrelated-sized features into one branch.

Session paused here at the user's request ("continue tomorrow") —
no code written for either piece above.

### Step 7, resumed and built: `CategoryMonth.actualAmountCents` + `categoryMonths(direction)`

Closed the two remaining open questions from the pause point in two
quick confirms: the new computed field is named `actualAmountCents`
(mirrors the "expected vs actual" language from the original income
sources sketch), and `addCategoryToMonth`/`updateCategoryMonthBudget`
need no changes at all — both are already direction-agnostic, only
setting `monthlyBudgetCents` on a row regardless of what direction its
category has.

Built on `feature/category-month-actuals`:
- `categoryMonthService.listByMonth(userId, month, direction?)` — the
  `categoryMonth` query itself still just filters by `userId`/`monthId`
  (no relational-filter query shape); when `direction` is given, a
  second small `category.findMany({ where: { id: { in: [...] } } })`
  resolves each row's category and filters in application code. Kept
  this simple over pushing `category: { direction }` into the Prisma
  `where` clause specifically to avoid teaching the fake Prisma test
  double a new relational-filter shape — the result set per month is
  small (bounded like a month's transactions), so the extra query is
  cheap.
- `GraphQL.CategoryMonth.actualAmountCents` — reuses the *existing*
  `transactionsByCategoryMonthId` DataLoader (the same one
  `CategoryMonth.transactions` already used) and sums in the resolver —
  no new DataLoader, no new Prisma query at all.
- `GraphQL.Query.categoryMonths` gained an optional `direction` arg,
  mapped through `directionToDb` same as every other direction-facing
  resolver.
- Verified the direction filter + the sum against real Postgres via a
  throwaway `scripts/smoke-category-month-actuals.ts` (deleted after
  use, never committed) — an income-direction "Salary" CategoryMonth and
  an expense-direction "Groceries" one, each with real Transactions,
  confirmed `listByMonth(..., 'income')`/`listByMonth(..., 'expense')`
  return exactly the right row and the summed cents match.
- `docs/PLAN.md`/`GLOSSARY.md`/`SERVICES.md` updated: `income_sources`
  (Data Model section, the illustrative `IncomeSource`
  type/input/query/mutations, Build Order step 7, the soft-delete
  history paragraph, the audit-trail Out-of-Scope note) all marked
  superseded — kept side by side, not deleted, same convention as the
  recurring-expense template/instance section. 384 Jest tests total (was
  378).

Next actions, in order:
PR #16 (`feature/category-month-actuals` → `develop`) went through both
review stages and merged: `pr-reviewer` round 1 found one real, if narrow,
gap — the new `category.findMany` lookup inside `listByMonth` (added to
resolve the `direction` filter) wasn't scoped by `userId`, even though it
was provably safe (every `categoryId` on a `categoryMonth` row is already
guaranteed user-owned via `assertOwnedCategory`, confirmed by an existing
cross-user test). Fixed as defense-in-depth, matching this file's own
`resolveBudgetForActivation` precedent, plus a doc comment and an explicit
empty-result test the reviewer also flagged as missing. Round 2: approved.
`test-auditor` came back "tests trustworthy" with one optional note — no
test proved the `actualAmountCents` DataLoader batches multiple
`CategoryMonth` parents into a single call rather than one per parent —
closed with a two-parent test asserting both sums and a single batched
`listByCategoryMonthIds` call. 386 Jest tests total by the time it merged.

### Bank balance — grilled and built on `feature/bank-balance`

Two short rounds of grilling closed every open question from the pause
point: hard-delete-style "no history, silently overwritten" for checkpoint
edits (matching every other entity); a `BankBalance` GraphQL type
(`amountCents`/`checkpointAmountCents`/`checkpointSetAt`) plus
`Query.bankBalance`/`Mutation.setBankBalanceCheckpoint(amountCents)`; the
checkpoint anchors on `Transaction.createdAt` (real insertion time), not
the transaction's own `date`, so a backfilled transaction entered after
the checkpoint still counts even if it's dated earlier; negative allowed,
the one exception to every other money field in this schema; and a
brand-new user with no checkpoint set at all just gets `0 +` every
transaction they've ever logged (`bankBalanceCheckpointCents`/
`bankBalanceCheckpointSetAt` default to `0`/account-creation time on the
`User` row — no separate "not set" state anywhere).

Built: `bankBalanceService` (`getBankBalance`, `setBankBalanceCheckpoint`),
a new `@@index([userId, createdAt])` on `transactions` (a different axis
than the existing `(userId, date)` index — this feature's query pattern is
"every transaction entered after an instant," not "every transaction in a
month"), full GraphQL wiring, and its own `tests/services/bankBalance/`
fake Prisma (deliberately decoupled from the categories domain's fake —
`bankBalanceService` only ever reads flat `{ userId, amountCents,
direction, createdAt }` rows, no category/categoryMonth chain needed to
seed a test transaction). 402 Jest tests total (was 386). Verified against
real Postgres via a throwaway smoke script (deleted, not committed):
default-zero balance, checkpoint set, a real income + expense transaction
pair summed correctly, a negative checkpoint accepted, and a reset
correctly excluding transactions entered before the new checkpoint.

PR #17 merged. With both #16 and #17 in, the user asked for step 9 (basic
tests) next over step 8 (seed script needs their real Excel data, not yet
provided). Ran `test-auditor` scoped narrowly to step 9's own two asks
from `PLAN.md` — "auth boundary tests (user A can't read user B's data)
and one DataLoader batching check" — rather than a general audit of the
already-405-test suite. Real gaps came back, on a fresh `chore/basic-tests-audit`
branch off `develop`:

- **Cross-user isolation**: every *write* path already had a "throws
  X_not_found for another user's row" test, but several *list/read*
  functions only looked safe by inspection (`where: { userId, ... }` with
  nothing adversarial exercising it) —
  `categoryMonthService.listByMonth`, `transactionService.list`,
  `recurringExpenseService.listByMonth`. Also
  `categoryMonthService.updateCategoryMonthBudget` (a write) had no
  cross-user test at all, unlike every sibling write in the same file.
  All four fixed with a two-user fixture proving the leak doesn't happen.
- **Zero GraphQL-layer coverage for 8 mutations**: `createCategory`,
  `updateCategory`, `deleteCategory`, `removeCategoryFromMonth`,
  `updateCategoryMonthBudget`, `createTransaction`, `updateTransaction`,
  `deleteTransaction` had no test anywhere under `tests/graphql/` at
  all — not even the `UNAUTHENTICATED`-rejection + userId-forwarding
  pattern every sibling mutation family already had. The implementation
  was correct (confirmed by reading it), just unguarded against
  regression. Closed by extending `schema.categories.test.ts` and adding
  a new `schema.transactions.test.ts`. Also closed four smaller instances
  of the same pattern in `schema.savingsFunds.test.ts`
  (`updateSavingsFund`/`deleteSavingsFund`/`createSavingsMovement`/
  `updateSavingsMovement` were missing just the `UNAUTHENTICATED` case
  their siblings had).
- **DataLoader batching**: only 3 of this app's 10 DataLoaders had a test
  actually proving N concurrent `.load()` calls collapse into one
  underlying service call — the other 7 either had no direct test or only
  ever exercised a single id (which proves correctness, not batching).
  Notably `recurringCommittedCentsByCategoryMonthId` and
  `currentAmountCentsBySavingsFundId` — the two loaders whose own doc
  comments in `src/graphql/loaders.ts` explicitly claim "this loader
  still collapses N field resolutions into one batch tick" as their whole
  reason to exist as a loader — had zero proof of that claim. Added
  batching tests for all 7 in `tests/graphql/loaders.test.ts`.

Not fixed, deliberately: the audit also flagged that every DataLoader
batch-backing `findManyByIds`/`listByFundIds` function filters only by
`id: { in: ids } }`, trusting the caller to have already scoped those ids
to one user (documented in-code) — safe today by construction (no
resolver lets a client hand an arbitrary foreign-key id straight to a
loader), but nothing end-to-end proves that invariant. Flagged as a
"worth having a tripwire test for" note, not a bug — no code changes, no
test added, since it's testing an architectural invariant already
documented rather than a concrete gap. Revisit if this pattern ever
starts feeling load-bearing rather than incidental.

47 new tests (405 → 452). `npm run typecheck`/`lint`/`build` all clean.
No new Prisma queries or migrations in this branch — pure test-layer
additions — so no real-Postgres smoke verification was needed this time.

PR #18 merged. The user then placed their real Excel tracker
(`VISAO ANUAL 2026.xlsx`, a full personal budget spreadsheet — income,
rent, bills, savings goals, a year of real transaction history) in the
repo root for step 8. First move: added `*.xlsx`/`*.xls`/`*.csv` to
`.gitignore` immediately, before doing anything else, since this is real
personal financial data that should never enter git history.

Read the file directly (no xlsx parser was installed — wrote a small
stdlib-only Python script, `zipfile` + `xml.etree`, to dump each sheet's
grid; not committed, lived only in the scratchpad). The workbook has 15
sheets: one savings-fund tracker, one per calendar month (Jan-Dec, most
hidden — only the "current" ones visible), and two grocery-breakdown
sheets. Confirmed the structure is stable month to month by comparing
January against August.

Grilled the seed script's scope before writing any code — several real
decisions, not defaults:
- **No transactions, no savings funds, no bank balance** — explicit user
  call: "the seed should only be for categorys, recurring expenses,
  income and the basics not the actual transactions." Scoped to the
  catalog + current month's activations only.
- **English names, not Portuguese** — explicit user rule, applied
  throughout (Compras → Shopping, Renda → Rent, etc.), except for two
  names confirmed to stay as-is: "Ultracc" (a real recurring service,
  no better name given) and "Segurança Social" (the income category —
  user explicitly said keep it in Portuguese since it names a specific
  institution, unlike every other renamed category).
- **Recurring bills need one category** — the Excel's "CONTAS" list
  isn't grouped under anything, but `RecurringExpense.categoryId` needs
  an existing Category. User's call: one new "Fixed Bills" category for
  all of them, matching how the Excel already treats them as one flat
  list, rather than trying to fit each bill into an existing expense
  category.
- **Income categories**: user gave their actual two real sources
  directly rather than trusting the Excel's inconsistent monthly labels
  — "Obconnect" (salary) and "Segurança Social", with a third
  (Medis/insurance reimbursements) explicitly excluded ("don't add it").
  Expected amounts: Segurança Social's real August figure (816.62);
  Obconnect's real January figure (4500.00, since August's sheet didn't
  list it separately) — user confirmed reusing that number was fine.
- **dueDay**: no real per-bill due-day data exists in the sheet — user
  confirmed a flat `dueDay: 1` default for every recurring bill is fine.
- **Which user gets this data** — the one point requiring a detour: the
  user initially wondered whether this should instead be wired into
  real signup (conflating it with `authService`'s *already-existing*,
  unrelated generic default-category seeding every real new user gets).
  Clarified the seed script is a separate dev-only convenience for
  populating one throwaway account with realistic test data, not a
  change to real onboarding — user agreed, landed on a dedicated
  `seed@example.com` account.

Built `prisma/seed.ts` (`npm run seed`): idempotent (deletes and
recreates that one account's data every run, never touches anything
else), resolves "current month" the same way the app itself would for a
brand-new user (`formatMonth(new Date())` — no existing `BudgetMonth`
row to derive from), and goes through the real service layer
(`categoryService`, `categoryMonthService`, `recurringExpenseService`)
rather than raw Prisma inserts, so it exercises the same validation and
auto-activation logic a real request would. `prisma/` wasn't in either
`tsconfig`'s `include` list — added it to `tsconfig.test.json` so this
file (and any future `prisma/*.ts` script) actually gets typechecked,
not silently skipped. Verified against real Postgres: ran twice back to
back to prove idempotency, then confirmed via direct SQL — exactly one
`seed@example.com` user, 16 categories (13 expense + Fixed Bills + 2
income), 14 recurring bills, no duplicates.

### PR #19 merged — whole-codebase audit before Production Readiness

The user explicitly wanted something no single `pr-reviewer` pass had ever
done: a review of the *entire* codebase for inconsistencies, not just one
PR's diff. Ran this as a fresh, self-contained `general-purpose` subagent
(not `pr-reviewer`, which is wired to review a diff, not audit a tree) —
given `.claude/CLAUDE.md`/`GLOSSARY.md`/`PLAN.md`/`SERVICES.md`/
`FUNCTIONALITIES.md`/`PROGRESS.md` for context, then the full `src/`,
`prisma/`, `tests/` trees, with explicit instructions not to re-litigate
documented, intentional design decisions (e.g. the recurring-expenses
flat redesign, the income pivot) as if they were bugs. Confirmed baseline
clean (453 tests, typecheck/lint/build) before hunting.

Found two real, previously-uncaught bugs — both genuine gaps against
already-documented intended behavior, not new design questions, so fixed
directly rather than re-grilled:

- **Invalid calendar dates silently rolled over instead of being
  rejected.** `DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/` (duplicated across
  `transactionService`/`savingsMovementService`/`savingsFundService`)
  only checked shape — `new Date('2026-02-30')` silently becomes
  `2026-03-02` in JS, no error. Worse, `transactionService`'s
  `date_month_mismatch` guard compared `date.slice(0, 7)` against the
  target CategoryMonth's month **before** any `Date` conversion, so
  `"2026-02-30"` for a February CategoryMonth passed that check too
  (string prefix matched), then got persisted as a March transaction
  still linked to a February CategoryMonth — exactly the "silently
  truncated or shifted value" `PLAN.md`'s Dates convention exists to
  prevent, via a path the regex-only check never covered. Fixed with a
  new shared `src/lib/dateFormat.ts` (`isValidCalendarDate`) that
  round-trips the parsed Y/M/D back through `Date.UTC` and rejects
  anything that doesn't match exactly (Feb 30, Apr 31, month 13, etc.) —
  consolidates what was three separate regex constants into one
  correctly-validating helper, wired into all three services.
- **`updateCategory` could flip a category with an active (never-paid)
  recurring expense from expense to income.** The direction-change guard
  only checked for referencing `Transaction` rows, never
  `RecurringExpense` rows — `recurringExpenseService` only enforces
  "category must be expense-direction" at the recurring expense's own
  create/update time, never re-checked afterward. A brand-new recurring
  expense has zero transactions, so nothing blocked the switch; the next
  `markRecurringPaid` would then derive the resulting Transaction's
  `direction` from the now-income category, silently mislabeling it. This
  crosses a boundary introduced in a later PR (recurring expenses, #4)
  than the original direction-guard (categories, #3) — exactly the class
  of gap no single-PR review would catch. Fixed by adding a
  `recurringExpense.findFirst({ where: { categoryId } })` check alongside
  the existing transaction check, reusing the same `direction_change_blocked`
  error reason (no interface change).

Both verified against real Postgres with throwaway smoke scripts (deleted,
not committed) reproducing the exact failure mode, in addition to new
regression tests.

Also fixed, all flagged by the same audit:
- **Doc drift**: `SERVICES.md` was missing the `date_month_mismatch` rule
  entirely; it also implied query-depth limiting was production-only when
  it's actually always on (`server.ts`'s ternary only prod-gates
  introspection lockdown, not `depthLimit`) — the docs understated a
  protection that was already there, not a real gap, but still wrong.
- **Index comment inaccuracy, and the index itself corrected**:
  `SavingsMovement`'s `@@index([userId, fundId])` comment claimed it
  served `computeNetMovementCents`/`listByFundIds`, but neither query
  filters by `userId` — both filter by `fundId` alone. Reordered to
  `@@index([fundId, userId])` (new migration
  `20260820090446_fix_savings_movement_index_order`) so the leading
  column actually matches the real query pattern; `userId` still trails
  for any future userId-scoped lookup. `PLAN.md`'s Indexes bullet
  repeated the same inaccurate rationale, fixed too.
- **Dead code removed**: `categoryMonthService`'s bound
  `ensureActiveForCategory` method had zero production callers —
  `recurringExpenseService` calls the standalone
  `ensureActiveForCategoryOnClient` directly instead, and always did;
  the bound wrapper's own doc comment even claimed it was "for callers
  (recurring expenses)," which was never true. Removed the method; its
  test suite (11 real behavioral tests — idempotency, budget inheritance
  by real calendar month not insertion order, planning-horizon
  exemptions) was rewritten to call `ensureActiveForCategoryOnClient`
  directly via the same single-transaction shape production code
  actually uses, so coverage of the still-live logic wasn't lost, only
  the coverage of the dead wrapper.
- **`Transaction`'s `(userId, date)` index has no current serving
  query** (`transactionService.list` filters by a `categoryMonthId` set
  and sorts in application code, not a DB-level date-range `WHERE`) —
  left in place per `PLAN.md`'s original forward-provisioning intent, but
  documented as such directly on the index in `schema.prisma` rather than
  silently unexplained.
- **New test proving the query-depth limit actually rejects** an
  over-deep query (`tests/server.test.ts`) — previously only introspection
  lockdown had this kind of end-to-end proof; depth-limiting was
  correctly wired but unverified by any test.
- **Stale `PROGRESS.md` line**: step 8's checklist entry still said "not
  yet through pr-reviewer/test-auditor/merge" after PR #19 had already
  merged — corrected.

466 Jest tests total (was 453). PR #21 opened, went through two rounds of
`pr-reviewer` (round 1 found a minor `isValidCalendarDate` edge case —
years 0000-0099 hit a JS `Date.UTC` two-digit-year quirk — and a cosmetic
sequential-vs-`Promise.all` nitpick in `updateCategory`, both fixed; round
2 approved) and `test-auditor` (found the create-path-only asymmetry in
the new date-validation tests — `updateSavingsMovement`/`updateSavingsFund`/
`transactionService.update` never got the same nonexistent-calendar-date
regression coverage as their `create` siblings, since `assertValidDate`/
`assertValidDateFormat` are the same shared functions called from both;
closed). 472 tests by the end of that cycle.

### Round 2 of the whole-codebase audit — a real concurrency bug found and fixed

With PR #21 approved but not yet merged, the user asked for a second full
audit pass — not a re-check of round 1's fixes, but a fresh look for
whatever round 1 didn't cover. Ran the same `general-purpose` subagent
pattern, explicitly pointed at areas round 1's report hadn't dwelt on
(the auth/OTP/JWT flow, `recurringExpenseService`'s edge cases,
`budgetMonthService`'s locking, `bankBalanceService`, cross-service
consistency, `prisma/seed.ts` post-fix, and a field-for-field check of
`PLAN.md`'s illustrative schema against the real one). Auth, recurring
expenses, budget months, bank balance, seed script, and the schema
comparison all came back clean — confirmed solid, not just unchecked.

One real finding: **`updateCategory`'s direction-change guard (round 1's
own fix) has a TOCTOU race that every analogous check elsewhere in this
codebase closes, and it didn't.** The check-then-write (read referencing
`Transaction`/`RecurringExpense` rows, then later call `category.update`)
ran as unlocked, separate statements — a concurrent `createRecurringExpense`/
`updateRecurringExpense`/`transactionService.create`/`update` landing in
that gap could either let a direction flip through despite a reference
now existing, or create a new reference against a direction that's about
to change underneath it. Every other place in this codebase with this
exact shape of problem closes it with a `SELECT ... FOR UPDATE` row lock
inside a transaction (`lockBudgetMonthRow`, `lockSavingsFundRow`);
`updateCategory` had neither, and `direction` is a plain column, not
FK-constrained, so there's no DB-level backstop possible the way
`deleteCategory` gets one for free from `RecurringExpense.category`'s
`onDelete: Restrict`.

Closing this completely meant it wasn't a one-file fix — asked the user
whether to do the full multi-service fix, a narrower partial fix, or
accept the risk as a documented known gap; user chose the full fix. Added
**`lockCategoryRow`** (`SELECT ... FOR UPDATE` on `categories`, same
pattern as its two siblings) to `categoryService.ts`, and threaded it
through every read site that derives a lasting decision from a category's
`direction`:
- `categoryService.updateCategory` — the writer: locks first, *then*
  reads `existing.direction` and the referencing checks, inside one
  transaction (previously `assertOwnedCategory` ran pre-transaction;
  moved inside so the read is against the locked, current row, not a
  stale pre-lock snapshot).
- `transactionService.loadCategoryMonthForWrite` (shared by `create` and
  `update`) — locks the category row (via `categoryMonth.categoryId`)
  right before deriving the new/updated Transaction's `direction`.
- `recurringExpenseService` — split the old `assertValidInput` into a
  pure/sync half (`assertValidRecurringExpenseFields`: amount/dueDay/
  budgetType, no DB, stays as a fast pre-check) and a new DB-dependent
  half (`assertValidCategoryForRecurringExpense`: locks, then checks
  ownership + expense-direction) that now runs *inside* each
  transaction — previously the whole thing ran as an unlocked pre-check
  before the transaction even opened, in both `createRecurringExpense`
  and `updateRecurringExpense`.
- `addCategoryToMonth`/`ensureActiveForCategoryOnClient` deliberately
  **not** touched — a `CategoryMonth` activation never reads or stores
  `direction`, so it isn't part of this race at all; narrowed the fix to
  exactly the call sites that matter instead of locking everywhere
  category-adjacent.

Verified two ways, matching this codebase's established two-tier pattern
for concurrency fixes:
1. A genuine real-Postgres race — a throwaway smoke script (deleted, not
   committed) firing `updateCategory` (flip to income) and
   `createRecurringExpense` at the exact same category, truly
   concurrently, 10 times via `Promise.allSettled`, then asserting the
   final state was never "category is income AND a recurring expense
   references it" simultaneously. 10/10 runs clean — both orderings were
   actually observed (sometimes the update won, sometimes the create
   won), and in every case exactly one operation succeeded while the
   other correctly failed with its typed error, never leaving
   inconsistent state.
2. Permanent Jest coverage (fake Prisma, which can't simulate real
   locking but can prove the *code path* is right): three new `describe('row
   locking')` blocks (`categoryService.test.ts`, `transactionService.test.ts`,
   `recurringExpenseService.test.ts`), each spying on `$queryRaw` and
   asserting it's called with `FOR UPDATE` on every relevant write path —
   same style as `savingsMovementService.test.ts`'s existing one.

Also fixed while in there: `SERVICES.md`/`PLAN.md` both still described
`updateCategory`'s guard as `Transaction`-only after round 1's own fix
added the `RecurringExpense` check — round 1's fix commit updated the
code, tests, and `PROGRESS.md` but missed this one-line description in
both docs. A live example of exactly the kind of drift these audits
exist to catch.

475 Jest tests total (was 472). `npm run typecheck`/`lint`/`build` all
clean. All on `fix/codebase-audit-findings`, not yet through a fresh
`pr-reviewer` round for this latest commit or merge.

`fix/codebase-audit-findings` went through `pr-reviewer`/`test-auditor` as
planned and merged into `develop` via PR #22. Phase 1 (backend) is
functionally complete as of that merge — every numbered Build Order step
(0–9) is done.

### Row cleanup (2026-08-20) — first Production Readiness item picked up

Grilled before coding, on a fresh `chore/auth-row-cleanup` branch: the user
was specifically thinking ahead to 1M/10M-user scale, not just "does it
work today." Two things came out of that grill that shaped the design more
than the original `PLAN.md` bullet implied:
- **No hosting platform is chosen yet**, so there's no external cron to
  hang this on — ruled out anything needing one. Both trigger mechanisms
  ended up in-process: an hourly `setInterval` in `index.ts` (cleared on
  `SIGTERM`/`SIGINT` alongside the existing shutdown handler) as a
  backstop, plus a piggybacked cleanup call on every `POST
  /auth/request-otp` (failures logged, never fail the actual request) so
  cleanup stays prompt during real traffic without waiting for the hourly
  tick.
- **Revoked ≠ expired, and that gap matters more at scale, not less**:
  `refresh_tokens` rotate on every refresh (mandatory, see `PLAN.md`), so
  an expiry-only sweep would let a large number of already-useless revoked
  rows pile up for their entire TTL before ever getting cleaned — at 1M
  active users refreshing frequently, that's a real bloat source, not a
  hypothetical one. Confirmed with the user: no reason to keep a
  revoked/used row around at all, so both tables delete on either
  condition (`expiresAt < now()` OR `used`/`revoked`), not expiry alone.
- Two scale-specific implementation choices, both explained to the user
  before writing code: **dedicated indexes** (`otp_codes.expiresAt`/`used`,
  `refresh_tokens.expiresAt`/`revoked` — otherwise the cleanup query itself
  degrades to a full table scan as these tables grow) and **batched
  deletes** (1000 rows/call, looped, rather than one unbounded `DELETE`
  that could hold locks on these hot-path tables for a long single
  transaction if a large backlog ever built up).

Built: `authCleanupService` (`cleanupExpiredAuthRecords()`, TDD against a
new in-memory batch loop, extending `tests/services/auth/testFakePrisma.ts`
with `findMany`/`deleteMany`), wired into `registerAuthRoutes` (new
required `authCleanupService` dep) and `index.ts`'s interval.

`pr-reviewer` round 1 found one real bug and several worthwhile
simplifications, all fixed: the request-otp piggyback was `await`ing
cleanup before responding — not actually the non-blocking design agreed on,
and it would add unbounded latency to a hot, rate-limited auth endpoint
under any real backlog (fixed to fire-and-forget with `.catch()`, matching
the interval's pattern); the four near-identical batch-delete call sites
collapsed into two small `cleanupOtpCodes`/`cleanupRefreshTokens` helpers;
`authCleanupService` was being constructed twice (once in `server.ts`, once
in `index.ts`) — now built once in `index.ts` and threaded into
`buildServer` the same way `authService` already is; added a regression
test for a row matching both delete conditions at once (e.g. expired *and*
used), proving the sequential-pass design can't double-count. The reviewer
also flagged that `used`/`revoked` could be partial indexes instead of
plain ones for less bloat at real scale — surfaced to the user, who chose
to keep them plain: Prisma's schema DSL can't express a partial index's
`WHERE` clause, so a partial index would mean hand-editing generated
migration SQL, and since `schema.prisma` would still declare a plain index,
any *future* unrelated `prisma migrate dev` run would see that as drift and
silently regenerate the plain index — reverting the optimization with
nothing flagging it as intentional. Not worth that ongoing footgun for a
scale concern the reviewer itself called non-blocking.

`test-auditor` then found two real gaps of its own, both closed: the two
existing request-otp cleanup tests only proved `cleanupExpiredAuthRecords`
was *called*, never that the response doesn't wait for it — a regression
back to `await`ing it (the exact bug round 1's `pr-reviewer` fix already
covered) would have slipped past both silently. Fixed with a test using a
deliberately never-resolved cleanup promise: if the route awaited it, the
`app.inject()` call would hang until Jest's timeout, since the promise is
only resolved *after* asserting the response already came back. Also
found the batch-loop's trickiest boundary — an eligible-row count that's an
exact multiple of `batchSize`, which forces one extra round-trip returning
an empty page before the loop can know it's done — was never exercised (the
one multi-batch test used 5 rows over batches of 2, which always hits the
`batch.length < batchSize` short-circuit and never that boundary). Added
two tests spying on `findMany` call counts: 4 rows/batchSize 2, and 2
rows/batchSize 1.

488 Jest tests total (was 475 before this branch, +13 across both review
rounds). Both `pr-reviewer` and `test-auditor` closed clean.

`chore/auth-row-cleanup` merged into `develop` via PR #23.

### CI pipeline (2026-08-20)

Grilled before coding, on a fresh `chore/ci-pipeline` branch: confirmed
with the user this should run on both PRs and direct pushes to
`develop`/`main` (the latter as a safety net, even though CLAUDE.md's
branch workflow means it shouldn't normally happen), that "run tests +
Prisma migrations" from `PLAN.md`'s bullet should include an actual
ephemeral-Postgres `prisma migrate deploy` (not just the Jest suite, which
only needs in-memory fakes — confirmed no test file touches a real DB), and
that the resulting check should be a required, merge-blocking status check
on `develop`/`main` once it exists.

Built `.github/workflows/ci.yml` — one job, `postgres:17-alpine` service
container matching `docker-compose.yml`'s credentials, `pnpm`
install/lint/typecheck/build/test, then `prisma migrate deploy` against the
service container. Verified locally before pushing: spun up a throwaway
Postgres container and confirmed all 9 existing migrations replay cleanly
from empty (`prisma migrate deploy`) — this is exactly what CI will do, so
worth proving outside CI first rather than debugging it via failed runs.

`pr-reviewer` round 1 found one real, verified blocker: `pnpm/action-setup@v4`
has no `version` input and the repo's `package.json` had no
`packageManager` field either — the action throws immediately with no
version to resolve, so the workflow as first committed would have failed
on step 1 of every run, before lint/typecheck/build/test/migration-replay
ever got to execute. The "verified locally" note above only ever covered
the Postgres/migration-replay piece, since the pnpm-setup failure mode is
GitHub-Actions-specific and can't be reproduced locally. Fixed by adding
`"packageManager": "pnpm@11.22.0"` to `package.json` (also pins local
Corepack resolution as a side benefit). Also picked up three cheap
hardening suggestions from the same round: a `concurrency` group
(cancels a superseded run instead of queueting two full Postgres-backed
runs back to back), `permissions: contents: read` at the workflow level
(least-privilege — this job never needs to write anything), and
`timeout-minutes: 15` on the job (so a hung step can't silently burn a
large chunk of Actions minutes).

Merged into `develop` via PR #24. Confirmed working on GitHub twice over:
the PR run (32370649072) and the `push`-triggered run the merge itself
fired (32371064691, 1m3s) both passed clean.

Enabling the required-status-check on `develop`/`main` turned out to be
outside Claude Code's reach here: `gh api .../branches/develop/protection`
403'd — the fine-grained PAT this session is authenticated with has no
"Administration" repo permission, which branch protection reads/writes
need. User will do this step manually in GitHub's UI (Settings → Branches
→ require status checks → select `ci`) rather than widen the token's
scope for a one-time config change.

Two small PRs followed, both docs-only/mechanical, used to smoke-test the
pipeline end to end with the user (PR #25 recording the merge/handoff
above, PR #26 a trivial docs edit specifically to watch a full PR run
happen live) — both confirmed green.

That surfaced a real, if non-blocking, finding: every run carried a
"Node.js 20 is deprecated" annotation for `actions/checkout@v4`,
`pnpm/action-setup@v4`, and `actions/setup-node@v4` — each pinned to a
major version whose own runtime is still Node 20, which GitHub is
deprecating as an Actions runtime and silently substituting Node 24 for in
the meantime (not a failure yet, but the fallback won't last forever).
Fixed by bumping to the current majors (checkout v7, setup-node v7,
pnpm/action-setup v6 — confirmed via each action's `action.yml` that all
three now declare `using: node24`), verified with a real CI run before
merging.

### GDPR export/delete (2026-08-20)

Grilled before coding, on a fresh `feature/account-export-delete` branch.
User picked REST over GraphQL for this — a genuine question, not just a
confirmation: they'd never used GraphQL professionally and asked why this
app splits REST/GraphQL at all. Explained the actual reasoning (`/auth/*`
has to be REST since those routes *produce* the access token GraphQL's own
context builder depends on to resolve `userId`; everything post-auth went
GraphQL because `PLAN.md` made that call early for one API shape serving
both a future mobile app and website) — account export/delete is the same
"account lifecycle" category as `logout-all`, which already set the REST
precedent. Also confirmed: export = all domain data as a single synchronous
JSON response (no file storage/email infra — explicitly flagged in
`PLAN.md` as something to revisit if a real export ever gets too large for
that), and `DELETE /account` requires an explicit `{ confirm: true }` in
the body as a backend-level guard, given it's the single most destructive
action in the app.

**Real architectural finding, surfaced while designing this, not assumed**:
none of `BudgetMonth`/`Category`/`CategoryMonth`/`Transaction`/
`RecurringExpense`/`SavingsFund`/`SavingsMovement` has an actual FK
relation back to `User` in the schema — `userId` is an application-scoped
column only, enforced by every query filtering on it, never by the
database. Only `RefreshToken` has a real `@relation` (`onDelete: Cascade`).
So `deleteAccount` can't just delete the `User` row and let cascade handle
the rest — it would silently orphan every table instead. Built as an
explicit, dependency-ordered multi-table delete inside one transaction
(movements → transactions → funds/recurring-expenses/category-months →
categories/budget-months → `otp_codes` by email → the `User` row itself),
respecting the `Restrict` FKs between the domain tables.

Built `accountService` (`exportUserData`, `deleteAccount`), TDD against a
new `tests/services/account/testFakePrisma.ts` covering every table this
touches. Routes: `GET /account/export`, `DELETE /account` — extracted a
small shared `resolveBearerUserId(request, secret)` helper into `lib/jwt.ts`
along the way (this is the third route needing "verify the bearer token,
401 if not," after `logout-all` — refactored that one to use it too, no
behavior change). Given how many `Restrict` FKs the delete-ordering has to
walk through correctly, verified against real Postgres, not just the fake:
seeded a full account (every table) plus a second user's data, ran
`deleteAccount`, confirmed zero orphaned rows and zero cross-user
contamination — passed clean, no FK violations.

`pr-reviewer` round 1 found one real bug and a genuine open design
question. Bug, fixed: `deleteAccount`'s final `tx.user.delete` didn't catch
P2025 — a double-submit `DELETE /account` (or a client retry) would have
the losing request's user row already gone by its own delete, surfacing a
raw 500 instead of `account_not_found` the way every other race of this
shape in this codebase is handled (same pattern as
`savingsMovementService`'s P2025 catch) — verified against real Postgres.
Also fixed while in there: `exportUserData`'s seven reads now run inside
one `RepeatableRead` transaction for a consistent snapshot (were a bare
`Promise.all` outside any transaction — a concurrent write could've
returned a mix of pre/post-write state across tables); extracted a shared
`findAccount` helper (was duplicated find-or-throw); added a modest per-IP
rate limit to both routes.

The open question: the reviewer flagged that `Category`/`BudgetMonth`/
`SavingsFund` — the three tables with no other FK dependency — can be
created with nothing but a bare `userId`, so a row created for this user at
the exact moment `deleteAccount` runs (or right after) can become
permanently orphaned, nothing left to ever delete it. Digging into *why*
before deciding what to do about it: checked the actual migration SQL, not
just `schema.prisma`, and confirmed `docs/PLAN.md`'s Data Model section has
always labeled every `user_id` column `(fk)` — this was never a considered
tradeoff. Only `refresh_tokens` ever got a real database-level constraint;
the rest silently never did, because Prisma only generates one when a
named `@relation` is declared, and app-level `WHERE userId = ...`
filtering already made every query behave correctly without it — invisible
until `deleteAccount` became the first thing that ever needed to delete
*by* `userId` across these tables. User's call after hearing that: don't
band-aid it (an advisory lock) or leave it purely as a documented
limitation — **scope "retrofit the missing `User` FKs" as its own next
task**, since a real fix has to reconcile with the *intentional* `Restrict`
relations already between the domain tables (e.g. `CategoryMonth →
Category`, deliberately `Restrict` so a normal single-item `deleteCategory`
can't silently cascade away linked data) — not a small fix, not something
to fold into this branch. Documented in `PLAN.md`'s GDPR note as a known,
understood gap in the meantime.

Remaining Production Readiness items: none — CI, row cleanup, and GDPR
export/delete are all built. A privacy policy is still needed before real
signups, but that's a product/legal task, not code.

`feature/account-export-delete` went through `pr-reviewer`/`test-auditor`
as planned and merged into `develop` via PR #28.

### Retrofit missing `User` FK relations (2026-08-20)

The queued follow-up, on a fresh `fix/missing-user-fk-relations` branch.
Design question going in: `onDelete: Cascade` vs `Restrict` for the seven
new relations. Traced through why `Cascade` doesn't actually work here —
`deleteAccount` already does its own explicit, dependency-ordered delete;
cascading straight from `User` would have to cascade through the
*intentional* `Restrict` relations already between the domain tables
(`CategoryMonth → Category`, etc.), which would silently weaken the real
product safety guards those give the normal single-item `deleteCategory`/
`deleteSavingsFund` flows. Landed on `Restrict` everywhere — a pure DB-level
backstop confirming `deleteAccount`'s ordering is correct, not a deletion
mechanism, so no service code needed to change at all.

User asked a genuinely good clarifying question mid-grill: what's the
actual worst case if `deleteAccount`'s final `user.delete` ever hits the
new constraint? Traced it through explicitly — since everything runs
inside one `$transaction`, a `P2003` there rolls back the *whole*
transaction, so nothing is actually deleted; the request just fails and a
retry re-queries fresh and succeeds. Compared against today's status quo
(the race succeeds silently and orphans the row forever) — a safe failure
is already a large improvement over silent corruption, without needing
anything further. Given that, explicitly chose **not** to add either a
retry loop or an advisory lock (the only way to close the timing window
outright, at the cost of touching `categoryService`/`budgetMonthService`/
`savingsFundService`'s create paths too) — a safe failure was judged
sufficient for how rare an exact-timing collision actually is.

Local dev DB had pre-existing orphaned test rows (4 `categories`, 11
`budget_months`, 1 `category_month`) that would've blocked the new
constraints from applying. User approved a full `prisma migrate reset`.
Prisma's own CLI has an AI-agent safety check for exactly this class of
command — it refused to run even when the user typed it directly,
demanding an explicit `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` env var
carrying the user's literal consent text. Followed that protocol: laid out
the action, target (confirmed `localhost:5432`/`budget_app`, the local
Docker container, not anything production — no production deployment
exists yet), and irreversibility explicitly, got clear confirmation, reran
with the consent var set to the user's exact message.

Schema: added `user User @relation(fields: [userId], references: [id],
onDelete: Restrict)` to all seven models, plus the corresponding
back-relation arrays on `User`. One migration
(`20260820142059_add_missing_user_fk_relations`), applied clean against
the freshly-reset DB. Zero code changes needed anywhere in the service
layer — every existing test (513) still passed unchanged. Verified against
real Postgres with a throwaway script (not a permanent Jest test — this
needs real FK enforcement the fake Prisma can't simulate): (1) a `Category`
insert with a nonexistent `userId` is now correctly rejected with `P2003`
— the original gap, now actually closed; (2) `deleteAccount` still
completes cleanly end to end with the new constraints; (3) manually
replayed the exact orphan-race (a stray `Category` created mid-transaction,
right before the final `user.delete`) and confirmed it fails loudly with
`P2003` and the whole transaction rolls back — the stray row, the original
category, and the user all still exactly as they were.

Remaining Production Readiness items: none. Next: Phase 2 (mobile app),
which needs design references (mockups + Excel structure — now partly in
hand) before any screen work begins, per CLAUDE.md.

Small tracked follow-up, not blocking, carried over from step 6: add
logging on the `onNewBudgetMonth`/`seedNewMonth` swallow path
(recurring-expenses step) once this service layer has a logger dependency
to hang it on (none exists yet — `src/lib/shutdown.ts` is the only
existing precedent, at the app-startup level, not per-service).

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

      **Superseded, then rebuilt**: the template/instance split described
      above was replaced by the flat `recurring_expenses` design (one row
      per month, no template) — see "Where we left off" above and
      `PLAN.md`'s Data Model section for the rebuild. Kept as accurate
      history of what step 4 originally shipped, not rewritten away.
- [x] **5. Month lifecycle** — four increments merged: budget-inheritance on
      category/recurring-expense activation (PR #7, merged),
      `lockMonth`/`deleteBudgetMonth`/`Query.currentMonth` (PR #8, merged),
      server-side planning-horizon enforcement (PR #10, merged), the
      recurring-expenses flat redesign (PR #14, merged, see "Where we left
      off" above for the full rebuild + `pr-reviewer`/`test-auditor`
      rounds). Carry-forward turned out to need no dedicated mutation for
      categories (reuses `addCategoryToMonth`'s existing
      budget-omit-to-inherit behavior) but *is* automatic for recurring
      expenses (see the flat redesign) — and auto-lock cascade was dropped
      entirely — all revised out of the original scope described here
      during the step's kickoff interview, see `PLAN.md`'s Month Lifecycle
      section for the actual design.
- [x] **6. Savings funds + movements** — grilled, built, `pr-reviewer`
      (2 rounds) and `test-auditor` (2 rounds) both closed clean. Merged into
      `develop` via PR #15. See "Where we left off" above for the full
      design/build/review narrative.
- [x] **7. "Income sources"** — **reconsidered before any code was written;
      the dedicated `income_sources` table described in `PLAN.md` is
      dropped**, replaced by `CategoryMonth.actualAmountCents` (computed) +
      an optional `direction` arg on `categoryMonths` against ordinary
      income-direction Categories. `pr-reviewer` (2 rounds) and
      `test-auditor` both closed clean. Merged into `develop` via PR #16.
      Immediately followed by the **bank balance** checkpoint feature
      (grilled and built as its own step, not a numbered Build Order item
      — see the Data Model section's "Bank balance" note in `PLAN.md`):
      `Query.bankBalance`/`Mutation.setBankBalanceCheckpoint`, anchored on
      `Transaction.createdAt` not `date`, the one money field in this
      schema allowed to go negative. `pr-reviewer` (2 rounds) and
      `test-auditor` both closed clean. Merged into `develop` via PR #17.
      See "Where we left off" above for the full pivot and both builds.
- [x] **8. Seed script** — `prisma/seed.ts` (`npm run seed`), built from the
      user's real Excel tracker. Scoped to catalog + current month only, no
      transactions/funds/bank balance (explicitly grilled out). Seeds a
      dedicated `seed@example.com` account, idempotent. `pr-reviewer` (2
      rounds — round 1 found two real bugs in the cleanup/idempotency
      logic) and `test-auditor` both closed clean. Merged into `develop`
      via PR #19. See "Where we left off" above for the full grill and
      build.
- [x] **9. Basic tests** — audited on `chore/basic-tests-audit`: a
      `test-auditor` pass scoped specifically to this step's own two asks
      (not the general suite) found real gaps — several list/read
      functions (`categoryMonthService.listByMonth`,
      `transactionService.list`, `recurringExpenseService.listByMonth`)
      and `updateCategoryMonthBudget` had no cross-user isolation test
      despite looking safe by inspection; 8 GraphQL mutations
      (`createCategory`/`updateCategory`/`deleteCategory`/
      `removeCategoryFromMonth`/`updateCategoryMonthBudget`/
      `createTransaction`/`updateTransaction`/`deleteTransaction`) had
      zero tests at the GraphQL layer at all, unlike every sibling
      mutation family; and 7 of this app's 10 DataLoaders had no test
      actually proving they batch (only single-id or null-fallback
      coverage) — notably the two loaders whose own doc comments claim
      batching as their whole reason to exist
      (`recurringCommittedCentsByCategoryMonthId`,
      `currentAmountCentsBySavingsFundId`). All closed: 47 new tests (405
      → 452).

## Phase 2 — Mobile app

Not started. Needs design references (mockups + Excel structure) before any
screen work begins, per `PLAN.md`.

## Phase 3 — Website

Not started.

## Notable deviations / decisions from PLAN.md

- Prisma 7's client generator requires a driver adapter — added
  `@prisma/adapter-pg` (PLAN.md assumed the classic bare-`DATABASE_URL` setup).
- `package.json` gained a `packageManager` field (`pnpm@11.22.0`) during the
  CI pipeline step — `pnpm/action-setup` in GitHub Actions needs a version
  to resolve and errors out with neither this field nor an explicit
  `version` input; also pins local Corepack resolution as a side benefit.
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
