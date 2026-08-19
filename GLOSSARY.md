# Glossary — Budget Tracker Domain Language

Shared vocabulary for this project. Use these terms exactly — in prompts to Claude Code, in the GraphQL schema, and in code (types, variable names, function names). If a new domain concept comes up, add it here before writing code that uses it.

## Core entities

**Category**
A general spend-classification label the user defines once (e.g. "Shopping", "Health", "Housing") — has a name, icon/color, `budgetType`, and `direction`, but no monthly budget of its own and no month-awareness at all. Reusable across every month it's ever active in.

**CategoryMonth**
A Category's activation for one specific month — this is where the actual monthly budget lives (`monthlyBudgetCents`), not on Category itself. A category with no CategoryMonth row for a given month simply isn't active that month. Transactions link to a CategoryMonth, not directly to a Category, which structurally guarantees a transaction can only exist against a category that was actually active that month.

**Transaction**
A single, one-off money movement tied to a CategoryMonth — an expense or income entry the user logged manually (e.g. "€19.30 at Auchan"), or one created by marking a Recurring Expense paid. Has a date, amount, optional merchant and note.

**Recurring Expense** (Portuguese: "Conta") — *flat redesign, supersedes the old Template/Instance split below*
A bill that repeats monthly (e.g. "Rent, 800€, day 1") — but unlike the original design, it's a single flat row that lives *in* one month: name, category, amount, due day, budgetType, all on that one row. No transversal, month-independent "definition" table. What a Transaction links to via `recurringExpenseId`, and what gets marked paid. Never itself a category, and never creates one — it points at an existing Category (e.g. Rent → Housing). Not one-to-one with Transactions: paying rent in two installments means two Transactions linked to the same row (see `paidThisMonth` below). Moving to a new month copies the previous month's rows forward automatically (fresh, unpaid) — no per-item opt-in, and no identity link between one month's row and the next (each is fully independent; if cross-month history is ever needed, it's a query by name/category, not a schema relationship).

> ~~**Recurring Expense Template**~~ / ~~**Recurring Expense Instance**~~ — superseded. Originally split into a transversal "template" (the reusable definition, reusable across every month like Category is to CategoryMonth) plus a per-month "instance" (the template's occurrence in one month, snapshotting its amount). Dropped because recurring expenses, unlike categories, have no dormant/month-independent existence — "it only exists because you're tracking paying something now" — so a table modeling that independent existence didn't earn its complexity. See `plan.md`'s Data Model section for the full reasoning and `PROGRESS.md` for build status.

**Savings Fund**
A named savings goal (e.g. "Emergency Fund", "Wedding"). Has a target amount, a current amount, optionally a start/end date and a monthly savings target. Distinct from a Category — funds are about accumulating toward a goal, categories are about monthly spending.

**Savings Movement**
A single deposit or withdrawal into/out of a Savings Fund. Same relationship to Fund as Transaction has to Category: the fund is the running total, the movement is the individual event that changed it.

**Income Source**
A recurring or expected source of income for a given month (e.g. salary, freelance extra), tracked as expected vs. actual amount per month.

## Fields and enums

**Money values** (`amountCents`, `monthlyBudgetCents`, `targetAmountCents`, etc.)
Always an integer number of cents, never a float. The `Cents` suffix on every money field name is deliberate and mandatory — a field just called `amount` on a new type would be a naming mistake. The ×100 / ÷100 conversion for display and input happens only in the frontend, at the UI edge — never in the API or DB layer.

**budgetType** (DB: `need` | `want` | `savings`)
The 50/30/20 classification (Need / Want / Savings) from the original Excel tracker (originally `preciso`/`quero`/`poupança` in the Excel — translated to English for the codebase; the underlying 50/30/20 meaning is unchanged). Applies to Categories and Recurring Expenses, not to individual Transactions (a transaction inherits its category's budgetType). The lowercase values here are the DB representation; the GraphQL schema exposes them UPPER_CASE (`NEED` etc.) per GraphQL convention — the resolver/service layer maps between the two.

**direction** (DB: `expense` | `income`)
Whether money is leaving or entering. Applies to Categories and Transactions. Same DB-lowercase / GraphQL-UPPER_CASE mapping as `budgetType`.

**achieved** (boolean, on Savings Fund)
True once `currentAmountCents` has reached `targetAmountCents`. Distinct from "fully funded on schedule" — it's just a threshold flag, not a projection.

**paidThisMonth** (boolean, on Recurring Expense — computed, not stored)
`SUM(amountCents)` across every Transaction linked to this row `>= amountCents` — fully covered, not "any payment logged." Split payments (e.g. rent paid in two installments) are allowed and expected; the sum accounts for all of them. Not a raw DB column — see "Notes for Claude Code" in the project plan for why (avoids a scheduled monthly reset job).

**recurringCommittedCents** (Int, on CategoryMonth — computed, not stored)
`SUM(amountCents)` across every Recurring Expense active under that category for that month (e.g. Housing → Rent + Electricity + Gas). Exists so a category's manually-set `monthlyBudgetCents` never needs hand-calculating against its recurring expenses — see the phase-2 UX note under "Notes for Claude Code" in the project plan.

## Auth terms

**OTP (One-Time Code)**
The 6-character code emailed to the user for passwordless login. Alphanumeric (uppercase A-Z + digits 2-9, excluding ambiguous characters 0/O/1/I/L), verified case-insensitively. Short-lived, single-use, stored only as a hash.

**Access Token**
Short-lived JWT (5-15 min) proving the user is authenticated for the current request. Not persisted server-side — stateless, decoded per-request.

**Refresh Token**
Longer-lived token, persisted in the DB per device/session, used to obtain new Access Tokens without re-doing OTP login. Revocable independently per device (single-device logout) or all at once for a user ("sign out everywhere") — both distinct from revoking the user's account.

## Explicitly NOT the same thing

- **Transaction vs. Recurring Expense**: a Transaction is one real payment event; a Recurring Expense is the thing being tracked/paid, satisfied by zero, one, or more Transactions (split payments). Marking one paid creates a *new* Transaction each time, it isn't one itself.
- **Recurring Expense vs. Category**: a Category is a general spend-classification label ("Housing") that many unrelated Transactions can share; a Recurring Expense is one specific identified obligation ("Rent") that happens to carry a category tag. Creating a Recurring Expense never creates a Category, and a Recurring Expense's own `amountCents` is never derived from — or used to derive — its category's `monthlyBudgetCents`; they're independent numbers by design (see `recurringCommittedCents` above for the field that bridges them for display purposes only).
- **Category vs. CategoryMonth**: Category is the reusable catalog entry (transversal, no month-awareness); CategoryMonth is one month's activation of it (where the budget actually lives). Unlike the old Recurring Expense Template/Instance split (now superseded), this asymmetry is intentional for Category specifically — a category can meaningfully sit dormant in the catalog with no month, which is exactly the property Recurring Expense doesn't have.
- **Category vs. Savings Fund**: Categories are monthly spending buckets that reset each month. Savings Funds are long-running balances that accumulate over time, unrelated to any single month.
- **Access Token vs. Refresh Token**: Access = short-lived, stateless, used on every request. Refresh = long-lived, stored server-side, used only to mint new Access Tokens.
