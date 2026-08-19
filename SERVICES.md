# Services & API Reference

Quick lookup of what exists right now: every service and what it does, every
GraphQL query/mutation, every REST route. This is a **map of the current
surface**, not a design-rationale doc — for *why* something works the way it
does, see `plan.md`; for domain terminology, see `GLOSSARY.md`.

**Keep this current.** Whenever a service gains/loses a function, a
dependency changes, or the GraphQL schema/REST routes change, update the
relevant section here in the same commit — same "living document" rule as
`plan.md`.

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
| `lockMonth(userId, month)` | Locks the target month permanently — must be the current (earliest unlocked) month, or throws `budget_month_not_current`. No carry-forward or next-month creation here; the client drives those separately afterward if the user wants them, using the same `addCategoryToMonth`/`addRecurringExpenseToMonth` mutations (budget auto-inherits when omitted). |
| `deleteBudgetMonth(userId, month)` | Hard delete for an unlocked month the user pre-provisioned but decided not to use. Blocked while any `category_month` references it — same "remove what's in it first" pattern as `deleteCategory`/`deleteTemplate`. |

Also exports **`resolveBudgetMonthId(client, userId, month)`** standalone
(client-parameterized) — lets a caller with its own open transaction run
this as part of that transaction instead of on the service's own connection.

### `categoryService` — `src/services/categories/categoryService.ts`

Pure catalog CRUD for categories — no month-awareness at all. Deps: `prisma`.

| Function | Does |
|---|---|
| `listCatalog(userId)` | Every category for this user. |
| `findManyByIds(ids)` | Batch lookup for DataLoader use. |
| `createCategory(userId, input)` | Requires `budgetType` when `direction: 'expense'`; not meaningful (and stored `null`) for `'income'`. |
| `updateCategory(userId, id, input)` | Blocks a `direction` change if any transaction already references this category. |
| `deleteCategory(userId, id)` | Hard delete, blocked while any `category_month` row references it, for any month past or future. |

Also exports **`assertOwnedCategory(client, userId, id)`** standalone — the
shared ownership-check, reused by `categoryMonthService` and
`recurringExpenseTemplateService` against either the outer `prisma` or a
transactional client — and **`assertValidBudgetType(direction, budgetType)`**
standalone, reused by `authService`'s default-category seeding on signup so
a future change to this rule can't silently drift from what gets seeded.

### `categoryMonthService` — `src/services/categories/categoryMonthService.ts`

The real per-month join — a category is "active" in a month iff a row
exists here. Owns the month's budget. Deps: `prisma`, `budgetMonthService`,
`now?` (defaults to the real clock; overridable for tests).

| Function | Does |
|---|---|
| `listByMonth(userId, month)` | Every active category for that month. |
| `findManyByIds(ids)` | Batch lookup for DataLoader use. |
| `addCategoryToMonth(userId, categoryId, month, monthlyBudgetCents?)` | Explicit activation; errors if already active that month (`category_month_already_active`). `monthlyBudgetCents` is optional — inherits the category's most recent (by real calendar month, not insertion order) `category_month`'s budget when omitted, or throws `category_month_budget_required` if this category has never been active anywhere yet. Rejects a genuinely new activation more than one month past the derived current month (`category_month_beyond_planning_horizon`) — see below. |
| `ensureActiveForCategory(userId, categoryId, month, monthlyBudgetCents?)` | Idempotent — returns the existing row if already active (no planning-horizon check in that case — pre-provisioned activations are never retroactively rejected). Same budget-inheritance rule as `addCategoryToMonth` when it actually creates one. Used by recurring-expense auto-activation. |
| `removeCategoryFromMonth(userId, categoryMonthId)` | Hard delete, blocked while any transaction references it that month. |
| `updateCategoryMonthBudget(userId, categoryMonthId, monthlyBudgetCents)` | This month's budget only. |

Also exports **`ensureActiveForCategoryOnClient(client, userId, categoryId, month, monthlyBudgetCents?, now?)`**
standalone — lets a caller with its own open transaction (e.g.
`recurringExpenseInstanceService`) run activation as part of that
transaction, so a row lock taken earlier in the same transaction actually
protects this step too.

**Planning horizon.** A category can never be newly activated more than one
calendar month past the derived "current" month (see `budgetMonthService`
below) — plan.md's Month Lifecycle rule, enforced server-side via
`assertWithinPlanningHorizon(currentMonth, month)`. It's a pure sync
comparison, not a query — every call site must derive `currentMonth` via
`findCurrentMonthOnClient` itself, and must do so *before* calling
`resolveBudgetMonthId` for the target month: `resolveBudgetMonthId` upserts
(permanently creates) a `BudgetMonth` row for that month, and since a
freshly created row is always unlocked, it would otherwise become the
"earliest unlocked" candidate the current-month derivation picks up,
self-satisfying the check for exactly the case (a brand-new activation with
no other unlocked month yet) it most needs to catch. Exported standalone so
`recurringExpenseInstanceService`'s auto-activation path enforces the
identical rule, not a separately-maintained copy.

