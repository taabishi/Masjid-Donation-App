# Deploying a demo you can open from anywhere

Three pieces, set up in this order:

| Piece | Host | What it does |
|---|---|---|
| Database | Supabase | Stores everything |
| API (`apps/api`) | Render | Needs a server that stays running (background jobs) |
| Web app (`apps/app`) | Vercel | The site people open |

This guide deploys the **demo**: fake payments, nothing real moves, demo mosques included. For real money, finish the Stripe setup in the README first. Don't share a demo link publicly: anyone who has it can create accounts.

## 1. Supabase (database)

1. Create a project at supabase.com. Save the database password.
2. Click **Connect** at the top of the project. Choose the **Session pooler** connection string (it works over IPv4, which Render needs; the "direct connection" is IPv6-only on the free plan). It looks like `postgres://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres`. Put your real password in; if it has special characters, URL-encode them.
3. **Project Settings > Database > SSL Configuration**: download the CA certificate. Open it in a text editor; you'll paste the whole text (including the BEGIN/END lines) into Render.

## 2. Render (API)

1. Push this repo to GitHub (already done) and sign up at render.com with GitHub.
2. **New > Blueprint**, pick this repository. Render reads `render.yaml`.
3. Fill in the values it asks for:
   - `DATABASE_URL`: the session pooler string from step 1.
   - `DATABASE_CA_CERT`: the certificate text.
   - `OPERATOR_EMAILS`: your email, e.g. `you@example.com`.
   - `API_PUBLIC_URL`, `CORS_ORIGINS`, `APP_RETURN_PREFIXES`: type `https://placeholder.example` for now. You'll fix them in step 4. (The API will start but the web app can't call it until you do.)
4. Deploy. When it's live, note its address, e.g. `https://masjid-donation-api.onrender.com`. Opening `<address>/health` should show `{"ok":true}`. The first start creates the database tables automatically.

## 3. Vercel (web app)

1. **Add New > Project**, import this repository.
2. Set **Root Directory** to `apps/app`. Leave the framework as "Other"; `apps/app/vercel.json` sets the build command and output folder.
3. Under **Environment Variables** add `EXPO_PUBLIC_API_URL` = your Render address (no trailing slash). This is baked in at build time, so changing it later means redeploying.
4. Deploy. Note the address, e.g. `https://masjid-donation.vercel.app`.

## 4. Point the API at the web app

In Render, edit the environment variables and save (it redeploys):

- `CORS_ORIGINS` = your Vercel address, e.g. `https://masjid-donation.vercel.app`
- `API_PUBLIC_URL` = your Render address
- `APP_RETURN_PREFIXES` = `https://masjid-donation.vercel.app,masjiddonation://`

If you later add a custom domain, add it to `CORS_ORIGINS` too (comma-separated).

## 5. Try it

Open your Vercel address. Sign up as a donor and look at the demo mosques. Sign up with your `OPERATOR_EMAILS` address to get the Operator console (History tab) for approving organizations.

## Things to know

- **Render's free plan sleeps** after ~15 minutes idle and takes about a minute to wake, and recurring-donation processing doesn't run while it sleeps. Fine for a demo; use a paid instance for real use.
- **Refreshing deep links works** on Vercel because `vercel.json` sends every path to the app.
- **Changing `JWT_SECRET`** signs everyone out.
- The API refuses to start in production unless the settings above are present, and refuses to run fake payments unless `ALLOW_MOCK_PAYMENTS=true`. That flag is there so a forgotten Stripe key can never silently take "payments" that don't exist.
- Going live with real payments: remove `ALLOW_MOCK_PAYMENTS`, set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, add the webhook endpoint `<api address>/webhooks/payments` in Stripe, and clear the demo mosques from the database (they exist only because the demo has no Stripe key).
