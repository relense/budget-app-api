# Budget Tracker API

A budget/savings tracker backend, built API-first for real production use — not a local single-device app. GraphQL + REST API on Node.js/Fastify with PostgreSQL, designed to be the single source of truth for a mobile app (and later a website) that will consume it as clients. Portfolio piece, but engineered to be deployed, used by multiple people, and handed off cleanly.

## Stack

- **Runtime**: Node.js 22+, TypeScript (ESM)
- **HTTP**: Fastify
- **API**: GraphQL ([graphql-yoga](https://the-guild.dev/graphql/yoga-server)) + a small REST surface for auth/account
- **Database**: PostgreSQL + [Prisma](https://www.prisma.io/) (via `@prisma/adapter-pg`)
- **Auth**: Passwordless email OTP + JWT (access + rotating refresh tokens)
- **Testing**: Jest + ts-jest
- **Local dev**: Docker Compose (Postgres)

## Getting started

### Prerequisites

- Node.js >= 22
- pnpm (`packageManager` pinned in `package.json`)
- Docker (for local Postgres via Docker Compose)

### Setup

```bash
# 1. Install dependencies (also runs prisma generate + graphql codegen)
pnpm install

# 2. Start Postgres
docker compose up -d

# 3. Copy the env template and fill in values
cp .env.example .env

# 4. Run migrations
pnpm prisma:migrate

# 5. Start the dev server (watch mode)
pnpm dev
```

### Environment variables

Validated at startup via Zod (`src/lib/env.ts`) — the process fails fast on a missing/invalid value instead of starting in a broken state.

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | no | `development` \| `test` \| `production` (default `development`) |
| `PORT` | no | default `4000` |
| `DATABASE_URL` | yes | Postgres connection string |
| `CORS_ORIGIN` | yes | allowed origin for CORS |
| `JWT_SECRET` | yes | must be at least 32 characters |

## Scripts

| Command | Does |
|---|---|
| `pnpm dev` | Run the API in watch mode |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run the compiled build |
| `pnpm test` / `pnpm test:watch` | Run the Jest suite |
| `pnpm lint` | ESLint |
| `pnpm format` | Prettier, write mode |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm prisma:migrate` | Run Prisma migrations (dev) |
| `pnpm prisma:generate` | Regenerate the Prisma client |
| `pnpm seed` | Seed a local `seed@example.com` account with realistic data |
| `pnpm graphql:codegen` | Regenerate typed resolver types from the GraphQL SDL |

## What it does

Multi-tenant budgeting: categories (spending buckets), monthly budgets per category, transactions, recurring expenses (bills that auto-carry forward month to month), savings funds with deposit/withdrawal tracking, and a running bank balance — all scoped per user, auth'd via email OTP. See `docs/FUNCTIONALITIES.md` for the full plain-language walkthrough.

## Documentation

Project docs live in `docs/` and are kept up to date alongside the code:

| Doc | What's in it |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | Architecture, data model, and build order — the design rationale |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | Domain terminology used consistently across code and docs |
| [`docs/SERVICES.md`](docs/SERVICES.md) | Every service's functions, the full GraphQL schema, and REST routes — a living "what exists right now" reference |
| [`docs/FUNCTIONALITIES.md`](docs/FUNCTIONALITIES.md) | Plain-language walkthrough of what the app can do today |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | Build log against `PLAN.md`'s Build Order |
| [`docs/SCALING.md`](docs/SCALING.md) | Growth/scaling reference (not relevant yet) |
| [`.claude/CLAUDE.md`](.claude/CLAUDE.md) | Working rules for this repo (multi-tenancy, TDD, git workflow, etc.) |

## Project conventions

- **Money is always integer cents** (`amountCents`, etc.), never floats.
- **Multi-tenancy is non-negotiable** — every resolver/service function scopes by `userId`.
- **Branch per feature**, PRs into `develop`; merges into `main` are done by a human.

Full rules in [`.claude/CLAUDE.md`](.claude/CLAUDE.md).