### `transactionService` — `src/services/categories/transactionService.ts`

CRUD for individual transactions. `direction` is always server-derived from
the category, never client-settable. Deps: `prisma`, `budgetMonthService`.

| Function | Does |
|---|---|
| `create(userId, input, recurringExpenseInstanceId?)` | The third param is internal-only (never client-settable) — only `markRecurringPaid` passes it, to link the transaction to a recurring-expense instance. |
| `update(userId, id, input)` | Re-derives `direction` if `categoryMonthId` changes to a different-direction category. |
| `deleteTransaction(userId, id)` | Hard delete, immediate and permanent, no undo. |
| `list(userId, month, categoryId?)` | Ordered date DESC, then createdAt DESC. |
| `listByCategoryMonthIds(ids)` | Batch lookup for DataLoader use. |
| `listByRecurringExpenseInstanceIds(ids)` | Batch lookup for DataLoader use — backs `RecurringExpenseInstance.transactions` and `paidThisMonth`. |

All writes are blocked once the target month is locked (`month_locked`) —
live and race-safe as of `budgetMonthService.lockMonth` (Build Order step
5): `create`/`update`/`deleteTransaction` all run inside a transaction
that takes `lockBudgetMonthRow` (`SELECT ... FOR UPDATE`) before checking
`locked`, so the check is genuinely serialized against a concurrent
`lockMonth` call rather than racing a plain read.

### `recurringExpenseTemplateService` — `src/services/recurringExpenses/recurringExpenseTemplateService.ts`

Catalog CRUD for recurring-expense definitions (e.g. "Rent, 800€, day 1") —
transversal, no month-awareness, always points at an existing category.
Deps: `prisma`.

| Function | Does |
|---|---|
| `listCatalog(userId)` | Every template for this user. |
| `findManyByIds(ids)` | Batch lookup for DataLoader use. |
| `createTemplate(userId, input)` | Validates amount/dueDay/budgetType (`need`\|`want` only — `savings` rejected) and that the category is `expense`-direction. |
| `updateTemplate(userId, id, input)` | Blocks a `categoryId` change once any instance exists (would retroactively shift `recurringCommittedCents` for already-happened months) — race-safe via `lockTemplateRow`. |
| `deleteTemplate(userId, id)` | **Hard delete**, blocked while any instance references it anywhere, past or future — backed by a real `onDelete: Restrict` FK. |

Also exports three standalone, client-parameterized functions used by
`recurringExpenseInstanceService`:
- **`assertValidTemplateInput(client, userId, input)`** — the four checks
  above, read-only, usable before an unrelated write that must not happen
  if the input is invalid.
- **`assertOwnedTemplate(client, userId, id)`** — ownership check.
- **`lockTemplateRow(tx, id)`** — `SELECT ... FOR UPDATE` on the template
  row; must run inside a `$transaction`. Serializes a `categoryId` change
  against a concurrent instance creation for the same template.

### `recurringExpenseInstanceService` — `src/services/recurringExpenses/recurringExpenseInstanceService.ts`

Per-month instances of a recurring-expense template — hard-deleted, FK to
`budget_months`. This is what a `Transaction` actually links to via
`markRecurringPaid`. Deps: `prisma`, `budgetMonthService`, `transactionService`
(does **not** depend on `categoryMonthService`/`templateService` — it calls
their standalone client-parameterized functions directly instead, so the
whole lock → activate → insert sequence runs in one transaction).

| Function | Does |
|---|---|
| `createTemplateForMonth(userId, input, month, categoryMonthlyBudgetCents?)` | First-time creation: template + category-activation + instance, all in one transaction. Returns `{ template, instance }`. |
| `addRecurringExpenseToMonth(userId, templateId, month, categoryMonthlyBudgetCents?)` | Reuses an existing template into a new month; locks the template row and re-reads its category *inside* that lock before activating. |
| `updateInstance(userId, instanceId, amountCents)` | This month's amount override only. |
| `removeFromMonth(userId, instanceId)` | Hard delete, blocked while any transaction references it. |
| `markRecurringPaid(userId, instanceId, input)` | Always creates a **new** `Transaction` (never updates one) — callable more than once per instance for split payments. |
| `listByMonth(userId, month)` | Every active instance for that month. |
| `findManyByIds(ids)` | Batch lookup for DataLoader use. |
| `sumCommittedCentsForCategoryMonth(categoryId, monthId)` | Sums `amountCents` across every active instance under that category/month — backs `CategoryMonth.recurringCommittedCents`. |

Both instance-creation paths auto-activate the category via
`ensureActiveForCategoryOnClient` — the one deliberate exception to
categories' otherwise-always-manual activation rule (see `plan.md`).

---

## Supporting libs — `src/lib/`

Not services (no `userId`-scoped business logic), but worth knowing exist:

