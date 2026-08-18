# Progress

Tracks status against `plan.md`'s Build Order. Updated as each step lands.

## Where we left off (2026-08-18)

PR #2 (auth/OTP) was reviewed (twice), approved, and merged into `develop`.
PR #3 (`feature/categories-transactions` → `develop`, Build Order step 3)
is **open, pushed, and has been through four `pr-reviewer` rounds** —
https://github.com/relense/budget-app-api/pull/3. Round 1 found 2 blocking
issues (cross-tenant `addCategoryToMonth`, missing `YYYY-MM` validation),
fixed. Round 2 approved with 3 non-blocking observations. Round 3's fix
for those observations introduced a real regression (reordered a check,
reintroducing a permanent-corrupt-row bug for a different field) —
caught by round 3's own review, fixed, then round 4 approved the fix and
surfaced 2 more suggestion-level findings (a TOCTOU on
`removeCategoryFromMonth` analogous to the already-accepted one on
`addCategoryToMonth`; a stale docstring plus duplicated ownership-check
logic between `categoryService` and `categoryMonthService`), both since
fixed and pushed. Working tree is clean, in sync with origin. See the
Phase 1 checklist below for what step 3 covers and the commit-by-commit
design trail; the PR itself has the full review history if the reasoning
behind any specific fix is needed later.

Before any code, step 3 got an extensive "grill me" pass that materially
changed the shape of `plan.md` itself (not just this step's scope) — see
`plan.md`'s "Month Lifecycle" section and its Data Model section for
`budget_months`/`categories`/`category_month`. Key decisions, in case the
reasoning is needed later:
- Categories split into a pure catalog (`categories`, transversal, no
  month-awareness) plus a real join (`category_month`) that owns all
  month-scoped state — row existence *is* activation, budget lives there
  not on the catalog row.
- Every month reference in the schema (`category_month`, later
  `recurring_expense_instances`, `income_sources`) resolves through one
  real `budget_months` row via `month_id`, not a repeated `YYYY-MM`
  string — `budget_months` had to move up to this step instead of step 5
  for that reason alone.
- `category_month` and `transactions` ended up **hard-deleted, no undo**
  — a deliberate simplification partway through the session, reversing an
  earlier soft-delete-everywhere decision, because keeping `transactions`
  soft-deleted while `category_month` was hard-deleted would let a
  soft-deleted transaction dangle on a `category_month_id` that no longer
  exists. `categories`' own catalog-level soft delete is unaffected.
  `recurring_expense_instances` is flagged as an open question for step
  4's own interview (structurally analogous, might want the same
  treatment).
- `Transaction.direction` is entirely server-derived (dropped from
  `TransactionInput`) now that a transaction can only ever reach one
  category with one fixed direction via `category_month`.

Next actions, in order:
1. Wait for the human review/approval on PR #3 per `CLAUDE.md`'s git
   workflow — don't merge, don't start step 4 on this branch or a new one
   until approved. The automated `pr-reviewer` passes are done; this is
   the human review step.
2. Once merged: sync `develop`, branch for step 4 (Recurring expenses),
   and start with the usual "grill me" interview — it still needs its own
   design pass; the `RecurringExpense` GraphQL type and the
   `recurring_expense_templates`/`recurring_expense_instances` split are
   sketched in `plan.md` but explicitly flagged not-yet-grilled.

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
      (`feature/categories-transactions` → `develop`), open, awaiting
      human review.
- [ ] **4. Recurring expenses** — CRUD on `recurring_expense_templates` +
      generation of `recurring_expense_instances`; `markRecurringPaid`;
      `paidThisMonth` computed, not stored. Needs its own "grill me" pass —
      not yet interviewed.
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
