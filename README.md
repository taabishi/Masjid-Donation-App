# Masjid Donation Box

A digital donation box for the mosques you visit. One codebase runs on iPhone, Android and the web.

- **Donors**: favorite mosques, one-tap donations ($5 / $10 / $15 / $25 / custom, $5 minimum), optional cause, recurring (weekly/monthly) giving, history.
- **Mosque admins**: verify their organization, public profile, causes being collected for, payout setup, dashboard of incoming donations.
- **Platform operators** (allow-listed emails): review organization verifications, see balances owed, pay mosques out.

## Layout

| Path | What |
|---|---|
| `apps/app` | Expo (React Native + web) app using expo-router. Donor area `app/(donor)`, admin area `app/(admin)`. |
| `apps/api` | TypeScript/Express API on Postgres (Supabase in production). JWT auth, ledger, recurring-charge scheduler. SQL migrations in `apps/api/migrations`. |

## Run it

```bash
# API (http://localhost:4000, seeded with 3 demo mosques).
# With no DATABASE_URL it uses an embedded local Postgres in apps/api/data (development only).
cd apps/api && npm install && npm start

# App
cd apps/app && npm install && npm run web      # or: npm run ios / npm run android
```

On a physical phone or Android emulator, point the app at your machine: `EXPO_PUBLIC_API_URL=http://<LAN-IP>:4000 npm start`.

Tests: `cd apps/api && npm test` (runs on in-memory Postgres). To run the same tests against a real server through the production `pg` driver: `TEST_DATABASE_URL='postgres://user@localhost:5432/postgres?sslmode=disable' npm test` (the user must be allowed to `CREATE DATABASE`). Typecheck: `npm run typecheck` in either app.

Sign up as "I run a mosque" for the admin panel, or as a donor to give.

## Database (Supabase)

The API stores everything in Postgres. In production use a Supabase project:

1. Create a project. Under **Project Settings > Database** copy the **direct connection** string (or the **session pooler** string). Do **not** use the transaction pooler (port 6543): the ledger relies on transactions and row locks.
2. Under **Database > Settings > SSL** download the CA certificate. The API verifies TLS, and Supabase's chain is not in the default trust store, so pass the PEM as `DATABASE_CA_CERT`.
3. Set `DATABASE_URL` (and `DATABASE_CA_CERT`) on the API host. Migrations in `apps/api/migrations` are applied automatically at startup and tracked in `schema_migrations`.
4. In Supabase, turn on automatic backups and point-in-time recovery (paid plans). This database holds money records.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string. Required in production; without it the API uses an embedded dev database |
| `DATABASE_CA_CERT` | PEM of the server's CA, for verified TLS |
| `DATABASE_SSL_INSECURE` | `true` skips certificate verification. Avoid; only if you cannot supply the CA |

**Security model.** Supabase auto-exposes every table in `public` over its REST API with the public `anon` key. The migration enables Row Level Security on every table with no policies, which denies all of that access; only this API (connecting as the table owner) can read or write. Don't add policies or expose the Supabase keys in the app. The app never talks to Supabase directly, only to this API.

**Data guarantees enforced by the database itself:** `ledger_entries` rejects UPDATE, DELETE and TRUNCATE (append-only); money columns must be positive integer cents; `payment_ref` is unique so a retried charge can't create a second donation; settling a donation, refunds and payouts run in transactions with row locks so concurrent requests can't double-spend a mosque's balance.

## Payments (Stripe)

Without `STRIPE_SECRET_KEY` the API uses a **mock** provider (instant fake cards/bank accounts, nothing real moves) and seeds demo mosques. With a key it uses **Stripe**:

- **Donors** add a payment method on a Stripe-hosted Checkout page (setup mode): cards, Apple Pay, Google Pay and US bank accounts (ACH). Details never touch our servers. One-tap and recurring donations then charge the saved method off-session.
- **The platform collects every donation** on its own Stripe account, even for mosques that haven't onboarded. What each mosque is owed is tracked in the ledger (below). Mosques can onboard later as Stripe Connect Express accounts (non-profit, US); after that a balance can be paid to them with a Stripe transfer, or earlier by a manual ACH from your bank.
- **Bank debits** are asynchronous: the donation shows as "pending" and flips to succeeded/failed when the webhook arrives.

Setup:

1. Stripe Dashboard: enable Connect, and under Settings > Payment methods enable Cards, Apple Pay, Google Pay and ACH Direct Debit.
2. Webhook endpoint `https://<api-host>/webhooks/payments` with events `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`, `account.updated` (for local dev: `stripe listen --forward-to localhost:4000/webhooks/payments`).
3. Environment for `apps/api`:

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Enables the Stripe provider (use a test key first) |
| `STRIPE_WEBHOOK_SECRET` | Verifies webhook signatures |
| `OPERATOR_EMAILS` | Comma-separated emails of platform operators allowed to use `/ops/*` (register those accounts normally first) |
| `PASS_THROUGH_FEES` | `true` (default): Stripe's fee is deducted from the mosque's share. `false`: the platform absorbs it |
| `PLATFORM_FEE_BPS` | Platform cut in basis points; default `0` |
| `API_PUBLIC_URL` | Public base URL of the API (Stripe return links go through it) |
| `APP_RETURN_PREFIXES` | Comma-separated URL prefixes the return page may redirect to (web app origin, `masjiddonation://`) |
| `JWT_SECRET` | Required in production |

