# Progress

Tracks status against `plan.md`'s Build Order. Updated as each step lands.

## Where we left off (2026-08-19)

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
  "match budget to recurring total" action — flagged under plan.md's
  "Notes for Claude Code" so it isn't lost before Phase 2.
- **Soft-delete + undo dropped for `categories` and
  `recurring_expense_templates`**, mid-review-cycle, on an explicit user
  call: either something can be deleted (nothing references it, ever) or
  it's permanently blocked by what references it — no third "soft-deleted
  but still around" state, for any entity built so far. Every entity that
  exists in the schema as of step 4 is now hard-deleted, no undo (see
  plan.md's "Soft delete + undo" paragraph). `recurring_expense_templates`
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
current alongside `plan.md`/`GLOSSARY.md` — not a design-rationale doc, a
quick "what exists right now" lookup.

Next actions, in order:
1. Wait for human review/approval on PR #4 per `CLAUDE.md`'s git
   workflow — don't merge, don't start step 5 until approved.
2. Separately: branch off `develop` for `categories`' soft→hard delete
   follow-up (drop `deleted_at`, update `categoryService`/
   `categoryMonthService` and their tests) — its own PR, not bundled into
   step 4.
3. Once both are merged: sync `develop`, branch for step 5 (Month
   lifecycle), and start with its own "grill me" interview.

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
      PR #4 (`feature/recurring-expenses` → `develop`), open, reviewed
      (4 rounds, approved on round 4), awaiting human review.
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
