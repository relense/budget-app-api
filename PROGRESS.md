# Progress

Tracks status against `plan.md`'s Build Order. Updated as each step lands.

## Where we left off (2026-08-18)

PR #2 (auth/OTP) and PR #3 (`feature/categories-transactions`, Build Order
step 3) are both reviewed, approved, and merged into `develop`. After PR #3
merged, two repo-wide sweeps landed directly: `budgetType`'s three DB values
were translated from Portuguese (`preciso`/`quero`/`poupanca`) to English
(`need`/`want`/`savings`) across schema, code, and docs; and the migration
history was squashed from 6 migrations down to 1 (`20260818183149_init`) —
safe only because nothing had deployed yet and no real data existed.

Build Order step 4 (Recurring expenses) got its own extensive "grill me"
pass (see `plan.md`'s Data Model section for `recurring_expense_templates`/
`recurring_expense_instances`, and its "Recurring expenses vs. transactions",
"Recurring expenses are not categories", and "Category activation is
automatic for recurring expenses" prose sections) and is now fully
implemented — service layer, GraphQL layer, and a real-Postgres smoke test —
on branch `feature/recurring-expenses`, not yet pushed/PR'd. Key decisions
from that interview, in case the reasoning is needed later:
- `recurring_expense_templates` (soft-deleted, transversal — same shape as
  `categories`) + `recurring_expense_instances` (hard-deleted, FK to
  `budget_months` via `month_id` — same shape as `category_month`): a
  recurring expense is its own identity, explicitly *not* a category, even
  though creating/adding one to a month auto-activates its (existing)
  category for that month — the one deliberate exception to categories'
  otherwise-always-manual activation rule.
- No derived default for the auto-created `category_month`'s budget —
  `categoryMonthlyBudgetCents` must be given explicitly when activation
  actually creates a new row. A category like Housing can bundle a fixed
  recurring expense (rent) with variable ones (gas, electricity); deriving
  the budget from any single recurring expense's `amountCents` would be
  wrong on its face.
- Recurring expenses allow **split payments**: `transactions.recurring_
  expense_instance_id` has no uniqueness constraint, and `paidThisMonth` is
  `SUM(linked transactions.amountCents) >= instance.amountCents`, not "any
  payment exists."
- `CategoryMonth.recurringCommittedCents` (computed, GraphQL-only) sums a
  category's active recurring expenses for the month, specifically so a
  future mobile "match budget to recurring total" action can read this and
  feed it straight into `updateCategoryMonthBudget` — flagged under
  plan.md's "Notes for Claude Code" so it isn't lost before Phase 2.

Next actions, in order:
1. Push `feature/recurring-expenses`, open a PR into `develop`, run the
   `pr-reviewer` subagent, and address findings per the usual multi-round
   pattern from steps 2 and 3.
2. Wait for human review/approval per `CLAUDE.md`'s git workflow — don't
   merge, don't start step 5 until approved.
3. Once merged: sync `develop`, branch for step 5 (Month lifecycle), and
   start with its own "grill me" interview.

## Phase 1 — Backend

- [x] **0. Ground truth** — `CLAUDE.md`, `GLOSSARY.md`, `plan.md`, `SCALING.md` committed.
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
      provider deferred, per plan.md). Manually smoke-tested end to end
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
- [x] **4. Recurring expenses** — `recurring_expense_templates` (soft-deleted,
      transversal catalog, budget_type restricted to `need`/`want` — `savings`
      rejected at runtime via `invalid_budget_type`) + `recurring_expense_
      instances` (hard-deleted, FK to `budget_months`, `@@unique([templateId,
      monthId])`). Two services: `recurringExpenseTemplateService` (create/
      update/delete — delete blocked while any instance exists anywhere, past
      or future) and `recurringExpenseInstanceService` (`createTemplateForMonth`
      returns `{ template, instance }`; `addRecurringExpenseToMonth` reuses a
      template into a new month; both auto-activate the category for that
      month via `categoryMonthService.ensureActiveForCategory`, a new
      idempotent "ensure active, no derived budget default" primitive distinct
      from `addCategoryToMonth`'s error-on-duplicate semantics; `updateInstance`,
      `removeFromMonth` — blocked while any transaction references it;
      `markRecurringPaid` — always creates a *new* `Transaction` linked via
      `recurringExpenseInstanceId`, callable more than once per instance for
      split payments; `sumCommittedCentsForCategoryMonth` backs the new
      `CategoryMonth.recurringCommittedCents` computed field).
      `transactionService` gained an internal-only third `create` param
      (`recurringExpenseInstanceId`, never client-settable) and
      `listByRecurringExpenseInstanceIds` for DataLoader use. 191 Jest tests
      total (was 149 after step 3), the fake-Prisma double consolidated into
      one shared file per composition graph rather than duplicated per
      service directory (a lesson carried over from a step-3 review finding).
      Full GraphQL schema/resolvers (`RecurringExpenseTemplate`/
      `RecurringExpenseInstance` types, their inputs, all seven mutations,
      both queries) and four new DataLoaders (`recurringExpenseTemplateById`,
      `recurringExpenseInstanceById`, `transactionsByRecurringExpenseInstanceId`,
      `recurringCommittedCentsByCategoryMonthId`). Manually smoke-tested end
      to end against real Postgres (25 checks: full mutation/query lifecycle,
      split-payment `paidThisMonth` transition, `SAVINGS` budgetType
      rejection, duplicate-add rejection, cross-tenant rejection, blocked
      delete/remove while referenced, unauthenticated rejection). →
      `feature/recurring-expenses`, not yet pushed.
- [ ] **5. Month lifecycle** — carry-forward (with budget-inheritance for
      `category_month`), month locking + auto-lock cascade for empty months,
      recurring-template edit propagation, soft-delete + undo for the
      entities that still have it. Depends on steps 3 and 4 both being done.
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
screen work begins, per `plan.md`.

## Phase 3 — Website

Not started.

## Notable deviations / decisions from plan.md

- Prisma 7's client generator requires a driver adapter — added
  `@prisma/adapter-pg` (plan.md assumed the classic bare-`DATABASE_URL` setup).
- `prisma init` auto-vendors AI-agent skill docs into `.claude/`, `.windsurf/`,
  `.agents/` — removed, unrelated to the app.
- ID strategy for every table (not specified in plan.md): UUID v4, stored as
  native Postgres `uuid` columns (`@db.Uuid`), confirmed with the user during
  the auth step since it's a precedent-setting choice.
- OTP hashing: argon2 (not scrypt/sha256) — confirmed with the user; refresh
  tokens use sha256 since they're already high-entropy random secrets, not
  low-entropy codes.
- JWT library: `jose` (ESM-native) over `jsonwebtoken`/`@fastify/jwt`.
- Row cleanup for expired/used `otp_codes` and expired/revoked
  `refresh_tokens` is not implemented yet — plan.md flags this as "not urgent
  on day one, but don't let it be never." Still backlog.
- OTP codes are alphanumeric, not digits-only (GLOSSARY.md/plan.md originally
  said "6-digit" — updated to "6-character"): uppercase A-Z + digits 2-9,
  excluding ambiguous characters (0/O, 1/I/L), verified case-insensitively.
  Confirmed with the user; charset/case/length were all explicit choices,
  not defaults.