Apple Pay appears automatically on Stripe Checkout in Safari / iOS; Google Pay in Chrome / Android. Native in-app sheets (Stripe PaymentSheet) are not used.

## Ledger and payouts

Every money event is an append-only, integer-cent entry in `ledger` (see `apps/api/src/ledger.ts`): donation, processing fee, platform fee, refund, dispute (and reversal), payout (and reversal). Entries are keyed so retries and duplicate webhooks can't double-post, and a donation's entries always sum to the cash that actually landed (gross minus Stripe's fee). A mosque's balance is the sum of its entries. Only *succeeded* donations count; bank debits stay "pending" until they settle.

Operator endpoints (bearer token of an `OPERATOR_EMAILS` user):

| Endpoint | Purpose |
|---|---|
| `GET /ops/balances` | Owed per mosque, onboarding status, platform's own balance |
| `GET /ops/ledger?account=` | Latest ledger entries |
| `GET /ops/verifications?status=` and `POST /ops/verifications/:mosqueId` | Review queue (see above) |
| `POST /ops/payouts` `{mosqueId, amountCents, method, reference?}` | `stripe_transfer` (mosque must be onboarded) or `ach_manual` (you sent the ACH from your bank; record the trace number). Money is reserved in the ledger first, so it can't be paid twice, and restored if a transfer fails |
| `GET /ops/reconcile?bankCents=` | Compares the ledger with Stripe's balance (+ any donation money you hold in your bank). Should be ~0 |

## Organization verification

Only verified tax-exempt organizations can appear to donors, receive donations, connect Stripe payouts, or be paid out. (In mock mode the seeded demo mosques are pre-verified.)

1. A mosque admin opens the **Verification** tab, enters the legal name and EIN, and optionally uploads an IRS determination letter (PDF/PNG/JPEG, max 5 MB, up to 5 files; stored in the database, content type checked against the file's bytes).
2. The API looks the EIN up in the tax-exempt directory (ProPublica Nonprofit Explorer, `apps/api/src/directory.ts`) and records what it found: official name, name match, state match, whether the IRS subsection is 501(c)(3). This is only a hint for the reviewer. **Nothing is ever auto-approved**, because anyone can type someone else's EIN. If the directory is down or doesn't know the EIN the application still goes to review.
3. An operator reviews the queue in the app (**History > Operator console**, web recommended so documents can be opened) or via `GET /ops/verifications`, then approves or rejects (`POST /ops/verifications/:mosqueId`; a rejection needs a reason, which is shown to the organization, which can then fix and resubmit). Every submission and decision is recorded in `verification_events`.
4. One EIN can only be claimed by one organization account at a time (pending or approved), enforced by a database index. A verified organization's EIN is locked.

**Houses of worship** are generally treated as tax-exempt without applying to the IRS or filing a Form 990, so many mosques will not appear in IRS data. For those the reviewer relies on documents (an IRS determination or affirmation letter, etc.). Confirm your review policy with your nonprofit lawyer, and consider re-checking organizations periodically (not automated yet).

Operator checklist when approving: the EIN, legal name and city/state belong to the applicant; the person who signed up plausibly represents the organization (email domain, website, phone call); the IRS record, if any, shows 501(c)(3) status and is not revoked.

## Before real money

- **Get legal advice first.** Holding donations for organizations that haven't onboarded can involve money-transmitter rules, state charitable-solicitation registration, and tax-receipt questions (a gift to the platform is not automatically deductible). Tell Stripe your exact model when applying.
- The reviewer decides who is a legitimate organization. Write down your review policy, and make sure at least one person other than the developer is trained to apply it.

## What is NOT production-ready yet

- **The ProPublica lookup has not been run against the live API** (it is unreachable from the development sandbox). Its response parsing follows the documented v2 shape and is unit-tested against that shape; verify it with a real EIN before relying on the hints it gives reviewers.
- **The Stripe integration has not been run against Stripe.** It is covered by unit tests with a fake Stripe client (request parameters, fee extraction, transfers, error mapping, webhooks) and the mock provider is exercised end to end, but test it with Stripe test keys before relying on it.
- Reconciliation can show a small persistent difference: Stripe dispute fees and refund fees are not ledgered yet. Disputes and refunds reduce the mosque's balance by the gross amount only.
- Off-session charges that need 3-D Secure fail with a message asking the donor to re-add the method.
- Receipts / tax statements are not generated. Donors see the platform's name on statements.
- The `pg` path has been verified against a local Postgres 16 server (full test suite + browser run) but not against an actual Supabase project: expect to troubleshoot connection/TLS settings on first connect.
- A donation row is saved after Stripe confirms the charge, in a separate step from the ledger settlement; if the server crashes between them the periodic `settleUnsettled` sweep completes the ledger. If it crashes between the Stripe charge and saving the donation row, retried recurring charges are de-duplicated by Stripe's idempotency key, but a one-time donation could be charged without a row (reconciliation will show the difference).
- Missing: password reset / email verification, inviting additional mosque staff, push notifications, rate limiting, an operator UI (endpoints only).
- Recurring charges and settlement sweeps run from an in-process timer; use a proper job queue/cron when deployed.
