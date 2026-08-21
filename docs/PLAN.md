# Budget Tracker — Project Plan

## Overview

A budget/savings tracker, built API-first for real production use (not just a local single-device app). Backend with a proper database and GraphQL API comes first; the mobile app and later a website are both clients of that same API. Portfolio piece, but designed to actually be deployed, used by multiple people, and handed off cleanly to another engineer (or LLM) later without accumulated mess.

## How We Work With Claude Code

Goal: maximize correct, scalable engineering from day one, so tech debt and bad architecture don't accumulate — the codebase should stay something any engineer (or another LLM) can pick up cleanly. These practices are also encoded as standing rules in `CLAUDE.md` (read automatically by Claude Code every session) — the list below is the reasoning behind them.

1. **Shared design concept before code ("grill me")**: before starting a new module or feature, ask Claude Code to interview you on the details and edge cases first — don't let it jump straight from a one-line request to code. The goal is a shared mental model of the design before anything gets written, not just a plan you skim and approve.

2. **Ubiquitous language**: keep a `GLOSSARY.md` in the repo defining domain terms precisely (what counts as a "transaction" vs a "movement", what `budgetType` values mean, what "achieved" means for a fund, etc.). Point Claude Code at it in prompts so terminology stays consistent across conversations, the GraphQL schema, and the code — avoids drift and misunderstandings compounding over time.

3. **Small feedback loops (TDD)**: for each resolver or mutation, write a failing test first, then implement to make it pass, then refactor. Use Jest with `ts-jest` (or a babel TS preset) so tests run against TypeScript directly. Don't ask for a whole module in one big generation — work through the Build Order steps below in small, verifiable increments so bugs get caught immediately instead of compounding.

4. **Deep modules, simple interfaces**: each domain area (categories, transactions, recurring, funds, income) should be a module with a small, well-defined interface (e.g. a service layer with typed functions) hiding Prisma/DB details. Resolvers call service functions — they don't touch Prisma directly inline. Prefer fewer, well-designed modules over many shallow files each exposing complexity.

5. **Design the interface, delegate the implementation**: you own the GraphQL schema, service function signatures, and Prisma schema shape — decide and review these deliberately. Delegate the internal implementation of each function to Claude Code once the interface is agreed, and review at that interface level rather than line-by-line every time.

6. **Treat system design as ongoing, not a one-time step**: whenever a change touches a module's interface (not just its internals), call that out explicitly in the prompt before asking for the change, so it gets the same design scrutiny as new work — this is what prevents architecture quietly rotting as features get added.

7. **Frontend work — never invent, always ask**: for every piece of FE work (each screen, each component), Claude Code must ask for every relevant detail first — exact layout, states, copy, colors, spacing, behavior on edge cases — and wait for your answer instead of guessing or filling gaps with a "reasonable" default. Before starting the mobile app specifically, it must ask you for the design references (the mockup screenshots + the Excel structure) rather than proceeding from memory of this conversation alone.

## Architecture Decision: GraphQL

Going with GraphQL from the start, since the API is being built once and used by both the mobile app and (later) the website — worth taking on the extra setup now rather than migrating later. Two things to get right from day one to avoid the usual GraphQL footguns:

- **N+1 queries**: use DataLoader for every relation a resolver can traverse (e.g. category → transactions, fund → movements). Batch and cache within a single request.
- **Auth per field, not just per request**: every resolver that touches user-owned data re-checks `user_id` from the authenticated context — don't rely on a single top-level check.

## Roadmap (phases)

1. **Phase 1 — Backend (API + DB)**: Node.js + Fastify, PostgreSQL, Prisma ORM, passwordless email OTP + JWT auth. Multi-user from day one (every table scoped by `user_id`).
2. **Phase 2 — Mobile app**: React Native app consuming the API directly (no local SQLite as source of truth — API is the source of truth, app can cache/queue for offline later if needed).
3. **Phase 3 — Website**: web client consuming the same API. Little to no backend work needed at this point.

## Tech Stack (Phase 1 — Backend)

