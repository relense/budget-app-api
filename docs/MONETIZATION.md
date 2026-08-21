# Monetization — Future Reference

Not for now. This is a decision record for a paid-sync feature discussed before it's in scope — not a to-do list. Nothing here should influence how the app is built today. Revisit once the current (non-monetization) scope is done.

## The idea
Mobile and web are both clients of the same API/database (`docs/PLAN.md`) — that's by design, not something to change. The question raised: could multi-device access be a paid feature?

## Key reframe (why this isn't a "sync" feature)
Initial framing compared this to Bear (notes app): pay to sync data across devices. That doesn't map onto this app:

- Bear's devices each hold an independent local copy of the data; paying for sync buys the mechanism that reconciles those copies. Conflicts there are low-stakes — "keep both" is a fine fallback for a note.
- This app has no local copies. Every client (mobile, web) reads/writes the same Postgres database live over the API. There is nothing to sync — it already happens, for free, as a consequence of the architecture.
- Building a Bear-style offline-first mode (local storage per device, merge on reconnect) to make "sync" a gate-able feature would be **new, risky complexity**, not a reuse of anything that exists — and specifically dangerous for financial data: `BudgetMonth.locked` rows are immutable once locked, and there's no defined behavior for "device A edited this month offline before device B locked it server-side." Explicitly rejected — do not build offline-first storage to support this feature.

## What's actually paid: concurrent device count, not sync
Reframed as: free tier = 1 active device session at a time; paid = more than 1. This piggybacks on infrastructure that already exists — `refresh_tokens` are already issued per-device, and `POST /auth/logout-all` already revokes "every refresh token for the authenticated user (all devices)" (`docs/PLAN.md`).

## Decided behavior (design-only, not built)
- **Hard block, not silent kick, not read-only degrade.** A free-tier login on a second device is rejected outright rather than silently signing out the first device or letting the second device in read-only.
- **Recovery must not lock the user out.** Since the free-tier cap is exactly 1 device, there's no ambiguity about which session would need to go — no device picker or "manage sessions" screen is needed for v1. The blocked-login response should be actionable: an explicit "sign out that device and continue here" action the user can take from the *new* device, not a dead end requiring access to the old one.
- **Enforcement lives entirely in the auth layer.** No GraphQL resolver changes — a valid session already implies entitlement, so gating happens at session issuance, not at data access.

## Interface changes this would imply (flag before building, per `CLAUDE.md`)
- A plan/entitlement field on `User`.
- `POST /auth/verify-otp` and `POST /auth/refresh`: on a free-plan user with an existing non-revoked `refresh_token`, don't issue a new one — return a distinguishable error (e.g. `device_limit_reached`) instead of `{ accessToken, refreshToken }`.
- A new action to fulfill "sign out that device and continue" — revoke the existing session and issue a fresh one in one step. Route shape (new endpoint vs. a flag on an existing one) not decided.

## Open / not decided
- Billing provider and integration are undecided. Flagged for later, not now: `docs/PLAN.md` has mobile as React Native — if entitlement is ever purchased from inside the iOS/Android app, Apple/Google generally require their own in-app-purchase billing for unlocking app functionality; plain Stripe checkout alone wouldn't satisfy that on-platform. Doesn't affect the auth design above (entitlement is just a flag on `User`, settable by whatever billing path), but affects how billing itself gets built.
- Pricing, trial period, and what a paid plan grants beyond device count — not discussed.

---

## Idea: plan further ahead than just the next month
Raised alongside multi-device access as another possible paid feature. Not designed — recording the idea and what it would touch.

- Today, a month only exists as a `BudgetMonth` row once something creates it (lazily upserted the first time it's referenced — `docs/PLAN.md`'s Data Model section). Whether the API already lets a user provision an arbitrary number of months ahead (not just the one immediately after the current unlocked month) or whether that's implicitly/explicitly limited hasn't been checked against the current code — confirm the actual current behavior before designing a gate around it, rather than assuming a limit exists.
- If a limit needs to be added (free = current + 1 provisioned ahead, paid = further), the natural enforcement point is wherever a `BudgetMonth` gets lazily created (`addCategoryToMonth`, `createRecurringExpense`'s carry-forward) — reject/gate creation of a month beyond the free-tier horizon rather than gating reads.
- Open: how far ahead should paid unlock (a fixed N months, or unlimited)? Does pre-provisioning many months ahead interact with the automatic recurring-expense carry-forward (`docs/PLAN.md`'s Month Lifecycle section), which currently assumes carry-forward happens from "the calendar-previous month" — carrying forward across a gap of several unprovisioned months isn't a case that's been designed?

## Idea: shared/household accounts (multiple users, one budget)
Flagged by you as the big one. Recording scope and why it's a different order of change than the two ideas above — this is not a small add-on.

- **The whole app is single-owner today, structurally.** Every domain table (`Category`, `CategoryMonth`, `BudgetMonth`, `Transaction`, `RecurringExpense`, `SavingsFund`, `SavingsMovement`) has a direct `user_id` FK, and `CLAUDE.md`'s own standing rule is "every resolver reads `userId` from the authenticated context and scopes its query by it — no exceptions." A husband and wife both seeing and editing *the same* budget means the scoping key can no longer be "the authenticated user's own id" — it has to become some shared entity (e.g. a household/budget id) that multiple `User` rows can resolve to. That's a change to the core multi-tenancy rule itself, not a feature bolted on top of it.
- That implies, at minimum: a new shared-ownership entity sitting between `User` and every domain table; a membership model (who belongs to a household, how someone is invited/added, how someone is removed, whether there's a role distinction or everyone has fully symmetric access as you described); and a decision on attribution (does the app still track *which* member added a given transaction/category, even though both can see and edit everything, or is that not tracked at all).
- **Interacts with the multi-device idea above** — worth resolving deliberately, not by accident: if two household members are each on their own device, is that "2 devices" against the free-tier device cap, or does household sharing operate on a completely separate axis from per-user device limits? Not decided.
- Likely the natural billing unit for this feature is the household/shared-budget itself (one subscription covers every member), rather than gating it per individual `User` the way device count is — but that's a guess to validate later, not a decision.
- None of this is scoped further than what's written here — no schema, no migration plan, no invite flow. Treat this as "we know this is a big structural change and roughly why," not a design.

## Revisit trigger
Come back to this once the UI implementation is finished. Until then, the API is feature-frozen — the only API changes in scope are bug fixes found while actually using the UI, not new features. Confirmed: shared/household accounts is the next big task once that's done, ahead of the other two ideas above.
