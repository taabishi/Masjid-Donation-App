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

## What is NOT production-ready yet

- **Payments are mocked.** `apps/api/src/payments.ts` defines a `PaymentProvider` interface with a mock implementation that always succeeds. The intended real implementation is Stripe Connect (each mosque onboards as a connected account; donors save a card; donations are PaymentIntents routed to the mosque). Mosque "Connect payout account" currently just flips a flag.
- **Storage** is a JSON file (`apps/api/data/db.json`); move to Postgres or similar.
- Missing: password reset / email verification, receipts and tax-deductible donation statements, platform fees, inviting additional mosque staff, mosque verification/approval (anyone can currently register a mosque), push notifications, rate limiting.
- Recurring charges are processed by an in-process timer; use a proper job queue/cron when deployed.