| File | Exports |
|---|---|
| `prisma.ts` | `createPrismaClient(databaseUrl)` — Prisma 7 client via `@prisma/adapter-pg`. |
| `jwt.ts` | `signAccessToken`/`verifyAccessToken` — jose, HS256. |
| `otp.ts` | `generateOtpCode`/`hashOtpCode`/`verifyOtpCode`/`OTP_CODE_REGEX` — argon2. |
| `refreshToken.ts` | `generateRefreshToken`/`hashRefreshToken` — sha256 (already high-entropy, unlike OTP codes). |
| `email.ts` | `EmailService` interface + `createConsoleEmailService` (logs instead of sending — real provider deferred per `plan.md`). |
| `env.ts` | `loadEnv` — Zod-validated env vars, fails fast at startup. |
| `monthFormat.ts` | `isValidMonthFormat` — the one place `"YYYY-MM"` validation lives. |
| `shutdown.ts` | `createShutdownHandler` — `SIGTERM`/`SIGINT` + crash handlers. |

---

## API Endpoints

### REST — Fastify (`src/routes/auth.ts`, `src/server.ts`)

All bodies are Zod-validated; a validation failure returns `400 { error: "validation_error", issues }`.

| Method & Path | Body | Success | Notes |
|---|---|---|---|
| `POST /auth/request-otp` | `{ email }` | `200` | Rate-limited 3/15min by IP+email. Always `200` regardless of whether the email exists (no enumeration). |
| `POST /auth/verify-otp` | `{ email, code, deviceLabel? }` | `200 { accessToken, refreshToken, user }` | Rate-limited 10/15min by IP+email (secondary backstop — `failedAttempts` on the code itself caps guesses at 5). `401` with a specific `error` code on failure (`code_not_found`\|`code_expired`\|`too_many_attempts`\|`incorrect_code`). |
| `POST /auth/refresh` | `{ refreshToken }` | `200 { accessToken, refreshToken }` | Mandatory rotation — old token is revoked, reusing it fails. `401 { error: "refresh_token_invalid" }` on failure. |
| `POST /auth/logout` | `{ refreshToken }` | `204` | Revokes one refresh token. |
| `POST /auth/logout-all` | — (Bearer access token) | `204` | Revokes every refresh token for the authenticated user. `401` if the access token is missing/invalid. |
| `GET /health` | — | `200 { status: "ok" }` | Real DB check (`SELECT 1`); `503` on failure. |

### GraphQL — `POST/GET /graphql` (`src/graphql/schema.ts`)

Auth via `Authorization: Bearer <accessToken>`. Every field except
`ping` requires it — unauthenticated requests get `UNAUTHENTICATED`.
Every resolver re-checks `userId` itself (no single top-level auth gate).
Service errors map to `GraphQLError` with `extensions.code` = the service's
error reason, upper-cased (e.g. `category_not_found` → `CATEGORY_NOT_FOUND`).
Introspection and query-depth (max 10) are limited in production.

**Query**

| Field | Args | Returns |
|---|---|---|
| `ping` | — | `String!` (no auth required) |
| `currentMonth` | — | `BudgetMonth!` |
| `categories` | — | `[Category!]!` |
| `categoryMonths` | `month: String!` | `[CategoryMonth!]!` |
| `transactions` | `month: String!, categoryId: ID` | `[Transaction!]!` |
| `recurringExpenseTemplates` | — | `[RecurringExpenseTemplate!]!` |
| `recurringExpenseInstances` | `month: String!` | `[RecurringExpenseInstance!]!` |

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
| `createRecurringExpenseTemplate` | `input: RecurringExpenseTemplateInput!, month: String!, categoryMonthlyBudgetCents: Int` | `RecurringExpenseTemplate!` |
| `updateRecurringExpenseTemplate` | `id: ID!, input: RecurringExpenseTemplateInput!` | `RecurringExpenseTemplate!` |
| `deleteRecurringExpenseTemplate` | `id: ID!` | `Boolean!` |
| `addRecurringExpenseToMonth` | `templateId: ID!, month: String!, categoryMonthlyBudgetCents: Int` | `RecurringExpenseInstance!` |
| `updateRecurringExpenseInstance` | `id: ID!, amountCents: Int!` | `RecurringExpenseInstance!` |
| `removeRecurringExpenseFromMonth` | `id: ID!` | `Boolean!` |
| `markRecurringPaid` | `id: ID!, input: MarkRecurringPaidInput!` | `Transaction!` |

**Types**: `Category`, `CategoryMonth` (+ computed `recurringCommittedCents`),
`Transaction` (+ nullable `recurringExpenseInstance`), `RecurringExpenseTemplate`,
`RecurringExpenseInstance` (+ computed `paidThisMonth`). Enums: `BudgetType`
(`NEED`\|`WANT`\|`SAVINGS`), `Direction` (`EXPENSE`\|`INCOME`) — DB stores
lowercase, GraphQL exposes upper-case, mapped in `enumMapping.ts`.

**DataLoaders** (`src/graphql/loaders.ts`, rebuilt fresh per request — never
cached across requests/users): `categoryById`, `categoryMonthById`,
`budgetMonthById`, `transactionsByCategoryMonthId`,
`recurringExpenseTemplateById`, `recurringExpenseInstanceById`,
`transactionsByRecurringExpenseInstanceId`,
`recurringCommittedCentsByCategoryMonthId`.
