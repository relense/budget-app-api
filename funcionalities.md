# Functionalities — What The App Can Do Right Now

Plain-language walkthrough of the app from the user's perspective, as built
today. Not a design-rationale doc (see `plan.md` for that) and not the API
reference (see `SERVICES.md` for that) — just "what can I actually do."

## 1. Sign up / log in

- Enter email → get a 6-character code by email → enter code → logged in.
- First time ever: this also creates the account and seeds a default set of
  starter categories for free.
- Returning: same code flow, just logs in.

## 2. Categories

The spending buckets — "Housing", "Shopping", "Health", etc.

- Create a category (name, expense or income, and if expense, need/want/savings).
- Edit or delete a category (delete only works if it's never been used in
  any month).
- Categories sit in a catalog and don't belong to any month by themselves —
  they can sit unused/dormant until activated for a month.

## 3. Months

- No explicit "create a month" action — the app figures out the "current
  month" on its own (earliest one that isn't locked yet, or today's real
  month if brand new).
- "Activate" a category *for* a month by adding it with a budget amount
  (e.g. "Housing: 900€ this month") — manual, per category, per month.
- Locking a month freezes everything in it forever — no more edits, no more
  transactions.
- Can pre-provision the *next* month early (one month ahead, not further).
- A pre-provisioned month with nothing in it yet can be deleted.

## 4. Transactions

Actual spending/income entries.

- Log a transaction against an active category-for-a-month: amount, date,
  optional merchant/note.
- Edit or delete it (only if that month isn't locked).

## 5. Recurring expenses ("Contas" — Rent, Netflix, etc.)

*Currently the most layered part of the app — under active discussion for
simplification.*

- Step A: create the **template** — the reusable definition ("Rent, 800€,
  category: Housing, due day 1"). Also auto-activates Housing for the month
  if needed, and creates the first month's **instance**.
- Step B, every following month: "add this recurring expense to the month"
  — creates a new **instance** for that month, copying the template's
  current amount (unless overridden).
- Mark an instance paid → creates a transaction linked to it. Callable more
  than once per instance for split payments (e.g. rent paid in two chunks);
  tracks whether the total paid covers the full amount.
- Edit the template (changes the default for *future new* instances only)
  or edit one instance directly (just that month's amount).
- Delete a template or remove an instance from a month (blocked if a
  transaction already points at it).

## 6. Savings funds

Not built yet — backlog item.

## 7. Income sources

Expected vs. actual salary/income per month. Not built yet — backlog item.

---

## Recurring expenses: redesign decided, not yet built

Everything else in the app (categories, months, transactions) is a single
flat thing you create/edit directly. Recurring expenses were the one place
with two layers — a transversal "template" plus a per-month "instance" —
mirroring the Category/CategoryMonth split. That split has been dropped:

- A recurring expense is now one flat row that lives *in* a month — name,
  category, budget amount, due day, and paid-or-not (via a linked
  transaction), same as before.
- Moving to a new month **automatically** copies last month's list forward
  (fresh, unpaid) — no per-item opt-in, and no link between one month's row
  and the next month's copy (each is fully independent).
- Editing a row only ever changes that one month — there's no more "apply
  this to future months too?" question, since there's no template default
  to reconcile against.

See `plan.md`'s Data Model section and `GLOSSARY.md`'s Recurring Expense
entry for the full shape, and `PROGRESS.md` for build status — this is
decided but not implemented yet; the code currently in `develop` (and
`SERVICES.md`) still reflects the old template/instance design.