- **Runtime**: Node.js + TypeScript
- **Framework**: Fastify
- **GraphQL server**: GraphQL Yoga (plugs cleanly into Fastify, lighter than Apollo Server) or Mercurius (Fastify-native GraphQL plugin, also a solid option — pick one, both fine)
- **Database**: PostgreSQL
- **ORM**: Prisma (schema-driven, generates TS types, handles migrations, pairs well with DataLoader for resolvers)
- **Batching**: DataLoader on every relation-traversing resolver
- **Auth**: passwordless, email OTP (no passwords stored at all). Short-lived access JWT (5-15 min) + refresh token persisted per-device in the DB (revocable — "log out this device")
- **Validation**: Zod on all route inputs, and Zod-validated env vars at startup — fail fast on a missing/malformed env var instead of crashing cryptically mid-request later
- **Security headers**: `@fastify/helmet` — sets HSTS, X-Content-Type-Options, and the other baseline headers, one line to add, no reason to skip it
- **Schema-to-types safety** — **built**: GraphQL Code Generator (`codegen.ts`) generates `src/graphql/schema.ts`'s SDL into `src/generated/graphql.ts` (gitignored, regenerated via `postinstall` alongside `prisma generate` — same convention as the Prisma client, so CI needs no extra step). `Query`/`Mutation` are typed against the generated `QueryResolvers`/`MutationResolvers`, so a resolver that exists but has drifted from the schema (a typo'd field name, a mismatched arg/return type) is now a compile error, not a silent runtime bug; the seven hand-rolled `*GraphQLInput` interfaces this replaced are gone, inferred instead. **Caveat, confirmed by actually testing it**: every generated resolver field is optional (GraphQL allows a field to fall back to a default property-access resolver), so a *brand-new* schema field added with no resolver at all still typechecks clean — that failure mode only ever surfaces at request time, same as before this change. The safety net is for resolvers that exist and have drifted, not for forgetting to add one. `mappers` config points each object type at the domain-shaped type actually flowing through resolvers (Prisma model types for most; `bankBalanceService`'s own `BankBalance` interface, since that type is computed, not a table) rather than the final GraphQL-shaped type — every resolver here returns Prisma-ish rows and converts enums/dates per-field in nested resolvers, not before returning, so without `mappers` every resolver fails to typecheck against the schema's actual (uppercase-enum, no-timestamps) shape. `BudgetMonth` deliberately left unmapped — its GraphQL type is only `{ month, locked }` with no nested resolvers, and `findCurrentMonth` can synthesize a row that was never persisted, so the default plain generated type is the only accurate parent shape. Nested-type resolvers (`Category`, `CategoryMonth`, etc.) keep their existing narrow per-field inline typing rather than being retyped against the generated per-type `Resolvers` — a residual, known gap (a new schema field on one of these types wouldn't force a matching resolver) not closed by this pass.
- **Testing**: Jest + ts-jest
- **Local dev DB**: PostgreSQL via Docker Compose (requires Docker installed on your machine — Claude Code writes the `docker-compose.yml`, but it needs Docker itself already present to run it)
- **Hosting (when you deploy)**: no decision needed now. Start on Railway/Render (free/cheap tier, zero ops burden while there are no real users yet), keep the architecture portable (plain Docker, Prisma, env vars, nothing platform-specific). See `SCALING.md` for the growth path (VPS migration, horizontal scaling, DB migration) — not relevant until there's real traffic.

## System Design Notes

- **Multi-tenancy**: every table has `user_id`; every query filters by the authenticated user. This is the single most important thing to get right before this goes live.
- **Indexes**: `(user_id, date)` on transactions — you'll filter by user + month constantly. `savings_movements` shipped as `(fund_id, user_id)` instead (step 6, corrected during a whole-codebase audit — see PROGRESS.md) — the actual query patterns filter by `fund_id` alone, not by `user_id` and not by a date range (`computeNetMovementCents`/`listByFundIds`), so `fund_id` leads (an index led by a column the query never filters on doesn't serve it directly, even if both columns are present); `user_id` trails for any future userId-scoped lookup. A `(user_id, date)` shape would only matter for a "movements across all funds in a date range" query that doesn't exist yet. Also index `otp_codes.email` (looked up on every verify) and `refresh_tokens.token_hash` (looked up on every refresh) — both are hit on the hot path of every login/refresh, not just occasional queries. `otp_codes.expires_at`/`used` and `refresh_tokens.expires_at`/`revoked` are indexed too (added alongside `authCleanupService`, see "Row cleanup" below) — without them, its batched cleanup queries degrade to a full table scan as these tables grow.
- **Migrations**: versioned from commit 1 via Prisma, never hand-edit the DB schema directly.
- **Config**: env vars for dev/staging/prod, nothing hardcoded (DB connection string, JWT secret).
- **Auth boundary**: every non-auth route/resolver requires a valid access JWT, checked once in a shared context builder — resolvers read `userId` from context, they don't re-verify tokens themselves.
- **CORS**: the website (phase 3) will hit the API from a browser, so explicit CORS config (allowed origins) is needed — the mobile app isn't subject to CORS, but the browser client is. Configure this even in phase 1 so it's not a surprise later.
- **Health check**: a plain `GET /health` route returning 200 once the DB connection is confirmed — most hosting platforms (Railway, Render, Fly) use this to know your API is alive before routing traffic to it.
- **Connection pooling (later, not phase 1 priority)**: given you're deploying a traditional long-running Node process (Railway/Render-style, not serverless), this isn't urgent — a small, stable pool is fine. See `SCALING.md` for when and how this becomes relevant.
- **Atomicity (DB transactions)**: any mutation that writes more than one row, or that needs to check a computed value before writing, must wrap that in a Prisma transaction (`prisma.$transaction`), so a crash halfway can't leave inconsistent data. `markRecurringPaid` (inserts a transaction linked to the recurring item) is one. `createSavingsMovement`/`updateSavingsMovement`/`deleteSavingsMovement` are another — `currentAmountCents` isn't a stored column (see the Data Model revision note), so there's no second row to keep in sync, but the overdraft check (recomputing the fund's resulting balance) and the movement write still need to happen under one row lock on the fund (`SELECT ... FOR UPDATE`), or two concurrent movements could both read the same balance and both think an overdraft is safe.
- **Overdraw rule on savings movements — confirmed, built as designed**: a withdrawal (or an edit/delete that would have the same effect) larger than the fund's current balance is rejected with `insufficient_funds` in the service layer — negative fund balances aren't allowed. Verified against real Postgres with a genuine concurrent race (two withdrawals each individually safe but together overdrawing) — exactly one succeeds.
- **Graceful shutdown**: handle `SIGTERM` to stop accepting new requests, let in-flight ones finish, and close the Prisma connection pool cleanly before exiting — without this, every redeploy on Railway/Render can drop requests mid-flight.
- **Crash handling**: register `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers that log the error (to Sentry) before exiting — better than the process silently limping in a broken state or dying with no trace.
- **Request tracing**: Fastify/pino support a request ID on every log line by default — keep this on, it's what makes debugging a specific failed request in production possible instead of grepping through unrelated interleaved logs.
- **Schema evolution**: when a GraphQL field needs to change or go away, mark it `@deprecated(reason: "...")` and keep it working for a transition period rather than breaking it outright — GraphQL's equivalent of API versioning, relevant once the mobile app and website are both depending on the same schema.

## Data Model (PostgreSQL / Prisma, Phase 1)

> **Money convention**: every monetary value is stored and transmitted as an **integer number of cents** (`amount_cents`, `Int` in GraphQL) — never `Float`/`Decimal` for the wire format. Floats accumulate rounding errors over thousands of transactions; storing cents as integers avoids that class of bug entirely. The frontend (mobile/web) multiplies by 100 before sending and divides by 100 for display — that conversion lives only at the UI edge, never inside the API or DB layer.

> **Timestamps**: every table below gets `created_at` and `updated_at` (Prisma: `@default(now())` / `@updatedAt`) even where not listed explicitly — omitted per-table below to avoid repetition, but it's not optional. Useful for debugging, ordering, and any "recently added" view later.

> **Dates**: `date` fields (on `transactions`, `savings_movements`) and `start_date`/`end_date`/`due_day` are calendar dates, not timestamps — no time-of-day component, no timezone conversion to worry about. Use Postgres `date`, not `timestamp`. **Validate the format on input**: reject anything that isn't a bare `YYYY-MM-DD` (Zod `.regex(/^\d{4}-\d{2}-\d{2}$/)`, or a custom `Date` GraphQL scalar) so a client can't accidentally send a full ISO timestamp like `2026-08-17T15:32:00Z` and get a silently truncated or timezone-shifted value stored.

**users**

- id (pk)
- email (unique)
- created_at
- bank_balance_checkpoint_cents (integer — cents, default 0) — see "Bank balance" below
- bank_balance_checkpoint_set_at (timestamp, default now()) — see "Bank balance" below

> **Bank balance** — grilled and built (step 7 follow-up, deliberately shipped as its own step after the income pivot rather than bundled with it — see PROGRESS.md). A running total independent of any one month, and deliberately unrelated to Savings Funds — not netted together. Explicit user call: money moved into a Savings Fund is still "yours", just tracked separately (mirrors how they track it in their own Excel — bank money and invested/saved money shown as two separate numbers, specifically to avoid a single blended figure getting confusing once split across many funds).
>
> Computed at read time, not stored — same "never let a derived value drift" reasoning as `achieved`/`paidThisMonth`/`actualAmountCents`: `amountCents = bank_balance_checkpoint_cents + net(every Transaction this user has ever created with created_at > bank_balance_checkpoint_set_at)`. The anchor is each Transaction's real insertion time (`created_at`), not its logical `date` — a Transaction backdated to before the checkpoint but entered *after* it still counts, since the checkpoint means "this is everything I have, as of right now," not "as of this calendar date." `Transaction.userId` already exists (denormalized, same pattern as `savings_movements.user_id`), so no join is needed; a new `@@index([userId, createdAt])` on `transactions` serves this query specifically (a different axis than the existing `(userId, date)` index).
>
> `setBankBalanceCheckpoint` overwrites both fields in place — **no history kept**, same "no undo, single current value" rule as every other entity in this schema; confirmed explicitly rather than assumed, since this is the first place a "keep a log of every edit" question came up outside the already-settled soft-delete-vs-hard-delete debate. **Negative is allowed** — the one exception to every other money field in this app never going below 0 (Savings Funds explicitly can't overdraft; this can, since a real checking account can). Defaults (`0` / row-creation time) mean a user who never touches this feature still gets a sensible number: `0 +` every transaction they've ever logged, no separate "not set yet" state to design around.
>
> **Migration caveat (pr-reviewer, PR #17)**: the "no touch needed" default only literally holds for users created *after* this feature ships. `bank_balance_checkpoint_set_at` defaults to the migration's own `ALTER TABLE` timestamp for any user who already existed at deploy time — so on first rollout, an existing user's transactions logged before that moment are excluded from their balance until they call `setBankBalanceCheckpoint` once. A one-time onboarding gap, not a bug — acceptable pre-launch (no real users/data exist yet, per `PROGRESS.md`), but worth a deliberate decision (e.g. a one-off backfill setting existing users' checkpoint to their account `createdAt`) before this ever ships against real user data.
>
> `BankBalance.checkpointSetAt` is a full ISO 8601 timestamp, not a bare `YYYY-MM-DD` — the one field in this schema's GraphQL surface that needs time-of-day, since it anchors an instant, not a calendar day (see the Dates convention note above, which otherwise applies everywhere else).

**otp_codes**

- id (pk)
- email
- code_hash (never store the raw code)
- expires_at (short, e.g. 10 min)
- used (boolean)
- failed_attempts (integer, default 0) — increment on every wrong `verify-otp` call for this code; once it hits a max (e.g. 5), invalidate the code even though it hasn't expired yet, forcing a fresh `request-otp`. Without this, expiry alone still leaves a 10-minute window to brute-force a 6-character code.
- created_at

**refresh_tokens**

- id (pk)
- user_id (fk)
- token_hash
- device_label (nullable) — lets a user see/revoke "iPhone", "Chrome on MacBook", etc.
- expires_at
- revoked (boolean)
- created_at

**budget_months** (one row per user per real calendar month — YYYY-MM, e.g. `"2026-03"`, `"2027-03"` are distinct rows; the app naturally accumulates one of these per month a user has ever had, spanning as many years as they've used it. This is *not* a recurring 1-12 bucket. Tracks lock state; see "Month Lifecycle" below for the full mechanism. Created starting this Build Order step, not step 5 — `category_month`'s FK needs something to point to — but `locked`/`locked_at` sit inert, never set true, until step 5 wires up actual locking.)

- id (pk)
- user_id (fk)
- month (YYYY-MM, unique per user)
- locked (boolean, default false)
- locked_at (nullable)
- created_at

There's no separate "current month" pointer column: the month a user sees is always derived as the earliest month, in chronological order, that isn't locked yet for that user (see "Month Lifecycle" below). If a `budget_months` row doesn't exist yet for a (user, month) pair that's about to be referenced (e.g. adding a category to a month for the first time), the service layer upserts it lazily rather than requiring step 5's full provisioning/carry-forward logic to exist first. Still open: what creates the very *first* `budget_months` row for a brand-new user (e.g. at signup vs. lazily on first request) — decide during that Build Order step, not guessed here.

**categories** (pure catalog — transversal across months, no month-awareness at all: no fields or relations referencing a specific month)

- id (pk)
- user_id (fk)
- name
- icon
- color
- budget_type (nullable; 'need' | 'want' | 'savings' — your 50/30/20 classification; required only when `direction = 'expense'`, not meaningful for `'income'`)
- direction ('expense' | 'income') — fixed once transactions or recurring expenses exist under this category; `updateCategory` blocks a direction change if any `Transaction` **or `RecurringExpense`** references it, since that would make historical records (or a still-live recurring obligation whose future payments derive their direction from this category) inconsistent with their category — the `RecurringExpense` half of this check was missing until a whole-codebase audit found it (see `PROGRESS.md`), since a never-paid recurring expense has zero `Transaction` rows to be caught by the original check alone. The check-then-write itself runs under `lockCategoryRow` (`SELECT ... FOR UPDATE`) inside one transaction — same audit found this was otherwise racy against a concurrent `createRecurringExpense`/`updateRecurringExpense`/`transactionService.create`/`update`, all of which now take the same lock before reading/deriving from this category's direction
**No `deleted_at` — hard-deleted, revised (see the callout below).** Deleting a category is only allowed once it has no `category_month` row for any month, past or future — same precondition as before, just no soft-delete step in between. In practice, a category that was ever active in a now-locked past month can never be deleted, since a locked month's rows are immutable — intentional (preserves referential integrity on historical records), flagged here since it's a direct but non-obvious consequence of the locking design below. Once deletable, the delete is permanent — no undo. Migrated in its own follow-up branch/PR after Build Order step 4 merged (`categories` was already-merged code from step 3, so this landed separately rather than bundled into step 4 — see `PROGRESS.md`).

**category_month** (the real join — a category is "active" in a given month iff a row exists here for it; this is where all month-specific state lives, not on `categories`. **Hard-deleted, not soft-deleted** — revised from the original soft-delete design; see the callout below.)

- id (pk)
- user_id (fk) — denormalized for direct scoping, same pattern as `savings_movements.user_id` below
- category_id (fk)
- month_id (fk → `budget_months`)
- monthly_budget_cents (integer — cents; this month's budget for this category. When created via carry-forward from the previous month — step 5 — it inherits that previous month's value by default. When created fresh, with no prior month to carry forward from — the only path that exists in this Build Order step — it must be explicitly provided; there's no zero-default fallback.)

`@@unique([category_id, month_id])` — a real DB constraint, not app-level find-or-reactivate logic. A concurrent second attempt to add the same category to the same month simply fails the constraint. There's no "reactivation" concept: removing a category from a month is a hard delete, so adding it back later is a plain insert, identical to adding it the first time — nothing to distinguish "fresh" from "reactivated."

**Deleting a `category_month` row is only allowed when zero transactions reference it for that month** — if any exist, the delete is rejected and the user has to delete those transactions first. Because a deletable `category_month` row always has zero transactions, hard-deleting it is safe: no live transaction can ever end up pointing at a row that's being removed. Enforce this at the DB level too (`onDelete: Restrict` on `transactions.category_month_id`, not just an app-level pre-check) as a backstop. Removing from a month can optionally also remove the following month's row in the same action, never a past month's (locked/immutable once that month is locked — see "Month Lifecycle" below).

> **`removeCategoryFromMonth` also cascades to `deleteCategory` when the category has zero `category_month` rows left anywhere.** Explicit user call: the client never manages the global `Category` catalog directly — it's only ever touched through a month — so a category with no active months would otherwise sit forever as invisible, unreachable clutter with no UI that could ever delete it. This intentionally gives up the "remove from a month, reactivate the same category later" convenience for a category with no history: once its last `category_month` row is gone, the `Category` itself is gone too, and getting it back means a fresh `createCategory` call (a new row, a new id) — considered and accepted, since a category that reaches zero months this way never had any transactions to lose in the first place (a `category_month` with real transaction history can never be removed to begin with, per the paragraph above, so it — and the `Category` it belongs to — is structurally unreachable by this cascade). See `categoryMonthService.removeCategoryFromMonth` for the implementation, which reuses `deleteCategory`'s own "any `category_month` left" check rather than re-deriving it.

There is no `activate`/bundle-into-`createCategory` behavior: `createCategory` is a pure catalog insert, nothing else. Activating a category for a month (creating its `category_month` row) is always a separate, explicit action — either the month's carry-forward flow (step 5) or a manual "add category to month" call (this step).

**transactions** (**hard-deleted, not soft-deleted** — revised from the original soft-delete design; see the callout below)

- id (pk)
- user_id (fk) — kept as a direct column for defense-in-depth scoping even though it's now reachable transitively via `category_month_id → category_month.category_id → categories.user_id` (two joins away) — same reasoning as `savings_movements.user_id`
- category_month_id (fk → `category_month`, **not** `category_id` directly) — this structurally enforces that a transaction can only exist against a category that was actually active in that specific month; there's no app-level "is this category active this month" check needed, the FK can't reference a `category_month` row that doesn't exist. The transversal view of a category (all its transactions across every month it's ever been active) is still one join away: `transactions → category_month → categories`.
- recurring_expense_id (nullable, fk → `recurring_expenses`; formerly `recurring_expense_instance_id` → `recurring_expense_instances` under the superseded template/instance design, see the Data Model's `recurring_expenses` entry below) — set when this transaction was created via `markRecurringPaid`; this is what `paidThisMonth` actually checks against (a transaction in the same category this month isn't enough — it must be linked to this specific row)
- amount_cents (integer, always positive — always store money as integer cents, never float; the sign/meaning comes from `direction`, not the number; FE multiplies/divides by 100 for display/input)
- date
- merchant (nullable)
- note (nullable)
- direction ('expense' | 'income') — **not client-supplied**: derived and stored from `category_month.categories.direction` at write time, since a transaction can only ever point at one category with one fixed direction. Kept as a denormalized read field for query convenience (filter/sort without an extra join), but `TransactionInput` has no `direction` field at all.

> **Revised: no soft delete, no undo, anywhere in this flow — `categories` included.** `categories`, `category_month`, and `transactions` are all hard-deleted, full stop — no `deleted_at`, no `delete_batch_id`, no undo window, single or bulk. This supersedes the "Soft delete + undo" paragraph of the Month Lifecycle design below as it applied to these entities. Originally `categories` kept its own catalog-level soft delete while `category_month`/`transactions` went hard-deleted (reasoning below still explains *that* half); revisited later in Build Order step 4's review cycle — explicit user call: either something can be deleted (nothing references it, ever) or it's permanently blocked by what references it, with no third "soft-deleted but still around" state for any of these three. `category_month`/`transactions` reasoning, unchanged: keeping `transactions` soft-deleted while `category_month` is hard-deleted would create a dangling-reference trap — a soft-deleted transaction kept around for undo could end up pointing at a `category_month_id` that no longer exists once that row is actually removed. Simplest fix is to not have that class of row at all. `recurring_expense_templates`/`recurring_expense_instances` — grilled during Build Order step 4 — follow the same rule, for the identical reason; see below.

> **Revised — the template/instance split below is superseded.** Kept side by side rather than deleted, since the reasoning for the original split (mirroring `categories`/`category_month`) is still worth having on record. Re-examined during a user "why does this need two tables at all" pushback after step 4 shipped: recurring expenses don't share the property that actually justifies `categories`/`category_month` being split — a category is designed to sit **dormant** in a catalog with no month-awareness, but line 177's original text already said a recurring expense "has no equivalent dormant state — it only exists because you're tracking paying something *now*." A thing that never sits dormant outside a month doesn't need a transversal catalog table representing its month-independent existence. The one thing a shared `template_id` bought — grouping "every Rent payment across all time" for future reporting — was weighed and explicitly rejected as not worth a schema commitment now: recurring expenses are low-volume (a bill occurs at most ~12×/year; even a 10-year history is ~120 rows, "totally negligible" to query for directly by name/category later if ever needed) — unlike categories, which can accumulate thousands of transactions and where a stable id genuinely matters for that reason.
>
> **New design: one flat `recurring_expenses` table, no template.** A recurring expense is just a row that lives *in* a month — name, category, budget amount, and (derived, same as before) whether it's paid — created directly or copied forward from the previous month. No cross-month identity of any kind; each month's row is fully independent, indistinguishable from one entered fresh. If "history of this bill over time" is ever needed later, it's a query against `name`/`category_id`, not a schema change.
>
> ```
> recurring_expenses  (one row per recurring expense per month it exists in)
>   id (pk)
>   user_id (fk)
>   month_id (fk → budget_months)
>   category_id (fk) — an existing, expense-direction category; same invalid_category_direction rule as before
>   name
>   budget_type ('need' | 'want')
>   due_day
>   amount_cents (integer — cents) — this month's amount, period; editing it only ever touches this row
> ```
>
> Hard-deleted, same as `category_month` — deletion blocked while any `Transaction` references it (via `transactions.recurring_expense_id`, replacing `recurring_expense_instance_id`), allowed once none do.
>
> **Carrying forward into a new month is automatic, unlike categories.** Confirmed with the user: whenever a new month comes into existence — whether the user pre-provisioned it ahead of locking the current one, or it's derived as the new current after locking with nothing already provisioned — its `recurring_expenses` rows are copied straight from the previous real month (fresh, unpaid), with no per-item opt-in checklist. This is deliberately *more* automatic than category/budget carry-forward (which stays the existing per-item, opt-in `addCategoryToMonth` flow, see Month Lifecycle below) — recurring expenses are the recurring, low-friction case; categories are the "reconsider your budget every month" case. **Resolved at implementation time**: hooked into the `BudgetMonth` row's creation itself, not `lockMonth` specifically — `resolveBudgetMonthIdWithCreatedFlag` reports whether a given call is the one that actually created the row, and both `addCategoryToMonth` and `recurringExpenseService.createRecurringExpense` fire the carry-forward when it is. Whichever action happens to be the *first* thing to touch a brand-new month — a category add or a new recurring expense, not just locking — triggers the seed, matching "no per-item opt-in" above precisely.
>
> **Category activation is still automatic**, same reasoning as before (a recurring expense has no dormant state, so there's no separate "activate the category" step to force the user through): creating a recurring expense row for a month — directly or via copy-forward — auto-activates its category for that month if not already active, same `categoryMonthlyBudgetCents`-required-if-new rule as before (never derived from the recurring expense's own `amount_cents`, for the same "Housing's total budget ≠ any one bill's amount" reason as originally documented).
>
> **`CategoryMonth.recurringCommittedCents`** (unchanged in meaning): `SUM(amount_cents)` across every `recurring_expenses` row under that category for that month.
>
> **Editing is a single flat edit.** `updateRecurringExpense` changes name/category/budgetType/dueDay/amountCents together, on exactly one month's row. There's no "does this propagate?" question anymore — it never touches any other month's row, and whatever a future copy-forward picks up is simply whatever this row holds at the moment that copy happens.

**recurring_expense_templates** ("Contas" — the recurring definition itself, e.g. "Rent, 800€, day 1"; transversal like `categories`, no month-awareness. **No `deleted_at` — hard-deleted**, matching `categories`' revised rule above — same consequence as before: once a template has ever been carried into a now-locked month, it can never actually be deleted, since the "no instance anywhere, past or future" precondition below can never be satisfied again. Once deletable, permanent, no undo.)

- id (pk)
- user_id (fk)
- name
- amount_cents (integer — cents) — the current default/expected value; new instances (below) snapshot this at creation time unless overridden per-instance; also what `markRecurringPaid` defaults to suggesting, though the actual transaction amount can differ (variable bills — see below)
- category_id (fk) — an *existing* category (e.g. "Housing"); creating a recurring expense never creates a new category; must be an `expense`-direction category (enforced service-side, `invalid_category_direction`) — an income category has no meaning here, since `direction` on the resulting `markRecurringPaid` transaction is derived from it
- budget_type ('need' | 'want')
- due_day

**recurring_expense_instances** (one row per template per month it's carried into — this is what a Transaction actually links to, and what `paidThisMonth` checks against; same `month_id`-over-raw-string pattern as `category_month`, for the same reason. **Hard-deleted**, matching `category_month` — deletion blocked while any Transaction references it, allowed once none do, for the identical dangling-reference reason that applied to `category_month`)

- id (pk)
- user_id (fk)
- template_id (fk)
- month_id (fk → `budget_months`)
- amount_cents (integer — cents) — snapshotted from the template at creation time; can diverge from the template if the user edits just this instance (propagation UX for "apply to future months too" is step 5, same as `category_month`'s budget)

**Recurring expenses vs. transactions — not one-to-one.** Unlike the original assumption, more than one `Transaction` can link to the same `recurring_expense_instance_id` (split payments — e.g. paying rent to a landlord in two installments). There is no uniqueness constraint on `transactions.recurring_expense_instance_id`. `paidThisMonth` is **not** "does any transaction exist" — it's `SUM(linked transactions.amount_cents) >= instance.amount_cents`: fully covered, not just "something was paid toward it." A `markRecurringPaid` call always creates a *new* transaction (never updates an existing one) and can be called more than once per instance. (Still true under the new flat design above — just replace "instance" with "recurring_expenses row.")

**Recurring expenses are not categories, and don't create them.** A category ("Housing") is a general spend-classification label; a recurring expense ("Rent") is a specific identified obligation that happens to be tagged with one. Grilled explicitly to avoid conflating the two: `recurring_expense_templates.category_id` always points at a category the user already has (or separately creates via the normal category flow) — never auto-created, never named after the recurring expense. (Still true under the new flat design — the FK just lives on `recurring_expenses.category_id` directly now.)

> **Revised and built — grilled during Build Order step 6.** The two entries below describe the original sketch; kept side by side rather than rewritten, since the reasoning for what changed is worth having on record.
>
> - **Hard-deleted, not soft-deleted** — like every other entity in this app by the time step 6 was interviewed. The original soft-delete sketch below was never actually built; it was superseded before any code existed for it, on the same "either something can be deleted, or it's permanently blocked, no third state" call already made for categories/recurring expenses.
> - **`current_amount_cents` and `achieved` are not columns** — both computed at read time (`initial_balance_cents` + the net of every movement; `current_amount_cents >= target_amount_cents`, always `false` if no target is set), same "never let a derived value drift out of sync" reasoning as `recurringCommittedCents`/`paidThisMonth`. Confirmed explicitly with the user after weighing the alternative (a stored, incrementally-maintained column): migrating to stored later is cheap (add the column, backfill, update the three movement write paths) and the actual scale doesn't warrant it now — a personal fund realistically accumulates a few thousand movements over a decade at most, negligible for Postgres to sum.
> - **Movements are editable and deletable**, unlike a real accounting ledger — the original sketch only had `addSavingsMovement`, no update/delete, which looked like an oversight given every other money-entry type in this app supports both. Every write (create/update/delete) re-validates the fund's resulting balance can never go negative — "you can't withdraw money you don't have" as a standing invariant, not just checked at creation. Enforced under a real row lock (`SELECT ... FOR UPDATE` on the fund) so two concurrent movements against the same fund can't both read the same balance and both think an overdraft is safe — verified against real Postgres with a genuine concurrent race.
> - **A movement can't be reassigned to a different fund on update** — only `amountCents`/`type`/`date` are editable. Moving money between funds would mean atomically rebalancing two funds' overdraft checks at once; deliberately out of scope.
> - **Deleting a fund is blocked while movements reference it** — same "remove what's in it first" pattern as every other entity, not a cascade.

**savings_funds**

- id (pk)
- user_id (fk)
- name
- target_amount_cents (nullable, integer — cents)
- initial_balance_cents (integer — cents) — set once at creation, never editable after (see revision note above)
- start_date (nullable)
- end_date (nullable)
- monthly_target_cents (nullable, integer — cents)
- ~~current_amount_cents~~ / ~~achieved~~ / ~~deleted_at~~ — see revision note above: both computed, not stored; hard-deleted, no soft-delete

**savings_movements**

- id (pk)
- user_id (fk) — denormalized here even though it's derivable via `fund_id → savings_funds.user_id`: resolvers should filter by `user_id` directly on this table too, not rely solely on a join, so an accidental missing join can't leak another user's movement
- fund_id (fk)
- amount_cents (integer — cents)
- type ('deposit' | 'withdraw')
- date
- ~~deleted_at~~ — see revision note above: hard-deleted, no soft-delete

> ~~**income_sources**~~ — superseded before any code existed for it,
> during step 7's kickoff grill. Kept below as accurate history of the
> original sketch, not deleted — same convention as the recurring-expense
> template/instance section above. The table below was never migrated; no
> teardown was needed.
>
> - id (pk)
> - user_id (fk)
> - name
> - expected_amount_cents (integer — cents)
> - actual_amount_cents (nullable, integer — cents)
> - month_id (fk → `budget_months`) — same pattern as `category_month`/`recurring_expenses`, for the same reason: one real per-user-per-calendar-month row backing every month reference in the schema, not a raw `YYYY-MM` string repeated (and potentially drifting) in every table that needs one
> - deleted_at (nullable) — soft delete
>
> **What replaced it: income is just a `Category`, no new table at all.**
> Reconsidered on the same "why does this need its own table" grounds that
> rebuilt recurring expenses in step 4 — `direction` already lives on
> `Category`, not only on `Transaction`, so an income-direction Category
> (e.g. "Salary", "Freelance"), activated into a month via the *existing*
> `addCategoryToMonth`, already gives "one planned number this month,
> satisfied by N actual Transactions" for free —
> `category_month.monthly_budget_cents` doubles as the "expected amount"
> (not renamed, to avoid breaking an already-shipped field), and a new
> computed field, `CategoryMonth.actualAmountCents` (`SUM` of that
> CategoryMonth's transactions, read-time-computed like
> `recurringCommittedCents`/`paidThisMonth`/`achieved`), gives the "actual"
> side — direction-agnostic, so it also gives expense categories a "spent
> so far" figure they never had before. `Query.categoryMonths` gained an
> optional `direction` arg to power a dedicated Income (or Expense) screen
> without client-side filtering. No `deleted_at`/soft-delete question ever
> arises, since there's no new entity to make that decision about — a
> `Category`'s own hard-delete rule already covers it. See `GLOSSARY.md`'s
> now-superseded Income Source entry and `PROGRESS.md` for the full grill.

> Debts, taxes (IVA/IRS/SS), and the annual roll-up view from your Excel are real features but backlog for after Phase 1-3 are working end to end — don't let them expand the API surface before the core loop (categories → transactions → budget available) is solid and deployed.

> **Referential integrity on delete** — resolved (superseding the "still open" note this used to carry; decide any remaining specifics during each entity's Build Order step, not here):
>
> - Deleting a **category** from the global catalog: only allowed once no `category_month` row references it, for any month, past or future — permanent, no undo, once allowed (see `categories`' revised Data Model entry above — hard-deleted, not soft-deleted). "Remove category from month" (a `category_month` hard delete, blocked if any transactions reference it that month) is the day-to-day action; catalog deletion is rare, and effectively locked out for any category with real history, since a locked past month's `category_month` row can never be removed.
> - Deleting a **savings fund**: soft-delete cascades to a soft-delete of its movements (a movement has no meaning without its fund) — no hard `onDelete` FK behavior needed now that everything is soft-deleted. Unlike `categories`/recurring templates, this hasn't been revisited yet — re-grill when step 6 (Savings funds) is actually interviewed, given the direction taken for `categories` and recurring templates.
> - Deleting a **recurring expense instance**: hard-deleted (grilled during step 4, following `category_month`'s pattern for the identical reason), blocked while any Transaction references it — delete those first. Scoped to one month, optionally also the following month in the same action, never a past one.
> - Deleting a **recurring expense template** from the catalog: same rule as `categories` — only allowed once no `recurring_expense_instance` references it, for any month, past or future — permanent, no undo, once allowed. Same practical consequence: effectively permanent once carried into a now-locked month.
> - All of the above only apply to **unlocked** months. A locked month's rows (`category_month`, instances, transactions) are immutable — no create/update/delete against a locked month, enforced in the service layer, not just the UI. In this Build Order step `locked` is always false (step 5 wires up the mutation that sets it), but the guard is written now, not bolted on later.

## Month Lifecycle: Activation, Carry-Forward, and Locking

A significant piece of design beyond the original flat data model above — resolved during the "grill me" pass for Build Order step 3, but deliberately scoped to its own later Build Order step (step 5, after Categories+Transactions and Recurring Expenses both exist) rather than crammed into step 3, since it touches both of those entities plus introduces `budget_months`.

**Category & recurring-expense activation is per-month, not global.** A category or recurring expense being "active" for a month means a `category_month` / `recurring_expenses` row exists for it in that month. There's no "pause" state — not carrying something forward simply means no row gets created for the new month.

**Recurring template value edits — propagation rule — superseded.** This paragraph described the template/instance design's "apply to future months too?" prompt. Under the flat `recurring_expenses` redesign (see the Data Model section above), there's no template and no propagation question: editing a recurring expense's `amount_cents` only ever touches that one month's row, full stop.

**Bulk delete of a category's transactions** is always scoped to the single month currently being viewed — there's no "delete everything across months" action, ever. For `transactions` specifically (see the revised delete rule in the Data Model above), a bulk delete is immediate and permanent, same as a single-row delete — there's no batching or undo to coordinate.

**Soft delete + undo — revised, now scoped down to only the entities that haven't been built yet.** The original design here was: nothing hard-deleted, every table gets `deleted_at`, undo clears it within a short window (10min-1h, TBD), bulk actions share a `delete_batch_id` so undo restores the whole batch. `category_month` and `transactions` broke from this first (step 3), for referential-integrity reasons (a soft-deleted transaction could otherwise dangle on a hard-deleted `category_month`). During step 4's review, `categories` and `recurring_expense_templates` — until then still soft-deleted — dropped it too, on an explicit user call: either something can be deleted (nothing references it, ever, past or future) or it's permanently blocked, no third "soft-deleted but still around" state, anywhere. Step 6's kickoff interview confirmed the same for `savings_funds`/`savings_movements` before any soft-delete code was ever written for them — every entity in the schema as of step 6 is hard-deleted, no undo. `income_sources` never got the chance to carry this question into code at all — step 7's kickoff grill dropped the table itself before any soft-delete-vs-hard-delete decision mattered (see the Data Model section's superseded `income_sources` note); every entity in the schema, full stop, is hard-deleted with no undo as of step 7.

> **Revised during Build Order step 5's kickoff interview: no auto-lock cascade, no automatic next-month creation, carry-forward isn't its own mechanism.** The three paragraphs below describe the original design; this callout is the actual decision the backend was built against — kept side by side rather than silently rewritten, since the reasoning matters. Explicit user call: locking a month was overcomplicating an edge case that "will only happen if a user creates more months for planning and doesn't do anything with them" — most of the time it won't happen at all. Simplified to: **`lockMonth` does exactly one thing** — locks the target month (which must be the current one — the earliest unlocked), nothing else. No cascade walk, no carry-forward parameter, no automatically-created next month. If a user goes away for a while, "current month" (derived, see below) just naturally falls back to today's real calendar month once nothing unlocked stands in the way — no cascade logic needed to make that happen. If they *did* pre-provision ahead and it's sitting there empty once its predecessor locks, that's on them to resolve explicitly — lock it too (even empty), or **`deleteBudgetMonth`** it (new capability this revision introduces: hard-delete an empty, unlocked month — same "remove everything referencing it first, then the empty shell becomes deletable" pattern `deleteCategory`/`deleteTemplate` already use, blocked by the same `onDelete: Restrict` FK `category_month`/`recurring_expenses` already have to `budget_months`). **Category carry-forward needs no dedicated mutation**: it's the existing `addCategoryToMonth` mutation (already supports omitting the budget to auto-inherit, see the Data Model's `category_month` entry) called once per item the user checks, against whichever month they're planning — reusing the existing `categoryMonths(month)` query against the previous month to know what to offer as checkboxes, all pre-checked, uncheck to opt out. This is deliberately the *same* flow whether the user is proactively planning ahead or just locked the month before and is starting the new current one — one mechanism, triggered at two different moments, never an automatic side effect of locking (so it can never silently clobber a month the user already set up differently). **Recurring expenses diverge from this, under the flat-row redesign** (see Data Model's `recurring_expenses` entry above): they carry forward automatically, no per-item checklist, whenever a new month comes into existence. Planning horizon (current month or one month ahead, never further, and never a new activation in the past either — a user can only *newly* create a category/recurring-expense activation in `[current, current + 1]`) enforced server-side, not just a UI affordance — implemented (`assertWithinPlanningHorizon` in `categoryMonthService`, shared by the recurring-expense auto-activation path); the past-month restriction was added after `pr-reviewer` found that allowing it let a stray backfilled month hijack the derived "current" month itself — see PROGRESS.md.

**Carry-forward, on locking a month — original design, superseded above.** When a month gets locked (below), the user is shown a checkbox list of the just-locked month's active categories and recurring expenses and picks which ones carry into the new month; anything left unchecked simply isn't activated there. **Planning horizon is capped at one month ahead** — a user can never activate/plan further out than the immediate next month. Planning further ahead than that is a candidate future paid-tier feature, not phase 1.

**Month locking.** Months don't close automatically by calendar date. The month a user sees is always the earliest one, in chronological order, that isn't locked yet (see `budget_months` in the Data Model above — there's no separate "current month" pointer, it's derived). If that month is calendar-wise already in the past, the UI shows a banner: *"Lock month and create new"* (or *"Lock and show current month"* if a later month has already been pre-created — e.g. a paid-tier user who planned further ahead). This gives the user time to add/fix missing transactions from the ended month before it closes. Locking is always explicit — a user can keep editing an "old" month indefinitely, even if the calendar has moved on, until they choose to lock it.

**Auto-lock cascade for empty months — dropped, see the callout above.** Original design: if a user hasn't opened the app in a while, there can be several unlocked months stacked up between the last locked one and the real current month. They're shown the oldest of these first for explicit review/lock. Once that one's locked, the system walks forward through the rest automatically: any month with zero transactions gets auto-locked without prompting (nothing to review), and the walk stops — requiring explicit review again — the moment it hits a month that actually has data, or the real current month, whichever comes first.

## API Schema (Phase 1, GraphQL)

Auth (kept as plain REST/HTTP routes even in a GraphQL API — these are request/response actions, not really "queries", and this avoids weird token-in-mutation patterns)

- `POST /auth/request-otp` — body: `{ email }`. Generates a code (crypto-secure random, e.g. Node's `crypto.randomInt`, never `Math.random`), stores its hash + expiry in `otp_codes`, sends it by email (Resend/Postmark). Rate-limit this hard (see Production Readiness).
- `POST /auth/verify-otp` — body: `{ email, code }`. Validates against `otp_codes` (not expired, not used, `failed_attempts` under the max, hash matches). On a wrong code: increment `failed_attempts`, reject. On a correct code: mark it used, create the user row if it doesn't exist yet (first login = signup — a genuine first-time signup also seeds a small default category catalog, see `defaultCategories.ts`; catalog only, not activated into any month), issue an access JWT + a refresh token (persisted in `refresh_tokens`).
- `POST /auth/refresh` — body: `{ refreshToken }`. Validates against `refresh_tokens` (not expired, not revoked), issues a new access JWT **and rotates the refresh token** (the old one is marked revoked, a new one issued and returned) — mandatory, not optional: limits how long a stolen refresh token stays useful.
- `POST /auth/logout` — revokes the given refresh token (that device only).
- `POST /auth/logout-all` — revokes every refresh token for the authenticated user (all devices). This is the "sign out everywhere" action — the thing a user reaches for after losing a phone. Cheap to add now given tokens are already per-device in `refresh_tokens`; awkward to bolt on later.

Everything else as GraphQL types, queries and mutations:

```graphql
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
  month: String! # "YYYY-MM"
  locked: Boolean!
  # No id field: nothing else in this schema references a BudgetMonth by id
  # — every other type denormalizes the month string directly, and
  # currentMonth can represent a not-yet-persisted month (see Query above),
  # which wouldn't have a real id to expose anyway.
}

