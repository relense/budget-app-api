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
- **Schema-to-types safety**: GraphQL Code Generator (`graphql-codegen`) to generate TS types from the GraphQL schema — keeps resolver types and the schema from drifting apart as the API grows
- **Testing**: Jest + ts-jest
- **Local dev DB**: PostgreSQL via Docker Compose (requires Docker installed on your machine — Claude Code writes the `docker-compose.yml`, but it needs Docker itself already present to run it)
- **Hosting (when you deploy)**: no decision needed now. Start on Railway/Render (free/cheap tier, zero ops burden while there are no real users yet), keep the architecture portable (plain Docker, Prisma, env vars, nothing platform-specific). See `SCALING.md` for the growth path (VPS migration, horizontal scaling, DB migration) — not relevant until there's real traffic.

## System Design Notes

- **Multi-tenancy**: every table has `user_id`; every query filters by the authenticated user. This is the single most important thing to get right before this goes live.
- **Indexes**: `(user_id, date)` on transactions and savings_movements — you'll filter by user + month constantly. Also index `otp_codes.email` (looked up on every verify) and `refresh_tokens.token_hash` (looked up on every refresh) — both are hit on the hot path of every login/refresh, not just occasional queries.
- **Migrations**: versioned from commit 1 via Prisma, never hand-edit the DB schema directly.
- **Config**: env vars for dev/staging/prod, nothing hardcoded (DB connection string, JWT secret).
- **Auth boundary**: every non-auth route/resolver requires a valid access JWT, checked once in a shared context builder — resolvers read `userId` from context, they don't re-verify tokens themselves.
- **CORS**: the website (phase 3) will hit the API from a browser, so explicit CORS config (allowed origins) is needed — the mobile app isn't subject to CORS, but the browser client is. Configure this even in phase 1 so it's not a surprise later.
- **Health check**: a plain `GET /health` route returning 200 once the DB connection is confirmed — most hosting platforms (Railway, Render, Fly) use this to know your API is alive before routing traffic to it.
- **Connection pooling (later, not phase 1 priority)**: given you're deploying a traditional long-running Node process (Railway/Render-style, not serverless), this isn't urgent — a small, stable pool is fine. See `SCALING.md` for when and how this becomes relevant.
- **Atomicity (DB transactions)**: any mutation that writes more than one row must wrap those writes in a Prisma transaction (`prisma.$transaction`), so a crash halfway can't leave inconsistent data. The two obvious ones: `addSavingsMovement` (inserts a movement _and_ updates the fund's `currentAmountCents`) and `markRecurringPaid` (inserts a transaction linked to the recurring item). `currentAmountCents` in particular should be recomputed/updated inside the same transaction as the movement insert, never as a separate call.
- **Overdraw rule on `addSavingsMovement`**: a `WITHDRAW` larger than the fund's current `currentAmountCents` is rejected with a clear error in the service layer — negative fund balances aren't allowed. (Confirm this during the "grill me" pass if you'd rather allow it, e.g. to track a fund going into debt, but reject-by-default is the safer starting rule for a money app.)
- **Graceful shutdown**: handle `SIGTERM` to stop accepting new requests, let in-flight ones finish, and close the Prisma connection pool cleanly before exiting — without this, every redeploy on Railway/Render can drop requests mid-flight.
- **Crash handling**: register `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers that log the error (to Sentry) before exiting — better than the process silently limping in a broken state or dying with no trace.
- **Request tracing**: Fastify/pino support a request ID on every log line by default — keep this on, it's what makes debugging a specific failed request in production possible instead of grepping through unrelated interleaved logs.
- **Schema evolution**: when a GraphQL field needs to change or go away, mark it `@deprecated(reason: "...")` and keep it working for a transition period rather than breaking it outright — GraphQL's equivalent of API versioning, relevant once the mobile app and website are both depending on the same schema.

## Data Model (PostgreSQL / Prisma, Phase 1)

> **Money convention**: every monetary value is stored and transmitted as an **integer number of cents** (`amount_cents`, `Int` in GraphQL) — never `Float`/`Decimal` for the wire format. Floats accumulate rounding errors over thousands of transactions; storing cents as integers avoids that class of bug entirely. The frontend (mobile/web) multiplies by 100 before sending and divides by 100 for display — that conversion lives only at the UI edge, never inside the API or DB layer.

> **Timestamps**: every table below gets `created_at` and `updated_at` (Prisma: `@default(now())` / `@updatedAt`) even where not listed explicitly — omitted per-table below to avoid repetition, but it's not optional. Useful for debugging, ordering, and any "recently added" view later.

> **Dates**: `date` fields (on `transactions`, `savings_movements`) and `start_date`/`end_date`/`due_day` are calendar dates, not timestamps — no time-of-day component, no timezone conversion to worry about. Use Postgres `date`, not `timestamp`. **Validate the format on input**: reject anything that isn't a bare `YYYY-MM-DD` (Zod `.regex(/^\d{4}-\d{2}-\d{2}$/)`, or a custom `Date` GraphQL scalar) so a client can't accidentally send a full ISO timestamp like `2026-08-17T15:32:00Z` and get a silently truncated or timezone-shifted value stored. `month` on `income_sources` gets the same treatment with `^\d{4}-\d{2}$`.

**users**

- id (pk)
- email (unique)
- created_at

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
- direction ('expense' | 'income') — fixed once transactions exist under this category; `updateCategory` blocks a direction change if any transaction references it (via `category_month`, see below), since that would make historical transactions inconsistent with their category
**No `deleted_at` — hard-deleted, revised (see the callout below).** Deleting a category is only allowed once it has no `category_month` row for any month, past or future — same precondition as before, just no soft-delete step in between. In practice, a category that was ever active in a now-locked past month can never be deleted, since a locked month's rows are immutable — intentional (preserves referential integrity on historical records), flagged here since it's a direct but non-obvious consequence of the locking design below. Once deletable, the delete is permanent — no undo. **Not yet migrated as of Build Order step 4**: `prisma/schema.prisma`'s `Category.deletedAt` column and `categoryService.ts` still reflect the old soft-delete design — this entry describes the target state, decided but deliberately deferred to its own follow-up branch/PR since `categories` is already-merged code from step 3 (see `PROGRESS.md`). Don't assume the column is actually gone until that PR lands.

**category_month** (the real join — a category is "active" in a given month iff a row exists here for it; this is where all month-specific state lives, not on `categories`. **Hard-deleted, not soft-deleted** — revised from the original soft-delete design; see the callout below.)

- id (pk)
- user_id (fk) — denormalized for direct scoping, same pattern as `savings_movements.user_id` below
- category_id (fk)
- month_id (fk → `budget_months`)
- monthly_budget_cents (integer — cents; this month's budget for this category. When created via carry-forward from the previous month — step 5 — it inherits that previous month's value by default. When created fresh, with no prior month to carry forward from — the only path that exists in this Build Order step — it must be explicitly provided; there's no zero-default fallback.)

`@@unique([category_id, month_id])` — a real DB constraint, not app-level find-or-reactivate logic. A concurrent second attempt to add the same category to the same month simply fails the constraint. There's no "reactivation" concept: removing a category from a month is a hard delete, so adding it back later is a plain insert, identical to adding it the first time — nothing to distinguish "fresh" from "reactivated."

**Deleting a `category_month` row is only allowed when zero transactions reference it for that month** — if any exist, the delete is rejected and the user has to delete those transactions first. Because a deletable `category_month` row always has zero transactions, hard-deleting it is safe: no live transaction can ever end up pointing at a row that's being removed. Enforce this at the DB level too (`onDelete: Restrict` on `transactions.category_month_id`, not just an app-level pre-check) as a backstop. Removing from a month can optionally also remove the following month's row in the same action, never a past month's (locked/immutable once that month is locked — see "Month Lifecycle" below).

There is no `activate`/bundle-into-`createCategory` behavior: `createCategory` is a pure catalog insert, nothing else. Activating a category for a month (creating its `category_month` row) is always a separate, explicit action — either the month's carry-forward flow (step 5) or a manual "add category to month" call (this step).

**transactions** (**hard-deleted, not soft-deleted** — revised from the original soft-delete design; see the callout below)

- id (pk)
- user_id (fk) — kept as a direct column for defense-in-depth scoping even though it's now reachable transitively via `category_month_id → category_month.category_id → categories.user_id` (two joins away) — same reasoning as `savings_movements.user_id`
- category_month_id (fk → `category_month`, **not** `category_id` directly) — this structurally enforces that a transaction can only exist against a category that was actually active in that specific month; there's no app-level "is this category active this month" check needed, the FK can't reference a `category_month` row that doesn't exist. The transversal view of a category (all its transactions across every month it's ever been active) is still one join away: `transactions → category_month → categories`.
- recurring_expense_instance_id (nullable, fk → `recurring_expense_instances`, not the template) — set when this transaction was created via `markRecurringPaid`; this is what `paidThisMonth` actually checks against (a transaction in the same category this month isn't enough — it must be linked to this specific instance)
- amount_cents (integer, always positive — always store money as integer cents, never float; the sign/meaning comes from `direction`, not the number; FE multiplies/divides by 100 for display/input)
- date
- merchant (nullable)
- note (nullable)
- direction ('expense' | 'income') — **not client-supplied**: derived and stored from `category_month.categories.direction` at write time, since a transaction can only ever point at one category with one fixed direction. Kept as a denormalized read field for query convenience (filter/sort without an extra join), but `TransactionInput` has no `direction` field at all.

> **Revised: no soft delete, no undo, anywhere in this flow — `categories` included.** `categories`, `category_month`, and `transactions` are all hard-deleted, full stop — no `deleted_at`, no `delete_batch_id`, no undo window, single or bulk. This supersedes the "Soft delete + undo" paragraph of the Month Lifecycle design below as it applied to these entities. Originally `categories` kept its own catalog-level soft delete while `category_month`/`transactions` went hard-deleted (reasoning below still explains *that* half); revisited later in Build Order step 4's review cycle — explicit user call: either something can be deleted (nothing references it, ever) or it's permanently blocked by what references it, with no third "soft-deleted but still around" state for any of these three. `category_month`/`transactions` reasoning, unchanged: keeping `transactions` soft-deleted while `category_month` is hard-deleted would create a dangling-reference trap — a soft-deleted transaction kept around for undo could end up pointing at a `category_month_id` that no longer exists once that row is actually removed. Simplest fix is to not have that class of row at all. `recurring_expense_templates`/`recurring_expense_instances` — grilled during Build Order step 4 — follow the same rule, for the identical reason; see below.

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

**Recurring expenses vs. transactions — not one-to-one.** Unlike the original assumption, more than one `Transaction` can link to the same `recurring_expense_instance_id` (split payments — e.g. paying rent to a landlord in two installments). There is no uniqueness constraint on `transactions.recurring_expense_instance_id`. `paidThisMonth` is **not** "does any transaction exist" — it's `SUM(linked transactions.amount_cents) >= instance.amount_cents`: fully covered, not just "something was paid toward it." A `markRecurringPaid` call always creates a *new* transaction (never updates an existing one) and can be called more than once per instance.

**Recurring expenses are not categories, and don't create them.** A category ("Housing") is a general spend-classification label; a recurring expense ("Rent") is a specific identified obligation that happens to be tagged with one. Grilled explicitly to avoid conflating the two: `recurring_expense_templates.category_id` always points at a category the user already has (or separately creates via the normal category flow) — never auto-created, never named after the recurring expense.

**Category activation *is* automatic for recurring expenses, unlike for plain categories.** Step 3 deliberately made `createCategory` a pure catalog insert with month-activation always a separate explicit action, since a category can meaningfully sit dormant in the catalog. A recurring expense has no equivalent dormant state — it only exists because you're tracking paying something *now* — so the friction of "activate the category, then separately add the recurring expense" doesn't pull its weight here:
- `createRecurringExpenseTemplate` (first time) takes a target `month` up front. It creates the template, and if the template's category isn't already active for that month, activates it automatically (creates `category_month`) rather than requiring a separate manual step — then creates the instance for that month.
- `addRecurringExpenseToMonth` (reusing an existing template — carrying "Rent" into a new month) does the same: auto-activates the category for that month if needed, then creates the instance.
- **The auto-activated `category_month`'s budget is never derived from the recurring expense's own `amount_cents`** — grilled explicitly, since a category's budget (e.g. Housing's overall monthly target, covering rent + variable electricity + variable gas + whatever else) is a genuinely independent number from any single recurring expense's amount, and defaulting one from the other would be actively wrong the moment a second recurring expense joins the same category. If the category_month doesn't exist yet, both mutations above take a required `categoryMonthlyBudgetCents` argument for it (no silent default, same "no zero-default fallback" rule step 3 already established for `addCategoryToMonth`). If it already exists (from a prior recurring expense, or manual activation), no budget argument is needed or accepted.

**`CategoryMonth.recurringCommittedCents`** (computed, GraphQL-only — not a stored column): `SUM` of `amount_cents` across every active `recurring_expense_instance` under that category for that month (e.g. Housing → Rent 800 + Electricity 64.79 + Gas 49.51 = 914.30). Exists specifically so a category's manually-set `monthlyBudgetCents` never has to be *hand-calculated* against its recurring expenses — see the flagged note under "Notes for Claude Code" below, this is a real phase 2 UX requirement, not a nice-to-have.

**Editing a recurring expense — step 4's scope stops at the same line `category`/`category_month` did.** `updateRecurringExpenseTemplate` (name/category/budgetType/dueDay/default amountCents) and `updateRecurringExpenseInstance` (this month's amount override only) are plain field edits, no propagation logic — mirrors `updateCategory`/`updateCategoryMonthBudget` exactly. The "apply this to future months too?" prompt (already designed in the Month Lifecycle section above) is step 5's job, once the locking mechanism exists to know which future instances are still unlocked.

**savings_funds**

- id (pk)
- user_id (fk)
- name
- target_amount_cents (nullable, integer — cents)
- initial_balance_cents (integer — cents)
- current_amount_cents (integer — cents)
- start_date (nullable)
- end_date (nullable)
- monthly_target_cents (nullable, integer — cents)
- achieved (boolean)
- deleted_at (nullable) — soft delete; cascades to a soft-delete of its movements (below), since a movement has no meaning without its fund

**savings_movements**

- id (pk)
- user_id (fk) — denormalized here even though it's derivable via `fund_id → savings_funds.user_id`: resolvers should filter by `user_id` directly on this table too, not rely solely on a join, so an accidental missing join can't leak another user's movement
- fund_id (fk)
- amount_cents (integer — cents)
- type ('deposit' | 'withdraw')
- date
- deleted_at (nullable) — soft delete

**income_sources**

- id (pk)
- user_id (fk)
- name
- expected_amount_cents (integer — cents)
- actual_amount_cents (nullable, integer — cents)
- month_id (fk → `budget_months`) — same pattern as `category_month`/`recurring_expense_instances`, for the same reason: one real per-user-per-calendar-month row backing every month reference in the schema, not a raw `YYYY-MM` string repeated (and potentially drifting) in every table that needs one
- deleted_at (nullable) — soft delete

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

**Category & recurring-expense activation is per-month, not global.** A category or recurring expense being "active" for a month means a `category_month` / `recurring_expense_instances` row exists for it in that month. There's no "pause" state — not carrying something forward simply means no row gets created for the new month.

**Recurring template value edits — propagation rule.** Editing a recurring expense's `amount_cents` from within a given (unlocked) month always updates that month's instance immediately, then prompts: *"apply this to future months too?"*
- **No** (e.g. a gas bill that's different every month): only this instance changes. The template and every other instance — past or future — are untouched.
- **Yes** (e.g. a rent increase): the template's `amount_cents` updates, and every currently-existing **unlocked** future instance updates to match. Locked (past) instances are never touched regardless of the answer — they're historical record. If it's ever ambiguous whether a given instance counts as "future," default to "only affects months not yet locked."

**Bulk delete of a category's transactions** is always scoped to the single month currently being viewed — there's no "delete everything across months" action, ever. For `transactions` specifically (see the revised delete rule in the Data Model above), a bulk delete is immediate and permanent, same as a single-row delete — there's no batching or undo to coordinate.

**Soft delete + undo — revised, now scoped down to only the entities that haven't been built yet.** The original design here was: nothing hard-deleted, every table gets `deleted_at`, undo clears it within a short window (10min-1h, TBD), bulk actions share a `delete_batch_id` so undo restores the whole batch. `category_month` and `transactions` broke from this first (step 3), for referential-integrity reasons (a soft-deleted transaction could otherwise dangle on a hard-deleted `category_month`). During step 4's review, `categories` and `recurring_expense_templates` — until then still soft-deleted — dropped it too, on an explicit user call: either something can be deleted (nothing references it, ever, past or future) or it's permanently blocked, no third "soft-deleted but still around" state, anywhere. As of step 4, every entity that exists in the schema so far is hard-deleted, no undo. `savings_funds`/`savings_movements`/`income_sources` (steps 6-7, not yet built) still carry the original soft-delete-and-undo design below on paper, but given the direction taken here, re-grill that design when those steps actually get interviewed rather than assuming it stands as originally written.

**Carry-forward, on locking a month.** When a month gets locked (below), the user is shown a checkbox list of the just-locked month's active categories and recurring expenses and picks which ones carry into the new month; anything left unchecked simply isn't activated there. **Planning horizon is capped at one month ahead** — a user can never activate/plan further out than the immediate next month. Planning further ahead than that is a candidate future paid-tier feature, not phase 1.

**Month locking.** Months don't close automatically by calendar date. The month a user sees is always the earliest one, in chronological order, that isn't locked yet (see `budget_months` in the Data Model above — there's no separate "current month" pointer, it's derived). If that month is calendar-wise already in the past, the UI shows a banner: *"Lock month and create new"* (or *"Lock and show current month"* if a later month has already been pre-created — e.g. a paid-tier user who planned further ahead). This gives the user time to add/fix missing transactions from the ended month before it closes. Locking is always explicit — a user can keep editing an "old" month indefinitely, even if the calendar has moved on, until they choose to lock it. Locking a month: makes it immutable (see the referential-integrity callout above), runs the carry-forward flow described above, and makes the next month the new "current" one.

**Auto-lock cascade for empty months.** If a user hasn't opened the app in a while, there can be several unlocked months stacked up between the last locked one and the real current month. They're shown the oldest of these first for explicit review/lock. Once that one's locked, the system walks forward through the rest automatically: any month with zero transactions gets auto-locked without prompting (nothing to review), and the walk stops — requiring explicit review again — the moment it hits a month that actually has data, or the real current month, whichever comes first. Exact definition of "empty" (transactions only, or also untouched recurring instances/activations) — decide precisely during this Build Order step.

## API Schema (Phase 1, GraphQL)

Auth (kept as plain REST/HTTP routes even in a GraphQL API — these are request/response actions, not really "queries", and this avoids weird token-in-mutation patterns)

- `POST /auth/request-otp` — body: `{ email }`. Generates a code (crypto-secure random, e.g. Node's `crypto.randomInt`, never `Math.random`), stores its hash + expiry in `otp_codes`, sends it by email (Resend/Postmark). Rate-limit this hard (see Production Readiness).
- `POST /auth/verify-otp` — body: `{ email, code }`. Validates against `otp_codes` (not expired, not used, `failed_attempts` under the max, hash matches). On a wrong code: increment `failed_attempts`, reject. On a correct code: mark it used, create the user row if it doesn't exist yet (first login = signup), issue an access JWT + a refresh token (persisted in `refresh_tokens`).
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
  monthlyBudgetCents: Int!
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
  recurringExpenseInstance: RecurringExpenseInstance # set only when created via markRecurringPaid; never client-settable, same pattern as direction
}

type RecurringExpenseTemplate {
  id: ID!
  name: String!
  amountCents: Int! # the default/expected value; instances snapshot this, can diverge per-instance
  budgetType: BudgetType!
  dueDay: Int!
  category: Category! # an existing category — creating a template never creates one
}

type RecurringExpenseInstance {
  id: ID!
  month: String! # YYYY-MM, denormalized from the linked BudgetMonth, same pattern as CategoryMonth.month
  amountCents: Int! # snapshotted from the template at creation, can be overridden for just this instance
  template: RecurringExpenseTemplate!
  paidThisMonth: Boolean! # computed: SUM(linked transactions.amountCents) >= amountCents — fully covered, not "any payment exists" (split payments are allowed)
  transactions: [Transaction!]! # every transaction linked via markRecurringPaid this month, not just the most recent
}

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
  movements: [SavingsMovement!]! # ordered date DESC, createdAt DESC
}

type SavingsMovement {
  id: ID!
  amountCents: Int!
  type: MovementType!
  date: String!
}

type IncomeSource {
  id: ID!
  name: String!
  expectedAmountCents: Int!
  actualAmountCents: Int
  month: String! # YYYY-MM, denormalized from the linked BudgetMonth (month_id) — same pattern as CategoryMonth.month
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

input RecurringExpenseTemplateInput {
  name: String!
  amountCents: Int!
  categoryId: ID! # an existing category — never auto-created
  budgetType: BudgetType!
  dueDay: Int!
}

input MarkRecurringPaidInput {
  amountCents: Int! # the actual amount paid — can differ from the instance's amountCents (variable bills like gas/electricity); positive, validated same as TransactionInput
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
  name: String
  targetAmountCents: Int
  startDate: String
  endDate: String
  monthlyTargetCents: Int
}
# initialBalanceCents is intentionally absent from the update input: it's set once at
# creation and never changed, because currentAmountCents is derived from it plus the sum
# of movements — letting it change after movements exist would silently corrupt the balance.

input IncomeSourceInput {
  name: String!
  expectedAmountCents: Int!
  actualAmountCents: Int
  month: String!
}

type Query {
  categories: [Category!]! # full catalog, every category regardless of month — the "reuse an existing category" picker
  categoryMonths(month: String!): [CategoryMonth!]! # this is "which categories are active this month" — a month has an array of categories, not the reverse
  # month filters everywhere in this schema use "YYYY-MM" — same format as IncomeSource.month.
  # Reject anything else at the input-validation layer (see the Dates convention above).
  transactions(month: String!, categoryId: ID): [Transaction!]! # ordered date DESC, createdAt DESC; unpaginated — a month's transactions is a bounded ~100-row list, not the unbounded case pagination is for (see Production Readiness)
  recurringExpenseTemplates: [RecurringExpenseTemplate!]! # full catalog, mirrors `categories`
  recurringExpenseInstances(month: String!): [RecurringExpenseInstance!]! # this month's recurring expenses, mirrors `categoryMonths(month)`
  savingsFunds: [SavingsFund!]!
  incomeSources(month: String): [IncomeSource!]!
}

type Mutation {
  createCategory(input: CategoryInput!): Category! # pure catalog insert, no activation
  updateCategory(id: ID!, input: CategoryInput!): Category! # blocks a direction change if any transaction references this category
  deleteCategory(id: ID!): Boolean! # blocked unless inactive in every month, past and future

  addCategoryToMonth(categoryId: ID!, month: String!, monthlyBudgetCents: Int!): CategoryMonth! # the only activation path in this step; budget always explicit (carry-forward's budget-inheritance path is step 5)
  removeCategoryFromMonth(categoryMonthId: ID!): Boolean! # hard delete; blocked if any transactions reference it that month (delete those first); the "also apply to next month" option is step 5
  updateCategoryMonthBudget(categoryMonthId: ID!, monthlyBudgetCents: Int!): CategoryMonth! # this month's budget only, no template to propagate to

  createTransaction(input: TransactionInput!): Transaction!
  updateTransaction(id: ID!, input: TransactionInput!): Transaction!
  deleteTransaction(id: ID!): Boolean! # hard delete, immediate and permanent, no undo

  createRecurringExpenseTemplate(input: RecurringExpenseTemplateInput!, month: String!, categoryMonthlyBudgetCents: Int): RecurringExpenseTemplate! # month is required — a template is only ever created "for" a month; categoryMonthlyBudgetCents required only if the category isn't already active that month (no derived default from amountCents — see the Data Model note above)
  updateRecurringExpenseTemplate(id: ID!, input: RecurringExpenseTemplateInput!): RecurringExpenseTemplate! # template fields only, no propagation (step 5)
  deleteRecurringExpenseTemplate(id: ID!): Boolean! # blocked unless no instance exists anywhere, past or future — same practical permanence as deleteCategory

  addRecurringExpenseToMonth(templateId: ID!, month: String!, categoryMonthlyBudgetCents: Int): RecurringExpenseInstance! # reuses an existing template; same auto-activation rule as createRecurringExpenseTemplate
  updateRecurringExpenseInstance(id: ID!, amountCents: Int!): RecurringExpenseInstance! # this month's amount override only, no propagation (step 5)
  removeRecurringExpenseFromMonth(id: ID!): Boolean! # hard delete; blocked if any transaction references it (delete those first); "also apply to next month" is step 5
  markRecurringPaid(id: ID!, input: MarkRecurringPaidInput!): Transaction! # creates a new Transaction linked via recurringExpenseInstanceId; can be called more than once per instance (split payments) — never updates an existing transaction

  createSavingsFund(input: CreateSavingsFundInput!): SavingsFund!
  updateSavingsFund(id: ID!, input: UpdateSavingsFundInput!): SavingsFund!
  deleteSavingsFund(id: ID!): Boolean!
  addSavingsMovement(
    fundId: ID!
    amountCents: Int!
    type: MovementType!
  ): SavingsFund!

  createIncomeSource(input: IncomeSourceInput!): IncomeSource!
  updateIncomeSource(id: ID!, input: IncomeSourceInput!): IncomeSource!
  deleteIncomeSource(id: ID!): Boolean!
}
```

> The schema above is illustrative, not final — treat it as the starting shape to interview around (per the "grill me" rule), not a spec to implement verbatim. `initialBalanceCents` is settable only at creation (`CreateSavingsFundInput`) and deliberately absent from `UpdateSavingsFundInput`, since `currentAmountCents` is derived from it plus the sum of movements — allowing it to change after movements exist would silently corrupt the balance.
>
> `Category`, `CategoryMonth`, `Transaction`, `RecurringExpenseTemplate`, and `RecurringExpenseInstance` above all reflect finalized, grilled designs (step 3 and step 4 respectively) — trust all of them now.

Note about enum casing: GraphQL convention is UPPER_CASE enum values (`NEED`, `EXPENSE`), but the DB uses lowercase (`need`, `expense`). Map between the two in the resolver/service layer — don't let the DB casing leak into the GraphQL schema or vice versa. The `GLOSSARY.md` lowercase values are the DB representation. (`budgetType`'s three values were originally Portuguese — `preciso`/`quero`/`poupança`, matching the Excel tracker — translated to English `need`/`want`/`savings` in the codebase; the 50/30/20 meaning is unchanged.)

