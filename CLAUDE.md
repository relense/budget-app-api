# Budget Tracker — Project Instructions

Full architecture, data model, and build order: `plan.md`.
Domain terminology: `GLOSSARY.md` — use these terms exactly in code (types, variables, function names).
Growth/scaling reference (not relevant yet): `SCALING.md`.

## Rules (apply every session, not just the first)

- **Never invent details.** If something isn't decided in `plan.md`, ask before writing code — don't fill the gap with a "reasonable" default.
- **Interview before coding ("grill me").** Before starting a new module or feature, ask about edge cases, data shapes, and error behavior until there's a shared understanding — don't jump from a one-line request straight to code.
- **TDD, small steps.** Failing test → minimal code to pass → refactor. Don't generate a whole module in one shot.
- **Money is always integer cents** (`amountCents` etc.), never float. The ×100/÷100 conversion happens only in the frontend.
- **Multi-tenancy is non-negotiable.** Every resolver reads `userId` from the authenticated context and scopes its query by it — no exceptions, not even in early dev.
- **Interface changes get flagged explicitly.** Before changing a GraphQL type, a service function signature, or the Prisma schema, say so up front — don't let it happen as a side effect of unrelated work.
- **Frontend work: ask, don't assume.** For every screen/component, ask for layout, states, copy, colors, and edge-case behavior first. Before starting the mobile app specifically, ask for the design references (mockups + Excel structure) rather than relying on memory of past conversations.
- **No new dependencies without asking first.**
- **Production hardening isn't a later step.** Graceful shutdown, crash handlers, env var validation, security headers, and GraphQL introspection/depth limits belong in the code as it's written, not retrofitted right before deploy.

## Stack

Node.js + TypeScript, Fastify, GraphQL (Yoga or Mercurius), PostgreSQL + Prisma, Jest + ts-jest, Docker Compose for local dev.

## Git Workflow

- **Branch per feature.** No direct commits to `main` or `develop`. Before starting a new feature, create a branch from an up-to-date `develop`.
- **Naming:** `feature/short-descriptive-name` (e.g. `feature/auth-jwt`, `feature/transactions-crud`). For fixes: `fix/short-name`. For chores/setup: `chore/short-name`.
- **One logical commit per TDD step** (not one giant commit at the end of the feature). Message format: `type: short description` (e.g. `feat: add transaction resolver`, `test: cover negative amount validation`, `refactor: extract cents conversion helper`).
- **When a feature is ready:** open a PR from the feature branch into `develop` and stop. Do not merge, do not push further commits, do not start the next task — wait for review.
- **After review:** if changes are requested, address them on the same branch and push. If approved, the merge is done by the human — never by Claude.
- **Merges into `main`** (from `develop`) are always done by the human, outside of Claude's scope entirely.
- **Never assume approval.** If there is no explicit "approved" or "LGTM", stay on the current branch and wait.