type Category {
  id: ID!
  name: String!
  icon: String!
  color: String!
  budgetType: BudgetType # null when direction is INCOME; required (enforced service-side) when EXPENSE
  direction: Direction!
}

type CategoryMonth {
  id: ID!
  month: String! # YYYY-MM, denormalized from the linked BudgetMonth for convenience
  monthlyBudgetCents: Int! # the planned/expected number, either direction — for an income category this doubles as "expected amount" (see the now-superseded income_sources note in the Data Model section)
  actualAmountCents: Int! # computed, not stored: SUM(amountCents) across this CategoryMonth's own transactions. Direction-agnostic — "spent so far" for expense, "received so far" for income. Added in step 7, replacing the income_sources sketch (see Data Model)
  recurringCommittedCents: Int! # computed, not stored: SUM(amountCents) across this category's active recurring expense instances this month. Lets the FE offer "match budget to recurring total" with zero manual arithmetic — see Notes for Claude Code.
  category: Category!
  transactions: [Transaction!]! # this month's transactions for this category
}

type Transaction {
  id: ID!
  amountCents: Int!
  date: String!
  merchant: String
  note: String
  direction: Direction! # denormalized from categoryMonth.category.direction, not client-settable
  categoryMonth: CategoryMonth!
  recurringExpense: RecurringExpense # set only when created via markRecurringPaid; never client-settable, same pattern as direction; formerly `recurringExpenseInstance` under the superseded template/instance design (see Data Model)
}