Note: any relation field on a list — `CategoryMonth.transactions`, `RecurringExpenseInstance.transactions`, `SavingsFund.movements`, but also the reverse direction like `Transaction.categoryMonth`, `Transaction.recurringExpenseInstance`, `RecurringExpenseInstance.template`, `RecurringExpenseTemplate.category` — is a potential N+1. The rule from the Architecture Decision above (DataLoader on every relation-traversing resolver) applies to all of them, not just the two most obvious ones.

## Build Order (suggested milestones for Claude Code sessions)

0. **Ground truth first**: commit `CLAUDE.md`, `GLOSSARY.md`, `plan.md`, and `SCALING.md` to the repo root before writing any code — these are read by Claude Code and define the vocabulary and rules the schema is built from. (They already exist; this step is just "they're in the repo before step 1 starts.")
1. **Project scaffold**: Fastify + TypeScript, GraphQL Yoga/Mercurius wired in, Prisma init, PostgreSQL running locally (Docker recommended), CORS configured, `@fastify/helmet`, Zod-validated env vars at startup, `GET /health` route, graceful shutdown + crash handlers wired up, a trivial `Query.ping` to confirm the whole chain works
2. **Auth (OTP)**: `otp_codes` + `refresh_tokens` tables, email sending wired up (start with logging the code to console in dev, swap in Resend/Postmark before anything real), request-otp/verify-otp/refresh/logout routes, JWT context builder for GraphQL resolvers
3. **Categories + Transactions**: `budget_months` table lands here (schema-only — `locked` stays inert until step 5), plus `categories` (pure catalog, no month-awareness, **hard-deleted** — revised during step 4's review, see "Month Lifecycle" above), `category_month` (the join — row existence = active, budget lives here not on `categories`, **hard-deleted**, `@@unique([categoryId, monthId])`, blocked from deletion while any transaction references it that month), and `transactions` (FK to `category_month`, not `category` directly — structurally enforces "category must be active that month"; **hard-deleted**, no undo). `createCategory` is a pure catalog insert; `addCategoryToMonth`/`removeCategoryFromMonth`/`updateCategoryMonthBudget` are the only activation path in this step (budget always explicit — carry-forward's inheritance path is step 5). DataLoader for `CategoryMonth.transactions`. See "Month Lifecycle" above for the full reasoning, including the soft-delete-and-undo history.
4. **Recurring expenses** — grilled, design finalized (see the Data Model section above): `recurring_expense_templates` (**hard-deleted** — revised during this step's review, matching `categories`; transversal, same shape as `categories` otherwise) + `recurring_expense_instances` (hard-deleted, FK to `budget_months` via `month_id`, same pattern as `category_month`; not one-to-one with transactions — split payments allowed, no uniqueness constraint on `transactions.recurring_expense_instance_id`). Creating/adding a recurring expense to a month auto-activates its category for that month if needed (diverges from `categories`' always-manual activation rule — grilled explicitly, see Data Model note), requiring an explicit `categoryMonthlyBudgetCents` only when that activation actually creates a new `category_month`. `markRecurringPaid` always creates a *new* Transaction (never updates one), can be called more than once per instance; `paidThisMonth` is computed as `SUM(linked transactions) >= instance.amountCents`, not "any transaction exists". `CategoryMonth.recurringCommittedCents` (computed, new field) sums a category's active recurring expenses for the month — feeds the phase-2 "match budget to recurring total" UX flagged under Notes for Claude Code. Template-edit propagation ("apply to future months?") is step 5's job, same as `category_month`'s budget. `updateRecurringExpenseTemplate` blocks a `categoryId` change once any instance exists (same reasoning as `updateCategory`'s direction-change block) — instances don't snapshot their own category, so a later change would retroactively shift `recurringCommittedCents` for already-happened months.
5. **Month lifecycle**: carry-forward flow (with budget-inheritance for `category_month`), month locking + the auto-lock cascade for empty months, recurring-template edit propagation. Soft-delete + undo (with `delete_batch_id` batching) no longer applies to any entity built so far (`categories`, `category_month`, `transactions`, `recurring_expense_templates`, `recurring_expense_instances` are all hard-deleted as of step 4) — only `savings_funds`/`savings_movements`/`income_sources` (steps 6-7) still carry that design on paper, unre-grilled. Depends on steps 3 and 4 both being done.
6. **Savings funds + movements**: CRUD + `addSavingsMovement` updating `currentAmountCents`; DataLoader for `SavingsFund.movements`; `deleted_at` soft-delete from the start, cascading to movements.
7. **Income sources**: CRUD; `deleted_at` soft-delete from the start.
8. **Seed script**: your real categories/funds from the Excel, for realistic test data
9. **Basic tests**: at minimum, auth boundary tests (user A can't read user B's data) and one DataLoader batching check — this is the one thing worth testing before going live

