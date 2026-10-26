# Masjid Donation Box

A digital donation box for the mosques you visit. One codebase runs on iPhone, Android and the web.

- **Donors**: favorite mosques, one-tap donations ($1 / $5 / $15 / $25 / custom), optional cause, recurring (weekly/monthly) giving, history.
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
- **Mosques** onboard as Stripe Connect Express accounts (non-profit, US). Each donation is a PaymentIntent with `transfer_data.destination` set to the mosque's account.
- **Bank debits** are asynchronous: the donation shows as "pending" and flips to succeeded/failed when the webhook arrives.

Setup:

1. Stripe Dashboard: enable Connect, and under Settings > Payment methods enable Cards, Apple Pay, Google Pay and ACH Direct Debit.
2. Webhook endpoint `https://<api-host>/webhooks/payments` with events `payment_intent.succeeded`, `payment_intent.payment_failed`, `account.updated` (for local dev: `stripe listen --forward-to localhost:4000/webhooks/payments`).
3. Environment for `apps/api`:

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Enables the Stripe provider (use a test key first) |
| `STRIPE_WEBHOOK_SECRET` | Verifies webhook signatures |
| `API_PUBLIC_URL` | Public base URL of the API (Stripe return links go through it) |
| `APP_RETURN_PREFIXES` | Comma-separated URL prefixes the return page may redirect to (web app origin, `masjiddonation://`) |
| `JWT_SECRET` | Required in production |

Apple Pay appears automatically on Stripe Checkout in Safari / iOS; Google Pay in Chrome / Android. Native in-app sheets (Stripe PaymentSheet) are not used.

## What is NOT production-ready yet

- **The Stripe integration has not been run against Stripe.** It is covered by unit tests with a fake Stripe client (request parameters, error mapping, webhook handling) and the mock provider is exercised end to end, but test it with Stripe test keys before relying on it.
- Off-session charges that need 3-D Secure fail with a message asking the donor to re-add the method.
- Charges are made on the platform account (donors see the platform name on statements); no platform fee is taken. Receipts / tax statements are not generated.
- **Storage** is a JSON file (`apps/api/data/db.json`); move to Postgres or similar.
- Missing: password reset / email verification, mosque verification beyond Stripe's own KYC, inviting additional mosque staff, push notifications, rate limiting.
- Recurring charges run from an in-process timer; use a proper job queue/cron when deployed.