# Formerly split into RecurringExpenseTemplate + RecurringExpenseInstance — superseded, see the
# Data Model section's `recurring_expenses` entry for why. One flat type now, scoped to one month.
type RecurringExpense {
  id: ID!
  month: String! # YYYY-MM, denormalized from the linked BudgetMonth, same pattern as CategoryMonth.month
  name: String!
  amountCents: Int! # this month's amount, period — editing it only ever touches this row
  budgetType: BudgetType!
  dueDay: Int!
  category: Category! # an existing category — creating one never creates a category
  paidThisMonth: Boolean! # computed: SUM(linked transactions.amountCents) >= amountCents — fully covered, not "any payment exists" (split payments are allowed)
  transactions: [Transaction!]! # every transaction linked via markRecurringPaid this month, not just the most recent
}

type SavingsFund {
  id: ID!
  name: String!
  targetAmountCents: Int
  initialBalanceCents: Int!
  currentAmountCents: Int! # computed, not stored — initialBalanceCents + the net of every movement (see Data Model revision note)
  startDate: String
  endDate: String
  monthlyTargetCents: Int
  achieved: Boolean! # computed — currentAmountCents >= targetAmountCents, always false if no target is set
  movements: [SavingsMovement!]!
}

type SavingsMovement {
  id: ID!
  amountCents: Int!
  type: MovementType!
  date: String!
  fund: SavingsFund! # back-reference, mirroring Transaction.categoryMonth
}

