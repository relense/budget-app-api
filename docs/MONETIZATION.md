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

## Idea: local-first storage for the free tier, server storage only for paid
Raised as a cost question: since a free user's data is hosted at your (the operator's) expense, should free-tier data live only on-device, with server-side storage/sync itself being what's paid for? **Assessment as of this discussion: probably will happen eventually — big, but not enormous, and smaller in scope than shared accounts below.** Recording scope for later, not designing it now.

- **The real driver is request/compute volume, not storage dollars.** A budget ledger is small (a few MB per user even over a decade), so raw Postgres storage cost is negligible. The actual risk at real growth is thousands of users each generating frequent reads/writes against your API/DB continuously — that's a compute and request-volume cost, and it scales with total free signups, not just paying ones. Local-first free tier removes that scaling risk entirely by design: free users never hit your server at all.
- **What it's also good for beyond cost:** it makes hosting cost scale with paying customers only (predictability, not just magnitude), and it's thematically consistent with the "genuine data ownership" stance that's already part of why this app exists.
- **Rough scope, two real implementation paths:**
  1. *Duplicate the domain logic client-side* — a local SQLite (mobile) / IndexedDB (web) store plus a reimplementation of the invariants that currently live in the server's service layer (month locking, recurring carry-forward, savings overdraft checks, etc.). Simpler to build per-platform, but two independent implementations of the same rules will drift apart over time unless deliberately kept in sync.
  2. *Share the logic* — run the existing service-layer rules against a local SQLite database instead of Postgres, so free and paid users hit the same validated logic either locally or remotely. Avoids drift, but is a much harder engineering problem (the current service layer assumes a live Postgres/Prisma connection, not an embedded on-device runtime).
- **A migration path is required, not optional**: when a free user upgrades, their local data has to be imported into the server's Postgres under their account — a one-time bulk import (not continuous sync, so none of the earlier-rejected merge-conflict problem), but still real work: validating that locally-created data doesn't violate a server-side invariant the free client never had to enforce.
- **Backup/data-loss risk can be softened without breaking the "free costs $0 to host" property**: e.g. an optional local encrypted export file the user manages themselves. Still needs deciding.
- **This would likely replace, not sit alongside, the multi-device hard-block design recorded at the top of this doc.** If free-tier data never reaches the server, there's no server session to cap in the first place — a free user is inherently single-device because each device's local store is independent of every other. Worth remembering so the device-cap auth work (plan field, `device_limit_reached`, etc.) isn't built first only to become moot once this lands.

## Idea: reminder notifications (paid)
Liked. A user-configured list of reminders (e.g. "pay rent," bill due dates) — the paid part being the notification delivery itself, not just the reminder data existing. Not designed — would need push infra (mobile) and/or email, plus deciding what's actually free vs. gated (e.g. is *creating* reminders free and only *receiving* the notification paid, or is the whole feature paid).

## Idea: reports, net worth trends, forecasting, tax calculator
Liked, grouped together as one "power user" cluster — export (CSV/PDF), net worth over time, spending forecasts, a tax calculator. All genuine add-ons on top of a fully usable free core, consistent with the "monetize more, not less friction" principle from the discussion above. Not designed or scoped individually yet.

## Idea: lifetime purchase — pricing needs a real cost model first
Liked as a concept, but flagged as harder to price than it looks: unlike a fixed-content app (e.g. WaniKani, where the content is the same size regardless of how long someone subscribes), this app's per-user data grows for as long as the user is active — a one-time payment has to cover a cost that keeps growing indefinitely after the payment stops. Needs an actual model (expected data growth per active year × years of expected usage × infra cost, with margin) before a number gets attached — not just a gut-feel price. Not decided.

## Considered and leaning against: bank connection (Plaid/SimpleFin/Teller/etc.)
Real convenience value (no manual entry) acknowledged, but leaning against — the cost isn't the integration itself, it's the ongoing security/compliance burden of holding bank-linked credentials/data, which is a materially different risk posture than the app carries today. Not ruled out permanently, just not something currently wanted. No further scoping done.

## Considered and reframed: no ads, no data-selling
Not a paid-tier feature — a blanket product policy across every tier, free included. Doesn't function as something to "unlock" by paying (unlike a freemium app that shows ads to free users and removes them for paid); it's closer to a marketing/trust statement than a monetization lever. Ads specifically are a hard no regardless of tier.

## Revisit trigger
Come back to this once the UI implementation is finished. Until then, the API is feature-frozen — the only API changes in scope are bug fixes found while actually using the UI, not new features. Confirmed: shared/household accounts is the next big task once that's done, ahead of the other ideas above.
