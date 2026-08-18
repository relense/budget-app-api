# Progress

Tracks status against `plan.md`'s Build Order. Updated as each step lands.

## Where we left off (2026-08-18)

On branch `feature/auth-otp`, PR #2 (`feature/auth-otp` → `develop`) is
**open and waiting for review** — https://github.com/relense/budget-app-api/pull/2.
Working tree is clean, local is pushed and in sync with `origin/feature/auth-otp`.

The `pr-reviewer` subagent (`.claude/agents/reviewer.md`) reviewed PR #2 and
found 4 blocking issues, all now fixed with tests, one commit each, and
pushed:
- Email casing/whitespace wasn't normalized — bypassed the request-otp rate
  limit via case variation and risked duplicate `User` rows. Fixed by
  normalizing once in a shared Zod schema (`fe7f220`).
- `POST /auth/verify-otp` had no rate limiting at all. Added a 10/15min
  per-IP+email limit (looser than request-otp's 3/15min since the DB-level
  `failedAttempts` cap is the primary defense) — this number was picked by
  Claude, not explicitly specified by the user, flagging per CLAUDE.md's
  "don't invent details" rule (`1ca64ec`).
- `OtpCode.failedAttempts` was incremented via read-then-write, letting
  concurrent guesses race past the 5-attempt cap. Fixed with Prisma's atomic
  `increment` operator (`d8d3ca3`).
- Refresh-token rotation had a TOCTOU race (revoked/expired check ran
  outside the `$transaction`). Fixed with a conditional atomic `updateMany`
  (`revoked: false`) inside the transaction (`42e7188`).

5 suggestions and 3 nitpicks from the same review were *not* acted on (timing
side-channel on verify-otp's not-found path, missing index on
`refresh_tokens.user_id`, `tokenHash` not `@unique`, no refresh-token-reuse
detection, PR bundling unrelated `.claude/` changes, no explicit
`algorithms: ['HS256']` allowlist in `jwtVerify`, no upper bound on
email/refreshToken field lengths, unconfirmed zod v4 `.email()` deprecation) —
still backlog if wanted later.

Next actions, in order:
1. Wait for PR #2 review/approval — do not merge, do not start step 3 work
   on this branch or a new one until it's approved, per `CLAUDE.md`'s git
   workflow.
2. Once PR #2 is approved and merged into `develop` by the user: sync local
   `develop`, branch `feature/categories-transactions` (or similar) from
   it, and start Build Order step 3 with the usual "grill me" interview
   first — don't jump straight to code.

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
- [ ] **3. Categories + Transactions** — types, queries, mutations, scoped by
      user; DataLoader for `Category.transactions`.
- [ ] **4. Recurring expenses** — CRUD + `markRecurringPaid`; `paidThisMonth`
      computed, not stored.
- [ ] **5. Savings funds + movements** — CRUD + `addSavingsMovement` updating
      `currentAmountCents`; DataLoader for `SavingsFund.movements`.
- [ ] **6. Income sources** — CRUD.
- [ ] **7. Seed script** — real categories/funds from the Excel tracker.
- [ ] **8. Basic tests** — auth boundary tests (user A can't read user B's
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