Once the API is solid: **Phase 2** picks up the mobile app plan (screens, design reference, keypad UI etc. — already scoped separately) but wired to this API instead of local SQLite. **Phase 3** is the website as a thin client on top of the same API.

## Production Readiness (build in from Phase 1, not bolted on later)

- **Logging + error tracking**: Fastify ships with pino for structured logging; add Sentry (or similar) so production errors surface without manually grepping logs
- **Error masking**: GraphQL servers by default can leak internal error details (stack traces, raw DB error messages) straight into the response — fine in dev, a real information leak in production. GraphQL Yoga/Mercurius both support masking unexpected errors down to a generic message in production while keeping full detail in server-side logs. Configure this explicitly, don't rely on the default.
- **Disable introspection/playground in production**: GraphQL servers expose a schema introspection query and often a GraphiQL/playground UI by default — great for dev, but in production it hands anyone your entire API schema for free. Both GraphQL Yoga and Mercurius let you turn this off based on `NODE_ENV`.
- **Query depth/complexity limits**: without this, a malicious (or just badly written) deeply nested query can force the server to do disproportionate work — a GraphQL-specific denial-of-service angle that REST doesn't have. `graphql-depth-limit` or a complexity-scoring plugin covers this cheaply.
- **Rate limiting**: critical on `/auth/request-otp` especially — without it, someone can spam a user's inbox or brute-force codes. `@fastify/rate-limit` covers this cheaply
- **Pagination**: `transactions(month, categoryId)` is deliberately unpaginated as of Build Order step 3 — a single month's transactions is a bounded, small list (~100 tops, per the user), not the unbounded case this warning is about. Still applies to any future list that isn't month-scoped (e.g. an eventual "all history" view) — add pagination there from the start when it's built, don't retrofit.
- **Idempotency**: deferred as of Build Order step 3 — `createTransaction` has no retry-dedup mechanism yet. Revisit if/when the mobile or web app surfaces a real duplicate-on-retry issue (flaky connection double-submits, etc.) rather than guarding against a hypothetical now. `addSavingsMovement` isn't built yet (step 6); reconsider idempotency for it when that step starts.
- **Backups**: confirm your chosen hosting provider does automated Postgres backups before real users' data lives there — and do one test restore before you actually need it for real, a backup nobody has ever restored from is an assumption, not a guarantee.
- **Secrets management**: env vars via the hosting platform's secret store, never committed `.env` files with real values
- **GDPR**: this is financial data — once it's public you'll need a privacy policy and a way for a user to export/delete their data (right to erasure). Not needed for solo dev/testing, needed before real signups.
- **Row cleanup**: `otp_codes` and `refresh_tokens` grow with every login and never shrink on their own — expired/used OTP codes and expired/revoked refresh tokens pile up forever. A simple periodic delete (a lightweight scheduled job, or even a "delete expired rows" call piggybacked on the request-otp path) keeps these tables from bloating. Not urgent on day one, but don't let it be never.
- **CI**: run tests + Prisma migrations automatically before any deploy

