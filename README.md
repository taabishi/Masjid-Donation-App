# Masjid Donation Box

A digital donation box for the mosques you visit. One codebase runs on iPhone, Android and the web.

- **Donors**: favorite mosques, one-tap donations ($5 / $10 / $15 / $25 / custom, $5 minimum), optional cause, recurring (weekly/monthly) giving, history.
- **Mosque admins**: public profile, causes being collected for, payout setup, dashboard of incoming donations.

## Layout

| Path | What |
|---|---|
| `apps/app` | Expo (React Native + web) app using expo-router. Donor area `app/(donor)`, admin area `app/(admin)`. |
| `apps/api` | TypeScript/Express API. JSON-file store, JWT auth, recurring-charge scheduler. |

## Run it

```bash
# API (http://localhost:4000, seeded with 3 demo mosques)
cd apps/api && npm install && npm start

# App
cd apps/app && npm install && npm run web      # or: npm run ios / npm run android
```

On a physical phone or Android emulator, point the app at your machine: `EXPO_PUBLIC_API_URL=http://<LAN-IP>:4000 npm start`.

Tests: `cd apps/api && npm test`. Typecheck: `npm run typecheck` in either app.

Sign up as "I run a mosque" for the admin panel, or as a donor to give.

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
| `POST /ops/payouts` `{mosqueId, amountCents, method, reference?}` | `stripe_transfer` (mosque must be onboarded) or `ach_manual` (you sent the ACH from your bank; record the trace number). Money is reserved in the ledger first, so it can't be paid twice, and restored if a transfer fails |
| `GET /ops/reconcile?bankCents=` | Compares the ledger with Stripe's balance (+ any donation money you hold in your bank). Should be ~0 |

## Before real money

- **Get legal advice first.** Holding donations for organizations that haven't onboarded can involve money-transmitter rules, state charitable-solicitation registration, and tax-receipt questions (a gift to the platform is not automatically deductible). Tell Stripe your exact model when applying.
- Self-registered mosques are not verified yet: payouts are operator-gated, but EIN / 501(c)(3) verification (IRS data, ProPublica API, determination-letter upload, review queue) is still to build.

## What is NOT production-ready yet

- **The Stripe integration has not been run against Stripe.** It is covered by unit tests with a fake Stripe client (request parameters, fee extraction, transfers, error mapping, webhooks) and the mock provider is exercised end to end, but test it with Stripe test keys before relying on it.
- Reconciliation can show a small persistent difference: Stripe dispute fees and refund fees are not ledgered yet. Disputes and refunds reduce the mosque's balance by the gross amount only.
- Off-session charges that need 3-D Secure fail with a message asking the donor to re-add the method.
- Receipts / tax statements are not generated. Donors see the platform's name on statements.
- **Storage** is a JSON file (`apps/api/data/db.json`); a financial ledger belongs in a transactional database (e.g. Postgres) with the ledger insert in the same transaction as the donation update.
- Missing: password reset / email verification, inviting additional mosque staff, push notifications, rate limiting, an operator UI (endpoints only).
- Recurring charges and settlement sweeps run from an in-process timer; use a proper job queue/cron when deployed.
