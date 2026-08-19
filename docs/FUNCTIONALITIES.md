# Functionalities — What The App Can Do Right Now

Plain-language walkthrough of the app from the user's perspective, as built
today. Not a design-rationale doc (see `PLAN.md` for that) and not the API
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

One flat row per recurring expense per month it exists in — name, category,
amount, due day, and paid-or-not (via a linked transaction). No separate
"template" — that split was tried, then dropped (see `PLAN.md`'s Data Model
section for the reasoning).

- Create one directly, for a given month: also auto-activates its category
  for that month if needed, same "no dormant state" rule categories don't
  get.
- Moving to a new month **automatically** copies the previous month's list
  forward (fresh, unpaid) — no per-item opt-in, and no link between one
  month's row and the next month's copy (each is fully independent).
  Whichever action first touches a brand-new month — adding a category or
  creating a new recurring expense — triggers this, not just locking.
- Mark one paid → creates a transaction linked to it. Callable more than
  once for split payments (e.g. rent paid in two chunks); tracks whether
  the total paid covers the full amount.
- Edit one directly (name/category/budget type/due day/amount, all
  together) — only ever changes that one month's row. No "apply to future
  months too?" question, since there's no template default to reconcile
  against.
- Remove one from a month (blocked if a transaction already points at it).
  The same name can't exist twice in the same month, but can repeat across
  different months (e.g. "Rent" every month).

## 6. Savings funds

Not built yet — backlog item.

## 7. Income sources

Expected vs. actual salary/income per month. Not built yet — backlog item.