## Out of scope for Phase 1

- Debts, taxes, annual roll-up view (product backlog, not architecture)
- Offline support / sync conflict resolution
- Open Banking / bank account integration — separate concern entirely (PSD2, an aggregator like GoCardless Bank Account Data or Tink, its own OAuth flow with the bank). Worth revisiting only with real user demand, given the regulatory and cost overhead.
- GraphQL subscriptions / real-time updates (revisit only if a concrete need shows up)
- Full audit trail / field-level edit history on financial records (soft-delete + short-window undo, as of step 4, only still applies on paper to the not-yet-built `savings_funds`/`savings_movements`/`income_sources` — see "Month Lifecycle" above; every entity built so far is hard-deleted with no undo at all, and a full history of every edit ever made to a transaction is a separate, bigger feature regardless, still backlog)
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

## Starter Prompt (paste this into Claude Code to begin)

`CLAUDE.md` (in the repo root) carries the standing rules and is read automatically every session — this prompt only needs to point at the task, not repeat them.

```
Read plan.md and GLOSSARY.md before you start.

Let's go through the backend scaffold (phase 1, "Build Order" section, step 1).

Start by asking me what you need to know for the initial scaffold.
```

For the mobile app phase (phase 2), add: _"Before writing any screen, ask me for the design references (screenshots + Excel structure)."_ (`CLAUDE.md` already covers this generally, but it doesn't hurt to reinforce it at the start of that specific phase.)

## Notes for Claude Code

- Multi-tenancy first: no resolver ships without a `user_id` filter from the auth context, this is not optional even in early dev
- DataLoader on every relation field that can be traversed in bulk — not just categories→transactions and funds→movements, also the reverse direction (transactions→categoryMonth, transactions→recurringExpenseInstance, recurringExpenseInstances→template, recurringExpenseTemplates→category) — don't skip this "for now", it's much more annoying to retrofit
- Follow the "How We Work With Claude Code" practices above for every module: interview before coding, test-first, keep the service layer as the deep-module boundary
- Never log or store raw OTP codes, only their hash
- Keep the Prisma schema and `GLOSSARY.md` as the sources of truth — schema for data shape, glossary for terminology
- Ask before introducing new dependencies beyond the stack listed above
- Graceful shutdown and crash handlers belong in the scaffold step, not bolted on right before deploy — they're much easier to get right when the app is still simple
- **Phase 2 (mobile app), category budget screen — don't let this get lost**: the category-month budget editor must offer a "match to recurring total" action using `CategoryMonth.recurringCommittedCents` (sum of that category's active recurring expenses for the month) feeding directly into the existing `updateCategoryMonthBudget` mutation — one tap, no manual arithmetic. This came out of an explicit grilling during step 4: for a category dominated by recurring expenses with variable amounts (e.g. Housing = fixed rent + variable gas/electricity), requiring the user to hand-sum those before typing a budget number defeats the point of the app doing the tracking. The backend already computes the sum; the frontend just has to surface it and let one tap apply it, rather than asking the user to do that math and type the result in by hand.
