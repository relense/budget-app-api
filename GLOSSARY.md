# Glossary — Budget Tracker Domain Language

Shared vocabulary for this project. Use these terms exactly — in prompts to Claude Code, in the GraphQL schema, and in code (types, variable names, function names). If a new domain concept comes up, add it here before writing code that uses it.

## Core entities

**Category**
A budget bucket (e.g. "Shopping", "Health"). Has a monthly budget, an icon/color, a `budgetType`, and a `direction`. Categories group both transactions and recurring expenses.

**Transaction**
A single, one-off money movement tied to a category — an expense or income entry the user logged manually (e.g. "€19.30 at Auchan"). Has a date, amount, optional merchant and note.

**Recurring Expense** (Portuguese: "Conta")
A bill that repeats monthly with a fixed (or expected) amount and a due day (e.g. rent, phone plan). Tracked separately from one-off Transactions because it has a paid/unpaid state each month. When marked paid, it creates a Transaction — the Transaction is the actual record of money moving; the Recurring Expense is the template/schedule.

**Savings Fund**
A named savings goal (e.g. "Emergency Fund", "Wedding"). Has a target amount, a current amount, optionally a start/end date and a monthly savings target. Distinct from a Category — funds are about accumulating toward a goal, categories are about monthly spending.

**Savings Movement**
A single deposit or withdrawal into/out of a Savings Fund. Same relationship to Fund as Transaction has to Category: the fund is the running total, the movement is the individual event that changed it.

**Income Source**
A recurring or expected source of income for a given month (e.g. salary, freelance extra), tracked as expected vs. actual amount per month.

## Fields and enums

**Money values** (`amountCents`, `monthlyBudgetCents`, `targetAmountCents`, etc.)
Always an integer number of cents, never a float. The `Cents` suffix on every money field name is deliberate and mandatory — a field just called `amount` on a new type would be a naming mistake. The ×100 / ÷100 conversion for display and input happens only in the frontend, at the UI edge — never in the API or DB layer.

**budgetType** (DB: `preciso` | `quero` | `poupanca`)
The 50/30/20 classification (Need / Want / Savings) from the original Excel tracker. Applies to Categories and Recurring Expenses, not to individual Transactions (a transaction inherits its category's budgetType). The lowercase values here are the DB representation; the GraphQL schema exposes them UPPER_CASE (`PRECISO` etc.) per GraphQL convention — the resolver/service layer maps between the two.

**direction** (DB: `expense` | `income`)
Whether money is leaving or entering. Applies to Categories and Transactions. Same DB-lowercase / GraphQL-UPPER_CASE mapping as `budgetType`.

**achieved** (boolean, on Savings Fund)
True once `currentAmountCents` has reached `targetAmountCents`. Distinct from "fully funded on schedule" — it's just a threshold flag, not a projection.

**paidThisMonth** (boolean, on Recurring Expense — computed, not stored)
Whether a Transaction linked to this Recurring Expense exists for the current month. Not a raw DB column — see "Notes for Claude Code" in the project plan for why (avoids a scheduled monthly reset job).

## Auth terms

**OTP (One-Time Code)**
The 6-character code emailed to the user for passwordless login. Alphanumeric (uppercase A-Z + digits 2-9, excluding ambiguous characters 0/O/1/I/L), verified case-insensitively. Short-lived, single-use, stored only as a hash.

**Access Token**
Short-lived JWT (5-15 min) proving the user is authenticated for the current request. Not persisted server-side — stateless, decoded per-request.

**Refresh Token**
Longer-lived token, persisted in the DB per device/session, used to obtain new Access Tokens without re-doing OTP login. Revocable independently per device (single-device logout) or all at once for a user ("sign out everywhere") — both distinct from revoking the user's account.

## Explicitly NOT the same thing

- **Transaction vs. Recurring Expense**: a Transaction is one real event; a Recurring Expense is a recurring schedule/template. Marking a Recurring Expense "paid" creates a Transaction, it isn't one itself.
- **Category vs. Savings Fund**: Categories are monthly spending buckets that reset each month. Savings Funds are long-running balances that accumulate over time, unrelated to any single month.
- **Access Token vs. Refresh Token**: Access = short-lived, stateless, used on every request. Refresh = long-lived, stored server-side, used only to mint new Access Tokens.