# ~~type IncomeSource~~ — superseded, no such type exists; income is
# CategoryMonth.actualAmountCents (above) against an income-direction
# Category, see the Data Model section's income_sources note.

type BankBalance {
  amountCents: Int! # computed, not stored: checkpointAmountCents + net of every Transaction created after checkpointSetAt
  checkpointAmountCents: Int!
  checkpointSetAt: String! # full ISO 8601 timestamp, not a bare date — see the Data Model section's "Bank balance" note
}

input CategoryInput {
  name: String!
  icon: String!
  color: String!
  budgetType: BudgetType # required service-side only when direction is EXPENSE
  direction: Direction!
}

input TransactionInput {
  categoryMonthId: ID!
  amountCents: Int! # must be positive; direction is derived server-side from the category, not accepted here
  date: String!
  merchant: String
  note: String
}

input RecurringExpenseInput {
  name: String!
  amountCents: Int!
  categoryId: ID! # an existing category — never auto-created
  budgetType: BudgetType!
  dueDay: Int!
}

input MarkRecurringPaidInput {
  amountCents: Int! # the actual amount paid — can differ from the row's amountCents (variable bills like gas/electricity); positive, validated same as TransactionInput
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

input UpdateSavingsFundInput {
  name: String!
  targetAmountCents: Int
  startDate: String
  endDate: String
  monthlyTargetCents: Int
}
# initialBalanceCents is intentionally absent from the update input: it's set once at
# creation and never changed, because currentAmountCents is derived from it plus the sum
# of movements — letting it change after movements exist would silently corrupt the balance.

input CreateSavingsMovementInput {
  fundId: ID!
  amountCents: Int!
  type: MovementType!
  date: String!
}

input UpdateSavingsMovementInput {
  amountCents: Int!
  type: MovementType!
  date: String!
}
# fundId is intentionally absent from the update input: a movement can't be reassigned to
# a different fund (that's really two funds' balances changing atomically at once, out of
# scope — see Data Model revision note).

# ~~input IncomeSourceInput~~ — superseded, no such input exists; use
# addCategoryToMonth/updateCategoryMonthBudget/createTransaction on an
# income-direction Category instead, see the Data Model section.

type Query {
  currentMonth: BudgetMonth! # derived, never persisted by this query — earliest unlocked BudgetMonth, or today's real calendar month if none exists
  categories: [Category!]! # full catalog, every category regardless of month — the "reuse an existing category" picker
  categoryMonths(month: String!, direction: Direction): [CategoryMonth!]! # this is "which categories are active this month" — a month has an array of categories, not the reverse. direction filters to just income or just expense categories, e.g. for a dedicated Income screen — added in step 7, see the Data Model section's income_sources note
  # month filters everywhere in this schema use "YYYY-MM".
  # Reject anything else at the input-validation layer (see the Dates convention above).
  transactions(month: String!, categoryId: ID): [Transaction!]! # ordered date DESC, createdAt DESC; unpaginated — a month's transactions is a bounded ~100-row list, not the unbounded case pagination is for (see Production Readiness)
  recurringExpenses(month: String!): [RecurringExpense!]! # this month's recurring expenses, mirrors `categoryMonths(month)` — no catalog-level query, recurring expenses have no month-independent existence (see Data Model)
  savingsFunds: [SavingsFund!]!
  bankBalance: BankBalance! # always returns a value, never null — see the Data Model section's "Bank balance" note for the 0-default reasoning
}

type Mutation {
  lockMonth(month: String!): BudgetMonth! # must be the current (earliest unlocked) month; no carry-forward, no next-month creation — those are separate client-driven actions (see Month Lifecycle above)
  deleteBudgetMonth(month: String!): Boolean! # hard delete an empty unlocked month; blocked while any category_month references it

  createCategory(input: CategoryInput!): Category! # pure catalog insert, no activation
  updateCategory(id: ID!, input: CategoryInput!): Category! # blocks a direction change if any transaction or recurring expense references this category (a never-paid recurring expense has zero transactions yet, so both are checked — see docs/PROGRESS.md's whole-codebase audit note)
  deleteCategory(id: ID!): Boolean! # blocked unless inactive in every month, past and future

  addCategoryToMonth(categoryId: ID!, month: String!, monthlyBudgetCents: Int): CategoryMonth! # budget optional as of step 5: inherits the category's most recent budget when omitted, required only the first time a category is ever activated anywhere
  removeCategoryFromMonth(categoryMonthId: ID!): Boolean! # hard delete; blocked if any transactions reference it that month (delete those first); the "also apply to next month" option is step 5. Also cascades to deleteCategory if this was the category's last remaining category_month anywhere — the client never manages the global catalog directly, so a category with zero active months would otherwise be permanent unreachable clutter (see "Month Lifecycle" note below)
  updateCategoryMonthBudget(categoryMonthId: ID!, monthlyBudgetCents: Int!): CategoryMonth! # this month's budget only, no template to propagate to

  createTransaction(input: TransactionInput!): Transaction!
  updateTransaction(id: ID!, input: TransactionInput!): Transaction!
  deleteTransaction(id: ID!): Boolean! # hard delete, immediate and permanent, no undo

  createRecurringExpense(input: RecurringExpenseInput!, month: String!, categoryMonthlyBudgetCents: Int): RecurringExpense! # month is required — a recurring expense is only ever created "for" a month; categoryMonthlyBudgetCents required only if the category isn't already active that month (no derived default from amountCents — see the Data Model note above). No separate "reuse into a new month" mutation — carry-forward is automatic (see Month Lifecycle)
  updateRecurringExpense(id: ID!, input: RecurringExpenseInput!): RecurringExpense! # one flat edit (name/category/budgetType/dueDay/amountCents together), scoped to this one row/month, no propagation question
  removeRecurringExpenseFromMonth(id: ID!): Boolean! # hard delete; blocked if any transaction references it (delete those first)
  markRecurringPaid(id: ID!, input: MarkRecurringPaidInput!): Transaction! # creates a new Transaction linked via recurringExpenseId; can be called more than once per row (split payments) — never updates an existing transaction

  createSavingsFund(input: CreateSavingsFundInput!): SavingsFund!
  updateSavingsFund(id: ID!, input: UpdateSavingsFundInput!): SavingsFund!
  deleteSavingsFund(id: ID!): Boolean! # hard delete; blocked while any movement references it
  createSavingsMovement(input: CreateSavingsMovementInput!): SavingsMovement! # rejects a withdrawal (or edit) that would leave the fund's balance negative
  updateSavingsMovement(id: ID!, input: UpdateSavingsMovementInput!): SavingsMovement! # amountCents/type/date only, re-checks the resulting balance
  deleteSavingsMovement(id: ID!): Boolean! # re-checks the resulting balance with this movement's effect removed

  setBankBalanceCheckpoint(amountCents: Int!): BankBalance! # overwrites both the checkpoint amount and its timestamp (to now) in one call — no history kept, no separate timestamp override
}
```

> **No `IncomeSource` type/inputs/query/mutations** — superseded before any
> code existed for them, during step 7's kickoff grill. `Category`,
> `CategoryMonth` (now including `actualAmountCents`, added this step),
> `Transaction`, `RecurringExpense`, `SavingsFund`, `SavingsMovement`, and
> `BankBalance` all reflect finalized, grilled, and now-implemented
> designs — trust all of them now. `RecurringExpense` supersedes step 4's
> original `RecurringExpenseTemplate`/`RecurringExpenseInstance` split;
> `SavingsFund`/`SavingsMovement` supersede this section's original
> soft-delete/stored-balance sketch (see PROGRESS.md for both rebuilds).
> `initialBalanceCents` is settable only at creation
> (`CreateSavingsFundInput`) and deliberately absent from
> `UpdateSavingsFundInput`; `fundId` is likewise absent from
> `UpdateSavingsMovementInput` — see the Data Model revision note above
> for both. `BankBalance` (grilled and built as its own step right after
> the income pivot, per its Data Model section note above) is the one
> type in this schema tied to the user's account rather than any month or
> other entity.

Note about enum casing: GraphQL convention is UPPER_CASE enum values (`NEED`, `EXPENSE`), but the DB uses lowercase (`need`, `expense`). Map between the two in the resolver/service layer — don't let the DB casing leak into the GraphQL schema or vice versa. The `GLOSSARY.md` lowercase values are the DB representation. (`budgetType`'s three values were originally Portuguese — `preciso`/`quero`/`poupança`, matching the Excel tracker — translated to English `need`/`want`/`savings` in the codebase; the 50/30/20 meaning is unchanged.)

Note: any relation field on a list — `CategoryMonth.transactions`, `RecurringExpense.transactions`, `SavingsFund.movements`, but also the reverse direction like `Transaction.categoryMonth`, `Transaction.recurringExpense`, `RecurringExpense.category` — is a potential N+1. The rule from the Architecture Decision above (DataLoader on every relation-traversing resolver) applies to all of them, not just the two most obvious ones.

## Build Order (suggested milestones for Claude Code sessions)

0. **Ground truth first**: commit `.claude/CLAUDE.md`, `docs/GLOSSARY.md`, `docs/PLAN.md`, and `docs/SCALING.md` to the repo before writing any code — these are read by Claude Code and define the vocabulary and rules the schema is built from. (They already exist; this step is just "they're in the repo before step 1 starts." Originally lived flat at the repo root — moved into `.claude/`/`docs/` later for a cleaner root, see `docs/PROGRESS.md`.)
1. **Project scaffold**: Fastify + TypeScript, GraphQL Yoga/Mercurius wired in, Prisma init, PostgreSQL running locally (Docker recommended), CORS configured, `@fastify/helmet`, Zod-validated env vars at startup, `GET /health` route, graceful shutdown + crash handlers wired up, a trivial `Query.ping` to confirm the whole chain works
2. **Auth (OTP)**: `otp_codes` + `refresh_tokens` tables, email sending wired up (start with logging the code to console in dev, swap in Resend/Postmark before anything real), request-otp/verify-otp/refresh/logout routes, JWT context builder for GraphQL resolvers
3. **Categories + Transactions**: `budget_months` table lands here (schema-only — `locked` stays inert until step 5), plus `categories` (pure catalog, no month-awareness, **hard-deleted** — revised during step 4's review, see "Month Lifecycle" above), `category_month` (the join — row existence = active, budget lives here not on `categories`, **hard-deleted**, `@@unique([categoryId, monthId])`, blocked from deletion while any transaction references it that month), and `transactions` (FK to `category_month`, not `category` directly — structurally enforces "category must be active that month"; **hard-deleted**, no undo). `createCategory` is a pure catalog insert; `addCategoryToMonth`/`removeCategoryFromMonth`/`updateCategoryMonthBudget` are the only activation path in this step (budget always explicit — carry-forward's inheritance path is step 5). DataLoader for `CategoryMonth.transactions`. See "Month Lifecycle" above for the full reasoning, including the soft-delete-and-undo history.
4. **Recurring expenses** — originally shipped as `recurring_expense_templates` + `recurring_expense_instances` (**hard-deleted**, transversal template mirroring `categories`, matching `category_month`'s per-month instance pattern), **since rebuilt as the flat `recurring_expenses` design** (see the Data Model section above and `PROGRESS.md` for the rebuild). The invariants carry over unchanged: creating a recurring expense auto-activates its category for that month if needed (diverges from `categories`' always-manual activation rule — grilled explicitly, see Data Model note), requiring an explicit `categoryMonthlyBudgetCents` only when that activation actually creates a new `category_month`; `markRecurringPaid` always creates a *new* Transaction (never updates one), can be called more than once per row; `paidThisMonth` is computed as `SUM(linked transactions) >= amountCents`, not "any transaction exists"; `CategoryMonth.recurringCommittedCents` (computed) sums a category's active recurring expenses for the month — feeds the phase-2 "match budget to recurring total" UX flagged under Notes for Claude Code. The flat redesign removes the template-edit-propagation question entirely (see Month Lifecycle) — never a step 5 dependency to begin with.
5. **Month lifecycle**: carry-forward flow (with budget-inheritance for `category_month`; automatic, no per-item opt-in, for `recurring_expenses`), month locking + the auto-lock cascade for empty months. Soft-delete + undo (with `delete_batch_id` batching) no longer applies to any entity built so far (`categories`, `category_month`, `transactions`, and whichever recurring-expense shape is live are all hard-deleted) — only `savings_funds`/`savings_movements` (step 6) still carried that design on paper at the time this step was built. Depends on steps 3 and 4 both being done.
6. **Savings funds + movements** — grilled, design finalized and built (see the Data Model section's revision note above): hard-deleted, no soft-delete (revised out during this step's kickoff interview, before any soft-delete code existed for it, matching every other entity). `currentAmountCents`/`achieved` computed at read time, not stored columns. `createSavingsMovement`/`updateSavingsMovement`/`deleteSavingsMovement` (not a single `addSavingsMovement` — movements are editable/deletable, unlike the original sketch) all re-validate the fund's resulting balance can't go negative, under a real row lock on the fund so concurrent movements can't race past the overdraft check together — verified against real Postgres. `deleteSavingsFund` blocked while any movement references it. DataLoaders for `SavingsFund.movements`/`currentAmountCents` and `SavingsMovement.fund`.
7. **"Income sources"** — reconsidered before any code existed for it (see the Data Model section's superseded `income_sources` note): no new table. Income is an income-direction `Category`, activated into a month via the *existing* `addCategoryToMonth`, with each paycheck a normal `Transaction`. What actually got built this step: `CategoryMonth.actualAmountCents` (computed, `SUM` of that CategoryMonth's transactions, direction-agnostic — also gives expense categories a "spent so far" figure for the first time) and an optional `direction` arg on `Query.categoryMonths`. A separate "bank balance" feature (a checkpoint-anchored running total, independent of any one month) surfaced during this step's grill and was deliberately deferred, then built as its own immediate follow-up (not a numbered Build Order step — see the Data Model section's "Bank balance" note and `PROGRESS.md`): `BankBalance` is computed at read time as `bankBalanceCheckpointCents` + every `Transaction` created after `bankBalanceCheckpointSetAt`, deliberately unrelated to Savings Funds, and the one money field in this schema explicitly allowed to go negative.
8. **Seed script**: `prisma/seed.ts` (`npm run seed`) — real categories, recurring bills, and income sources from the user's actual Excel tracker, translated to English. Scoped narrowly: catalog + current month's activations only — no transactions, no savings funds, no bank balance checkpoint (deliberately out of scope, grilled explicitly). Seeds a dedicated throwaway `seed@example.com` account, never real user data; idempotent (deletes and recreates that account's data on every run). This is distinct from `authService`'s existing generic default-category seeding on real signup — that continues to serve every new user, this is a dev-only convenience for one specific account.
9. **Basic tests**: at minimum, auth boundary tests (user A can't read user B's data) and one DataLoader batching check — this is the one thing worth testing before going live

Once the API is solid: **Phase 2** picks up the mobile app plan (screens, design reference, keypad UI etc. — already scoped separately) but wired to this API instead of local SQLite. **Phase 3** is the website as a thin client on top of the same API.

## Production Readiness (build in from Phase 1, not bolted on later)

- **Logging + error tracking**: Fastify ships with pino for structured logging; add Sentry (or similar) so production errors surface without manually grepping logs
- **Error masking**: GraphQL servers by default can leak internal error details (stack traces, raw DB error messages) straight into the response — fine in dev, a real information leak in production. GraphQL Yoga/Mercurius both support masking unexpected errors down to a generic message in production while keeping full detail in server-side logs. Configure this explicitly, don't rely on the default.
- **Disable introspection/playground in production**: GraphQL servers expose a schema introspection query and often a GraphiQL/playground UI by default — great for dev, but in production it hands anyone your entire API schema for free. Both GraphQL Yoga and Mercurius let you turn this off based on `NODE_ENV`.
- **Query depth/complexity limits**: without this, a malicious (or just badly written) deeply nested query can force the server to do disproportionate work — a GraphQL-specific denial-of-service angle that REST doesn't have. `graphql-depth-limit` or a complexity-scoring plugin covers this cheaply.
- **Rate limiting**: critical on `/auth/request-otp` especially — without it, someone can spam a user's inbox or brute-force codes. `@fastify/rate-limit` covers this cheaply
- **Pagination**: `transactions(month, categoryId)` is deliberately unpaginated as of Build Order step 3 — a single month's transactions is a bounded, small list (~100 tops, per the user), not the unbounded case this warning is about. Still applies to any future list that isn't month-scoped (e.g. an eventual "all history" view) — add pagination there from the start when it's built, don't retrofit.
- **Idempotency**: deferred as of Build Order step 3 — `createTransaction` has no retry-dedup mechanism yet. Revisit if/when the mobile or web app surfaces a real duplicate-on-retry issue (flaky connection double-submits, etc.) rather than guarding against a hypothetical now. `createSavingsMovement` (step 6, built) carries the same deferral — no retry-dedup, same reasoning.
- **Backups**: confirm your chosen hosting provider does automated Postgres backups before real users' data lives there — and do one test restore before you actually need it for real, a backup nobody has ever restored from is an assumption, not a guarantee.
- **Secrets management**: env vars via the hosting platform's secret store, never committed `.env` files with real values
- **GDPR export/delete** — **built**: `GET /account/export` returns the authenticated user's full data (account info + every domain row they own) as a single JSON response, synchronous — no file storage or email-attachment infra needed given this is bounded per-user data, not a huge export. **Revisit with an async (generate a file, email a link) approach if a real user's data ever gets large enough that this becomes slow or memory-heavy** — flagged explicitly, not a decision made now. `DELETE /account` (body `{ confirm: true }`, a deliberate extra guard beyond just a valid access token given this is the single most destructive action in the app) hard-deletes everything for that user in one transaction. Neither of these can rely on cascading deletes: every domain table now has a real `onDelete: Restrict` FK relation back to `User` (see the "Fixed" note further down this section) — but `Restrict`, not `Cascade`, so it's a DB-level backstop, not the deletion mechanism. Deletion is still an explicit, dependency-ordered multi-table wipe (children before parents, respecting the `Restrict` FKs between domain tables), plus a separate `otp_codes` cleanup by email (keyed by email, not `userId`, so outside the normal per-user chain). Verified against real Postgres, not just the fake, given how many `Restrict` constraints the ordering has to walk through correctly. A privacy policy is still not written — a product/legal task, not a code one. This is REST, not GraphQL, same reasoning as `/auth/*` and `logout-all` — see `docs/PROGRESS.md`.

> **Fixed** — every `user_id` column above now has a real `onDelete: Restrict` FK relation to `User` (`BudgetMonth`/`Category`/`CategoryMonth`/`Transaction`/`RecurringExpense`/`SavingsFund`/`SavingsMovement`), matching this Data Model section's original `(fk)` labels for the first time since only `refresh_tokens` ever actually got one. Restrict, not `Cascade` — cascading from `User` would have to cascade straight through the *intentional* `Restrict` relations already sitting between the domain tables themselves (e.g. `CategoryMonth → Category`, deliberately `Restrict` so a normal single-item `deleteCategory` can't silently wipe out linked data), weakening a real product safety guard. `deleteAccount` didn't need to change at all — it already does its own explicit, dependency-ordered delete; the FK is a DB-level backstop confirming that ordering is correct, not the deletion mechanism. Verified against real Postgres: a row referencing a nonexistent user is now correctly rejected (the actual original gap); the exact orphan-race scenario (a stray row created mid-transaction, right before the final `user.delete`) now fails loudly with a `P2003` and the whole transaction rolls back, instead of silently succeeding and leaving an unreachable row behind. That failure is deliberately left to propagate as a genuine error rather than being caught/remapped — an exact-timing collision is rare, and when it happens the transaction rollback already makes it safe (nothing lost, a retry picks up and deletes the stray row too). A true guarantee (closing the timing window itself, not just failing safely inside it) would need every create path for `Category`/`BudgetMonth`/`SavingsFund` to coordinate with `deleteAccount` via something like an advisory lock — considered and explicitly not done, since a safe failure was judged sufficient for how rare this is.
- **Row cleanup** — **built**: `authCleanupService.cleanupExpiredAuthRecords()` deletes expired `otp_codes`/`refresh_tokens`, plus `used` codes regardless of expiry (dead weight the instant they're used) and `revoked` refresh tokens past a 1-hour grace period (`revokedAt` cutoff) rather than immediately — refresh tokens rotate on every use, so waiting for the full TTL would let a large backlog build up well before real scale, but an immediate delete raced normal logout→re-login sequences and destroyed the `revoked`-vs-`not_found` distinction `refreshSession` uses to detect a reused/stolen rotated token. Runs in bounded batches (1000/call) against dedicated indexes rather than one unbounded `DELETE`, so a large backlog can't hold locks on these hot-path tables. Triggered two ways, both in-process, no external cron/hosting dependency: piggybacked on every `POST /auth/request-otp`, plus an hourly `setInterval` backstop in `index.ts` for stretches with no login traffic — see `docs/SERVICES.md`.
- **CI** — **built**: `.github/workflows/ci.yml` (GitHub Actions) runs on every push and PR into `develop`/`main` — `lint`, `typecheck`, `build`, `test` (all against in-memory fakes, no DB needed), then `prisma migrate deploy` against an ephemeral Postgres service container to prove the full migration history still replays cleanly from empty. Required as a merge-blocking status check on `develop`/`main`.

## Out of scope for Phase 1

- Debts, taxes, annual roll-up view (product backlog, not architecture)
- Offline support / sync conflict resolution
- Open Banking / bank account integration — separate concern entirely (PSD2, an aggregator like GoCardless Bank Account Data or Tink, its own OAuth flow with the bank). Worth revisiting only with real user demand, given the regulatory and cost overhead.
- GraphQL subscriptions / real-time updates (revisit only if a concrete need shows up)
- Full audit trail / field-level edit history on financial records (soft-delete + short-window undo no longer applies on paper to anything, as of step 7 — see "Month Lifecycle" above; every entity in the schema is hard-deleted with no undo at all, and a full history of every edit ever made to a transaction is a separate, bigger feature regardless, still backlog)
- Planning horizon beyond one month ahead (capped at next-month-only for phase 1 — see "Month Lifecycle" above; candidate future paid-tier feature)

## Data Monetization Policy (future — no phase 1 work)

No user data is ever sold or shared in a form that's linkable back to a specific individual — not even in pseudonymized/internal-ID form. There's deliberately no consent/opt-in toggle for this: the policy is unconditional, so there's nothing a toggle would be granting consent to.

Before any data monetization could ever happen, it would need to pass through a dedicated anonymization pipeline — a separate future initiative with its own design work, not an extension of the soft-delete mechanics above. That pipeline would need to define, when it's actually scoped:

- what gets aggregated and at what granularity (e.g. category-level spend trends across many users, never a single user's transaction stream)
- how re-identification risk is minimized (k-anonymity-style thresholds, no reversible ID mapping back to a user row, no small-cohort aggregates that could fingerprint one person)
- what governs whether/when this ever actually ships

Until that pipeline exists and is explicitly built, no data monetization happens, full stop.

## Local Setup

- **Docker required on your machine first** (Docker Desktop on Mac/Windows, or Docker Engine on Linux) — Claude Code will generate `docker-compose.yml` for a local Postgres, but can't install Docker itself for you.
- `docker-compose.yml`: single Postgres service, exposed on the standard port, with a named volume so data survives restarts.
- `.env.example`: committed to the repo with placeholder values (DB connection string, JWT secret, email provider key) — shows what's needed without leaking real secrets. Copy it to `.env` locally and fill in real values; `.env` itself stays gitignored.
- Alternative if you'd rather skip local Docker entirely: point `.env` at a free-tier hosted Postgres (e.g. Neon) even for dev. Zero local install, but needs internet to develop. Flag this if you want to switch — it only changes the connection string, nothing else in the plan.
- `npm run seed`: populates a dedicated `seed@example.com` account with realistic categories/bills/income for local testing (Build Order step 8) — see the Data Model section's note there. Never run against anything but a local/dev database.

## Starter Prompt (paste this into Claude Code to begin)

`CLAUDE.md` (in the repo root) carries the standing rules and is read automatically every session — this prompt only needs to point at the task, not repeat them.

```
Read PLAN.md and GLOSSARY.md before you start.

Let's go through the backend scaffold (phase 1, "Build Order" section, step 1).

Start by asking me what you need to know for the initial scaffold.
```

For the mobile app phase (phase 2), add: _"Before writing any screen, ask me for the design references (screenshots + Excel structure)."_ (`CLAUDE.md` already covers this generally, but it doesn't hurt to reinforce it at the start of that specific phase.)

## Notes for Claude Code

- Multi-tenancy first: no resolver ships without a `user_id` filter from the auth context, this is not optional even in early dev
- DataLoader on every relation field that can be traversed in bulk — not just categories→transactions and funds→movements, also the reverse direction (transactions→categoryMonth, transactions→recurringExpense, recurringExpenses→category) — don't skip this "for now", it's much more annoying to retrofit
- Follow the "How We Work With Claude Code" practices above for every module: interview before coding, test-first, keep the service layer as the deep-module boundary
- Never log or store raw OTP codes, only their hash
- Keep the Prisma schema and `GLOSSARY.md` as the sources of truth — schema for data shape, glossary for terminology
- Ask before introducing new dependencies beyond the stack listed above
- Graceful shutdown and crash handlers belong in the scaffold step, not bolted on right before deploy — they're much easier to get right when the app is still simple
- **Phase 2 (mobile app), category budget screen — don't let this get lost**: the category-month budget editor must offer a "match to recurring total" action using `CategoryMonth.recurringCommittedCents` (sum of that category's active recurring expenses for the month) feeding directly into the existing `updateCategoryMonthBudget` mutation — one tap, no manual arithmetic. This came out of an explicit grilling during step 4: for a category dominated by recurring expenses with variable amounts (e.g. Housing = fixed rent + variable gas/electricity), requiring the user to hand-sum those before typing a budget number defeats the point of the app doing the tracking. The backend already computes the sum; the frontend just has to surface it and let one tap apply it, rather than asking the user to do that math and type the result in by hand.
