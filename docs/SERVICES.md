# Services & API Reference

Quick lookup of what exists right now: every service and what it does, every
GraphQL query/mutation, every REST route. This is a **map of the current
surface**, not a design-rationale doc — for *why* something works the way it
does, see `PLAN.md`; for domain terminology, see `GLOSSARY.md`.

**Keep this current.** Whenever a service gains/loses a function, a
dependency changes, or the GraphQL schema/REST routes change, update the
relevant section here in the same commit — same "living document" rule as
`PLAN.md`.

---

## Services

Each service is a factory function (`createXService({ ...deps })`) returning
a plain object of async functions, constructed once in `server.ts` and
shared across requests — nothing in a service is per-request state. Every
function that touches user-owned data takes `userId` as its first argument
and scopes its query by it — no exceptions, per `CLAUDE.md`'s multi-tenancy
rule.

### `authService` — `src/services/auth/authService.ts`

OTP-based auth: request a code by email, verify it for tokens, rotate
refresh tokens, log out. Deps: `prisma`, `emailService`, `jwtSecret`.

| Function | Does |
|---|---|
| `requestOtp(email)` | Generates a 6-char alphanumeric code (A-Z, 2-9, no ambiguous chars), argon2-hashes it, stores it (10 min TTL), emails it. |
| `verifyOtp({ email, code, deviceLabel? })` | Validates the latest unused code for that email (not expired, under 5 failed attempts), creates the `User` row on a genuine first-time signup (seeding the default category catalog, see `defaultCategories.ts`) or reuses the existing one on a returning login, issues an access token (JWT, 15 min) + refresh token (random, sha256-hashed at rest, 30 day TTL). |
| `refreshSession(token)` | Looks up the refresh token by hash, rejects if revoked/expired, atomically revokes it and issues a new one (mandatory rotation — a reused old token fails). |
| `logout(token)` | Revokes one refresh token. |
| `logoutAll(userId)` | Revokes every refresh token for that user (all devices). |

### `authCleanupService` — `src/services/auth/authCleanupService.ts`

Row cleanup for `otp_codes`/`refresh_tokens` (PLAN.md's "Row cleanup" note)
— nothing else in the app deletes from these tables over time. Deps:
`prisma`, `now?`, `batchSize?` (default 1000).

| Function | Does |
|---|---|
| `cleanupExpiredAuthRecords()` | Deletes expired `otp_codes`/`refresh_tokens`, plus used `otp_codes` (regardless of expiry — dead weight the moment they're used, no reason to wait for the TTL) and revoked `refresh_tokens` past a 1-hour grace period (`revokedAt` cutoff, comfortably longer than the OTP TTL) — not immediately, so a revoked token stays visible long enough for a concurrent reuse-detection check or the next login's self-heal check to still see it existed. Deletes in bounded batches (`findMany` a page of ids, `deleteMany` by id) rather than one unbounded `DELETE`, so a large backlog can't hold locks on these hot-path tables for one long transaction. Returns `{ otpCodesDeleted, refreshTokensDeleted }`. |

Triggered two ways, both in-process (no external cron/hosting dependency):
piggybacked on every `POST /auth/request-otp` (see REST Endpoints below;
failures are logged, never fail the request) and an hourly `setInterval` in
`index.ts` as a backstop for stretches with no login traffic at all —
cleared on `SIGTERM`/`SIGINT` alongside the existing shutdown handler.

### `budgetMonthService` — `src/services/budgetMonths/budgetMonthService.ts`

Resolves `"YYYY-MM"` strings to the real per-user `BudgetMonth` row every
other month-scoped table references via `month_id`; owns month locking.
Deps: `prisma`, `now?` (defaults to `() => new Date()`, injectable for tests).

| Function | Does |
|---|---|
| `resolveBudgetMonthId(userId, month)` | Upserts and returns the row's id — creates it if it's the first time this user has touched that month. Callers must validate the month format first. |
| `findBudgetMonthId(userId, month)` | Read-only lookup, returns `null` if it doesn't exist yet — never creates a row as a side effect of a query. |
| `findManyByIds(ids)` | Batch lookup for DataLoader use. |
| `findCurrentMonth(userId)` | Derived, never persisted: the earliest unlocked `BudgetMonth` row for this user, or today's real calendar month if none exists (brand new, or every row is locked with nothing planned past it). No auto-lock cascade, no automatic next-month creation — both deliberately dropped in favor of simpler, always-explicit user actions (see `PROGRESS.md`). |
| `lockMonth(userId, month)` | Locks the target month permanently — must be the current (earliest unlocked) month, or throws `budget_month_not_current`. No carry-forward or next-month creation here; category/budget carry-forward is a separate, explicit `addCategoryToMonth` call per item, while `recurring_expenses` carry forward automatically the moment a new month is first touched (see `recurringExpenseService` below). |
| `deleteBudgetMonth(userId, month)` | Hard delete for an unlocked month the user pre-provisioned but decided not to use. Blocked while any `category_month` references it — same "remove what's in it first" pattern as `deleteCategory`. |

Also exports **`resolveBudgetMonthId(client, userId, month)`** standalone
(client-parameterized) — lets a caller with its own open transaction run
this as part of that transaction instead of on the service's own connection
— and **`resolveBudgetMonthIdWithCreatedFlag(client, userId, month)`**,
same resolution but also reporting whether *this* call is the one that
created the row (used by `recurringExpenseService`'s carry-forward-on-first-touch
seeding to know when a month is genuinely new). Must be called with an
active transactional client — its create attempt runs under `withSavepoint`
(`src/lib/prismaSavepoint.ts`) so a caught conflict doesn't poison the rest
of the caller's transaction; see that file for why this is required, not
optional, under this project's Prisma 7 + `@prisma/adapter-pg` setup
(confirmed by a real-Postgres repro, not just theoretical).

### `categoryService` — `src/services/categories/categoryService.ts`

Pure catalog CRUD for categories — no month-awareness at all. Deps: `prisma`.

| Function | Does |
|---|---|
| `listCatalog(userId)` | Every category for this user. |
| `findManyByIds(ids)` | Batch lookup for DataLoader use. |
| `createCategory(userId, input)` | Requires `budgetType` when `direction: 'expense'`; not meaningful (and stored `null`) for `'income'`. |
| `updateCategory(userId, id, input)` | Blocks a `direction` change if any `Transaction` or `RecurringExpense` already references this category — a `RecurringExpense` derives every future payment's direction from its category (see `markRecurringPaid`), so a never-paid one (zero Transactions yet) must block the change too, not just a paid one. Runs under `lockCategoryRow` inside one transaction, so this can't race a concurrent write that reads or depends on this category's `direction` — see below. |
| `deleteCategory(userId, id)` | Hard delete, blocked while any `category_month` row references it, for any month past or future. |

Also exports **`assertOwnedCategory(client, userId, id)`** standalone — the
shared ownership-check, reused by `categoryMonthService` and
`recurringExpenseService` against either the outer `prisma` or a
transactional client — and **`assertValidBudgetType(direction, budgetType)`**
standalone, reused by `authService`'s default-category seeding on signup so
a future change to this rule can't silently drift from what gets seeded.

Also exports **`lockCategoryRow(client, id)`** (`SELECT ... FOR UPDATE`),
same pattern as `lockBudgetMonthRow`/`lockSavingsFundRow` — a Category's
`direction` is read by `transactionService` (deriving a new Transaction's
direction) and `recurringExpenseService` (validating a RecurringExpense's
category, at both create and update) and written by `updateCategory`;
every one of those call sites takes this lock first, so a direction flip
can never race a concurrent create/update that depends on the pre-flip
value. Found and closed during a whole-codebase audit, round 2 — see
`PROGRESS.md`.

### `categoryMonthService` — `src/services/categories/categoryMonthService.ts`

The real per-month join — a category is "active" in a month iff a row
exists here. Owns the month's budget. Deps: `prisma`, `budgetMonthService`,
`now?` (defaults to the real clock; overridable for tests).

| Function | Does |
|---|---|
| `listByMonth(userId, month, direction?)` | Every active category for that month; `direction?` optionally filters to `'expense'` or `'income'`, resolved through each row's own `Category.direction` (a second, small `category.findMany` lookup by id — not pushed into the `categoryMonth` query itself). Powers `Query.categoryMonths`' `direction` arg — see "Income" note below. |
| `findManyByIds(ids)` | Batch lookup for DataLoader use. |
| `addCategoryToMonth(userId, categoryId, month, monthlyBudgetCents?)` | Explicit activation; errors if already active that month (`category_month_already_active`). `monthlyBudgetCents` is optional — inherits the category's most recent (by real calendar month, not insertion order) `category_month`'s budget when omitted, or throws `category_month_budget_required` if this category has never been active anywhere yet. Rejects a genuinely new activation more than one month past the derived current month (`category_month_beyond_planning_horizon`) — see below. When this call is the one that creates the target month's `BudgetMonth` row for the first time, also fires `onNewBudgetMonth` (an injected dep, wired to `recurringExpenseService.seedNewMonth` in `server.ts`) after the transaction commits. If a concurrent `removeCategoryFromMonth` cascade-deletes the category between the ownership check and the insert, throws `category_not_found` (via `categoryMonthCreateFkError`, shared with `ensureActiveForCategoryOnClient` below) rather than a misleading `budget_month_not_found`. |
| `removeCategoryFromMonth(userId, categoryMonthId)` | Hard delete, blocked while any transaction references it that month (`category_month_has_transactions`) or any `recurring_expenses` row references it (`category_month_has_recurring_expenses` — recurring expenses have no `categoryMonthId` FK, so this checks by matching `categoryId`+`monthId`). If this was the category's last remaining `category_month` row anywhere (past or future), also hard-deletes the underlying `Category` in the same transaction — the mobile client never manages the global catalog directly, only ever through a month, so a category with zero active months would otherwise become permanent, invisible clutter with no UI that could reach it again. Reuses `deleteCategory`'s own "any category_month left" check; a category with real transaction history elsewhere is unreachable by this cascade, since that history's own `category_month` row can never be removed in the first place. In the rare case a concurrent `addCategoryToMonth`/`createRecurringExpense` reactivates the category between the check and this cascade delete, the cascade is silently skipped (not an error) — the user's actual request (removing this month) already succeeded and remains valid regardless. |
| `updateCategoryMonthBudget(userId, categoryMonthId, monthlyBudgetCents)` | This month's budget only. |

**Income has no dedicated table or service** — `PLAN.md`'s original
`income_sources` sketch (step 7) was dropped before any code existed for
it, superseded by reusing this exact machinery: an income-direction
`Category` (e.g. "Salary"), activated into a month via `addCategoryToMonth`
same as any expense category (`monthlyBudgetCents` doubling as "expected
amount"), with each paycheck logged as a normal `Transaction`. The
`GraphQL.CategoryMonth.actualAmountCents` field (`SUM` of that
`CategoryMonth`'s transactions, computed at read time — see below) is
direction-agnostic: "spent so far" for expense, "received so far" for
income. See `PLAN.md`'s Data Model section for the full reasoning.

Also exports **`ensureActiveForCategoryOnClient(client, userId, categoryId, month, monthlyBudgetCents?, now?)`**
standalone — lets a caller with its own open transaction (e.g.
`recurringExpenseService`) run activation as part of that transaction, so a
row lock taken earlier in the same transaction actually protects this step
too. Returns `{ categoryMonth, monthWasCreated }` — `monthWasCreated` is
true only when *this call* created the `BudgetMonth` row, letting
`recurringExpenseService` decide whether to seed the new month.

**Planning horizon.** A category can never be newly activated outside
`[current, current + 1]` — the derived "current" month itself, or the one
right after it, never further ahead and never in the past (see
`budgetMonthService` below for "current") — PLAN.md's Month Lifecycle rule,
enforced server-side via `assertWithinPlanningHorizon(currentMonth, month)`.
It's a pure sync comparison, not a query — every call site must derive
`currentMonth` via `findCurrentMonthOnClient` itself, and must do so
*before* calling `resolveBudgetMonthId` for the target month:
`resolveBudgetMonthId` upserts (permanently creates) a `BudgetMonth` row for
that month, and since a freshly created row is always unlocked, calling it
ahead of the check would let a rejected month leak a permanent row anyway.
For a rejected *past* month specifically, that stray row would go on to
become the new "earliest unlocked" row itself — silently dragging "current"
backwards for every later call this user makes, no concurrency required.
(This was caught by `pr-reviewer` before merge, via exactly that two-call
sequential repro — not a race, a deterministic bug in the original
future-only version of this check.) `ensureActiveForCategoryOnClient`
determines the idempotent-return case (category already active this month)
via a read-only `budgetMonth.findUnique` lookup, specifically so that path
also never triggers `resolveBudgetMonthId`'s upsert before the horizon
check has had a chance to reject. Exported standalone so
`recurringExpenseService`'s auto-activation path enforces the identical
rule, not a separately-maintained copy.

### `transactionService` — `src/services/categories/transactionService.ts`

CRUD for individual transactions. `direction` is always server-derived from
the category, never client-settable. Deps: `prisma`, `budgetMonthService`.

| Function | Does |
|---|---|
| `create(userId, input, recurringExpenseId?)` | The third param is internal-only (never client-settable) — only `markRecurringPaid` passes it, to link the transaction to a recurring expense. Rejects a `date` outside the target CategoryMonth's own month (`date_month_mismatch`) — a transaction can't be dated into a different calendar month than the CategoryMonth it's linked to. |
| `update(userId, id, input)` | Re-derives `direction` if `categoryMonthId` changes to a different-direction category. Same `date_month_mismatch` check as `create`, against the (possibly new) target CategoryMonth. |
| `deleteTransaction(userId, id)` | Hard delete, immediate and permanent, no undo. |
| `list(userId, month, categoryId?)` | Ordered date DESC, then createdAt DESC. |
| `listByCategoryMonthIds(ids)` | Batch lookup for DataLoader use. |
| `listByRecurringExpenseIds(ids)` | Batch lookup for DataLoader use — backs `RecurringExpense.transactions` and `paidThisMonth`. |

All writes are blocked once the target month is locked (`month_locked`) —
live and race-safe as of `budgetMonthService.lockMonth` (Build Order step
5): `create`/`update`/`deleteTransaction` all run inside a transaction
that takes `lockBudgetMonthRow` (`SELECT ... FOR UPDATE`) before checking
`locked`, so the check is genuinely serialized against a concurrent
`lockMonth` call rather than racing a plain read.

### `recurringExpenseService` — `src/services/recurringExpenses/recurringExpenseService.ts`

One flat row per recurring expense per month it exists in — no separate
template, unlike the superseded template/instance design (see `PLAN.md`'s
Data Model section). Hard-deleted, FKs to both `budget_months` and
`categories` directly. This is what a `Transaction` actually links to via
`markRecurringPaid`. Deps: `prisma`, `budgetMonthService`,
`transactionService` (does **not** depend on `categoryMonthService` as an
injected service — it calls `ensureActiveForCategoryOnClient` directly
instead, so the whole activate → insert sequence runs in one transaction).

| Function | Does |
|---|---|
| `createRecurringExpense(userId, input, month, categoryMonthlyBudgetCents?)` | Validates amount/dueDay/budgetType (`need`\|`want` only — `savings` rejected) and that the category is `expense`-direction; auto-activates the category for `month` (budget required only if not already active anywhere). Rejects a duplicate name in the same month (`duplicate_name`, backed by `@@unique([monthId, name])`). If this call is also the one that creates `month`'s `BudgetMonth` row for the first time, carries every recurring expense from the previous month forward into it too (see `seedNewMonth` below) — run after this call's own transaction commits, not nested inside it. |
| `updateRecurringExpense(userId, id, input)` | A flat edit — name/category/budgetType/dueDay/amountCents together, on exactly this one row/month. No propagation question (unlike the superseded design): it never touches any other month's row. Changing `categoryId` auto-activates the new category for this same month (inherits budget, no budget param on this mutation). |
| `removeFromMonth(userId, id)` | Hard delete, blocked while any transaction references it. |
| `markRecurringPaid(userId, id, input)` | Always creates a **new** `Transaction` (never updates one) — callable more than once per row for split payments. |
| `listByMonth(userId, month)` | Every recurring expense for that month. |
| `findManyByIds(ids)` | Batch lookup for DataLoader use. |
| `sumCommittedCentsForCategoryMonth(categoryId, monthId)` | Sums `amountCents` across every recurring expense under that category/month — backs `CategoryMonth.recurringCommittedCents`. |
| `seedNewMonth(userId, month, monthId)` | The automatic carry-forward (see `PLAN.md`'s Data Model note: unlike category/budget carry-forward, no per-item opt-in). Copies every recurring expense from the calendar-previous month into `month` — fresh, unpaid, auto-activating each one's category (inherits budget). No-ops if the previous month doesn't exist, has nothing to copy, or — an extremely narrow race — `month` got locked in the gap between its own creation and this call running. Called by `createRecurringExpense` above and by `categoryMonthService.addCategoryToMonth`'s `onNewBudgetMonth` hook — whichever action first touches a brand-new month triggers it, not just recurring-expense-specific ones. |

Both `createRecurringExpense` and `seedNewMonth` auto-activate categories via
`ensureActiveForCategoryOnClient` — the one deliberate exception to
categories' otherwise-always-manual activation rule (see `PLAN.md`).

### `savingsFundService` — `src/services/savings/savingsFundService.ts`

CRUD for savings goals — unrelated to any single month (see `GLOSSARY.md`'s
"Category vs. Savings Fund"). Hard-deleted, no soft-delete, matching every
other entity in this app. Deps: `prisma`.

| Function | Does |
|---|---|
| `listCatalog(userId)` | Every fund for this user. |
| `findManyByIds(ids)` | Batch lookup for DataLoader use. |
| `createSavingsFund(userId, input)` | `initialBalanceCents` required (can be 0); `targetAmountCents`/`monthlyTargetCents`/`startDate`/`endDate` all optional. Rejects a negative amount (`invalid_amount`), a malformed date (`invalid_date`), or `endDate` before `startDate` (`invalid_date_range`). |
| `updateSavingsFund(userId, id, input)` | Same validation as create, minus `initialBalanceCents` — that field isn't in the input type at all, so it can never change after creation (see the type's own doc comment for why: `currentAmountCents` derives from it, and letting it drift would corrupt every movement already logged against the fund). |
| `deleteSavingsFund(userId, id)` | Hard delete, blocked while any movement references it (`fund_has_movements`). |

`currentAmountCents` and `achieved` are **not** columns on `SavingsFund` —
both are computed at read time by `savingsMovementService`, same
"never let a derived value drift out of sync" reasoning as
`recurringCommittedCents`/`paidThisMonth`.

### `savingsMovementService` — `src/services/savings/savingsMovementService.ts`

CRUD for deposit/withdrawal events against a fund — same relationship to
`SavingsFund` as `Transaction` has to `CategoryMonth`. Every write
(create/update/delete) re-validates that the fund's resulting balance can
never go negative — "you can't withdraw money you don't have" is a standing
invariant, not just checked at creation. Deps: `prisma`.

| Function | Does |
|---|---|
| `createSavingsMovement(userId, input)` | Validates a positive `amountCents` and a well-formed `date`; rejects a withdrawal (or deposit shrinkage — n/a here) that would leave the fund's balance negative (`insufficient_funds`). |
| `updateSavingsMovement(userId, id, input)` | `amountCents`/`type`/`date` editable; `fundId` deliberately isn't — a movement can't be reassigned to a different fund (that's really two funds' balances changing atomically, out of scope for now). Recomputes the resulting balance with the edit applied (excluding the row's own prior contribution) and rejects if it would go negative. |
| `deleteSavingsMovement(userId, id)` | Recomputes the resulting balance with the row's contribution removed entirely and rejects (`insufficient_funds`) if that would go negative — e.g. deleting a deposit a later, still-logged withdrawal already depends on. |
| `listByFundIds(fundIds)` | Batch lookup for DataLoader use — backs `SavingsFund.movements`. |
| `computeCurrentAmountCents(fundId, initialBalanceCents)` | `initialBalanceCents` + the net of every movement against the fund (deposits positive, withdrawals negative). Computed fresh, never stored. |

Every write path takes a row lock (`SELECT ... FOR UPDATE` on the fund,
`lockSavingsFundRow`, same pattern as `lockBudgetMonthRow`) before computing
the resulting balance — so two concurrent movements against the same fund
can never both read the same "current balance" and both think an overdraft
is safe. Verified against real Postgres with a genuine concurrent race (two
simultaneous withdrawals that are each individually safe but would overdraw
together) — exactly one succeeds, the balance never goes negative.

### `bankBalanceService` — `src/services/bankBalance/bankBalanceService.ts`

A running total independent of any month, anchored to a checkpoint stored on
the `User` row itself — not a stored, incrementally-maintained balance.
Deliberately unrelated to `savingsFundService` — Savings Fund
deposits/withdrawals never affect this number. Deps: `prisma`, `now?`
(defaults to the real clock; overridable for tests).

| Function | Does |
|---|---|
| `getBankBalance(userId)` | Reads the user's checkpoint, then sums every `Transaction` this user has ever created with `createdAt` after `bankBalanceCheckpointSetAt` (income adds, expense subtracts) — anchored on real insertion time, not the transaction's own `date`, so a transaction backdated to before the checkpoint but entered after it still counts. Returns `{ amountCents, checkpointAmountCents, checkpointSetAt }`. |
| `setBankBalanceCheckpoint(userId, amountCents)` | Overwrites both `bankBalanceCheckpointCents` and `bankBalanceCheckpointSetAt` (to now) in one call — no history kept. `amountCents` must be an integer but has **no lower bound** — the one money value in this schema explicitly allowed to go negative, since a real bank account can overdraft. |

A brand-new user who never calls `setBankBalanceCheckpoint` still gets a
sensible balance: the `User` row's checkpoint fields default to `0` /
account-creation time, so `getBankBalance` returns `0 +` every transaction
they've ever logged — no separate "not set yet" state anywhere in the API.
Verified against real Postgres (default balance, checkpoint set, real
transaction sum, negative checkpoint, reset excluding prior transactions).

### `accountService` — `src/services/account/accountService.ts`

GDPR export/right-to-erasure (`PLAN.md`'s "GDPR export/delete" note). Deps:
`prisma`.

| Function | Does |
|---|---|
| `exportUserData(userId)` | Returns account info (email, `createdAt`, bank balance checkpoint) plus every domain row the user owns — categories, budget months, category-months, transactions, recurring expenses, savings funds/movements. Throws `AccountServiceError('account_not_found')` if the user doesn't exist. |
| `deleteAccount(userId)` | Hard-deletes everything for that user in one transaction. Every domain table has an `onDelete: Restrict` FK back to `User` (see `PLAN.md`'s GDPR note), but `Restrict` doesn't auto-delete anything, so this still can't rely on cascade — it's a DB-level backstop confirming the ordering below is correct, not the deletion mechanism. Deletes in dependency order — savings movements, transactions, savings funds, recurring expenses, category-months, categories, budget months, then `otp_codes` matching the account's email (keyed by email, not `userId`, so outside the normal chain) — before finally deleting the `User` row itself (which cascades the last refresh tokens). A stray row somehow still referencing the user at that final step now fails loudly with `P2003` (left to propagate, not caught) instead of the delete silently succeeding and orphaning it. Verified against real Postgres, not just the fake, given how many `Restrict` FKs the ordering has to walk through correctly. |

---

## Supporting libs — `src/lib/`

Not services (no `userId`-scoped business logic), but worth knowing exist:

| File | Exports |
|---|---|
| `prisma.ts` | `createPrismaClient(databaseUrl)` — Prisma 7 client via `@prisma/adapter-pg`. |
| `jwt.ts` | `signAccessToken`/`verifyAccessToken` — jose, HS256. `resolveBearerUserId(request, secret)` — extracts + verifies the bearer token from a Fastify request's Authorization header, returns `userId` or `null`; shared by every authenticated REST route that isn't itself part of the OTP/token-issuing flow (`logout-all`, `account` export/delete). |
| `otp.ts` | `generateOtpCode`/`hashOtpCode`/`verifyOtpCode`/`OTP_CODE_REGEX` — argon2. |
| `refreshToken.ts` | `generateRefreshToken`/`hashRefreshToken` — sha256 (already high-entropy, unlike OTP codes). |
| `email.ts` | `EmailService` interface + `createConsoleEmailService` (logs instead of sending — real provider deferred per `PLAN.md`). |
| `env.ts` | `loadEnv` — Zod-validated env vars, fails fast at startup. |
| `monthFormat.ts` | `isValidMonthFormat`/`formatMonth`/`addMonths` — the one place `"YYYY-MM"` parsing/formatting/arithmetic lives. |
| `prismaErrors.ts` | `hasPrismaErrorCode(error, code)` — matches Prisma's error shape without importing the class. |
| `prismaSavepoint.ts` | `withSavepoint(tx, name, attempt)` — runs `attempt` under a Postgres `SAVEPOINT` so a caught conflict (unique/FK violation) doesn't poison the rest of an enclosing `$transaction`. Required, not optional, for any "create, catch a conflict, keep querying the same transaction" pattern under this project's Prisma 7 + `@prisma/adapter-pg` setup — confirmed by a real-Postgres repro (a plain try/catch-then-query reliably throws `25P02`), not just theoretical. Used by `budgetMonthService.resolveBudgetMonthIdWithCreatedFlag`, `categoryMonthService.ensureActiveForCategoryOnClient`, and `recurringExpenseService.seedNewMonth`. |
| `shutdown.ts` | `createShutdownHandler` — `SIGTERM`/`SIGINT` + crash handlers. |

---

## Dev scripts

| Command | Does |
|---|---|
| `npm run seed` (`prisma/seed.ts`) | Populates a dedicated `seed@example.com` account with realistic categories, a "Fixed Bills" category of recurring bills, and income categories — no transactions, savings funds, or bank balance checkpoint (out of scope, see `PLAN.md`'s Build Order step 8). Idempotent: deletes and recreates that one account's data every run. Goes through the real service layer, not raw inserts. Never run against anything but a local/dev database. |
| `npm run graphql:codegen` (`codegen.ts`) | Regenerates `src/generated/graphql.ts` from `src/graphql/schema.ts`'s SDL — see the GraphQL section above. Runs automatically via `postinstall`; only needed manually after editing the schema mid-session without reinstalling. |

---

## API Endpoints

### REST — Fastify (`src/routes/auth.ts`, `src/routes/account.ts`, `src/server.ts`)

All bodies are Zod-validated; a validation failure returns `400 { error: "validation_error", issues }`.

| Method & Path | Body | Success | Notes |
|---|---|---|---|
| `POST /auth/request-otp` | `{ email }` | `200` | Rate-limited 3/15min by IP+email. Always `200` regardless of whether the email exists (no enumeration). Also piggybacks `authCleanupService.cleanupExpiredAuthRecords()` (see Services above). |
| `POST /auth/verify-otp` | `{ email, code, deviceLabel? }` | `200 { accessToken, refreshToken, user }` | Rate-limited 10/15min by IP+email (secondary backstop — `failedAttempts` on the code itself caps guesses at 5). `401` with a specific `error` code on failure (`code_not_found`\|`code_expired`\|`too_many_attempts`\|`incorrect_code`). |
| `POST /auth/refresh` | `{ refreshToken }` | `200 { accessToken, refreshToken }` | Mandatory rotation — old token is revoked, reusing it fails. `401 { error: "refresh_token_invalid" }` on failure. |
| `POST /auth/logout` | `{ refreshToken }` | `204` | Revokes one refresh token. |
| `POST /auth/logout-all` | — (Bearer access token) | `204` | Revokes every refresh token for the authenticated user. `401` if the access token is missing/invalid. |
| `GET /account/export` | — (Bearer access token) | `200` — full JSON export | GDPR export (see `accountService` above). Rate-limited 5/15min (defense-in-depth against a leaked token, not the primary defense). `401` if unauthenticated, `404 { error: "account_not_found" }` if the account no longer exists. |
| `DELETE /account` | `{ confirm: true }` (Bearer access token) | `204` | GDPR right-to-erasure (see `accountService` above) — permanent, no undo. `confirm: true` is required in the body as a deliberate extra guard beyond just a valid token, given this is the single most destructive action in the app. Rate-limited 5/1hour. `401` if unauthenticated, `400` if `confirm` isn't `true`, `404 { error: "account_not_found" }` if the account no longer exists. |
| `GET /health` | — | `200 { status: "ok" }` | Real DB check (`SELECT 1`); `503` on failure. |

### GraphQL — `POST/GET /graphql` (`src/graphql/schema.ts`)

Auth via `Authorization: Bearer <accessToken>`. Every field except
`ping` requires it — unauthenticated requests get `UNAUTHENTICATED`.
Every resolver re-checks `userId` itself (no single top-level auth gate).
Service errors map to `GraphQLError` with `extensions.code` = the service's
error reason, upper-cased (e.g. `category_not_found` → `CATEGORY_NOT_FOUND`).
Query depth (max 10) is limited in every environment; introspection is
additionally disabled in production only.

`Query`/`Mutation` resolvers are typed against `src/generated/graphql.ts`
(gitignored, generated by `codegen.ts` via `graphql-codegen`, regenerated
on `postinstall` alongside the Prisma client) — a resolver that's drifted
from the schema (wrong field name, mismatched arg/return type) is now a
compile error. A brand-new schema field with no resolver at all still
typechecks clean, though (every generated resolver field is optional,
since GraphQL allows a default property-access resolver) — that gap still
only surfaces at request time. Nested-type resolvers (`Category`,
`CategoryMonth`, etc.) still use their own narrow per-field inline typing,
not the generated per-type `Resolvers` — see `PLAN.md`'s "Schema-to-types
safety" note for why (and the residual gap that leaves).

**Query**

| Field | Args | Returns |
|---|---|---|
| `ping` | — | `String!` (no auth required) |
| `currentMonth` | — | `BudgetMonth!` |
| `categories` | — | `[Category!]!` |
| `categoryMonths` | `month: String!, direction: Direction` | `[CategoryMonth!]!` |
| `transactions` | `month: String!, categoryId: ID` | `[Transaction!]!` |
| `recurringExpenses` | `month: String!` | `[RecurringExpense!]!` |
| `savingsFunds` | — | `[SavingsFund!]!` |
| `bankBalance` | — | `BankBalance!` |

**Mutation**

| Field | Args | Returns |
|---|---|---|
| `lockMonth` | `month: String!` | `BudgetMonth!` |
| `deleteBudgetMonth` | `month: String!` | `Boolean!` |
| `createCategory` | `input: CategoryInput!` | `Category!` |
| `updateCategory` | `id: ID!, input: CategoryInput!` | `Category!` |
| `deleteCategory` | `id: ID!` | `Boolean!` |
| `addCategoryToMonth` | `categoryId: ID!, month: String!, monthlyBudgetCents: Int` | `CategoryMonth!` |
| `removeCategoryFromMonth` | `categoryMonthId: ID!` | `Boolean!` |
| `updateCategoryMonthBudget` | `categoryMonthId: ID!, monthlyBudgetCents: Int!` | `CategoryMonth!` |
| `createTransaction` | `input: TransactionInput!` | `Transaction!` |
| `updateTransaction` | `id: ID!, input: TransactionInput!` | `Transaction!` |
| `deleteTransaction` | `id: ID!` | `Boolean!` |
| `createRecurringExpense` | `input: RecurringExpenseInput!, month: String!, categoryMonthlyBudgetCents: Int` | `RecurringExpense!` |
| `updateRecurringExpense` | `id: ID!, input: RecurringExpenseInput!` | `RecurringExpense!` |
| `removeRecurringExpenseFromMonth` | `id: ID!` | `Boolean!` |
| `markRecurringPaid` | `id: ID!, input: MarkRecurringPaidInput!` | `Transaction!` |
| `createSavingsFund` | `input: CreateSavingsFundInput!` | `SavingsFund!` |
| `updateSavingsFund` | `id: ID!, input: UpdateSavingsFundInput!` | `SavingsFund!` |
| `deleteSavingsFund` | `id: ID!` | `Boolean!` |
| `createSavingsMovement` | `input: CreateSavingsMovementInput!` | `SavingsMovement!` |
| `updateSavingsMovement` | `id: ID!, input: UpdateSavingsMovementInput!` | `SavingsMovement!` |
| `deleteSavingsMovement` | `id: ID!` | `Boolean!` |
| `setBankBalanceCheckpoint` | `amountCents: Int!` | `BankBalance!` |

**Types**: `Category`, `CategoryMonth` (+ computed `actualAmountCents`,
`recurringCommittedCents`), `Transaction` (+ nullable `recurringExpense`),
`RecurringExpense` (+ computed `paidThisMonth`, `dueDate` — combines the
stored `dueDay` (1-31) with this row's own month, clamped to that month's
last day if `dueDay` doesn't fit), `SavingsFund` (+ computed
`currentAmountCents`/`achieved`), `SavingsMovement` (+ `fund` back-reference,
mirroring `Transaction.categoryMonth`), `BankBalance` (+ computed
`amountCents`; the only type not tied to a month or another entity — tied
to the user's account itself). Enums: `BudgetType`
(`NEED`\|`WANT`\|`SAVINGS`), `Direction`
(`EXPENSE`\|`INCOME`), `MovementType` (`DEPOSIT`\|`WITHDRAW`) — DB stores
lowercase, GraphQL exposes upper-case, mapped in `enumMapping.ts`.

**DataLoaders** (`src/graphql/loaders.ts`, rebuilt fresh per request — never
cached across requests/users): `categoryById`, `categoryMonthById`,
`budgetMonthById`, `transactionsByCategoryMonthId`, `recurringExpenseById`,
`transactionsByRecurringExpenseId`, `recurringCommittedCentsByCategoryMonthId`,
`savingsFundById`, `movementsBySavingsFundId`, `currentAmountCentsBySavingsFundId`.
