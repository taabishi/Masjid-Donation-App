# Deploying a demo you can open from anywhere (all on Vercel)

Three pieces, set up in this order:

| Piece | Host | What it does |
|---|---|---|
| Database | Supabase | Stores everything |
| API (`apps/api`) | Vercel project #1 | Runs as Vercel functions |
| Web app (`apps/app`) | Vercel project #2 | The site people open |

Both Vercel projects come from this same GitHub repo, with different **Root Directory** settings.

This guide deploys the **demo**: fake payments, nothing real moves, demo mosques included. For real money, finish the Stripe setup in the README first. Don't share a demo link publicly: anyone who has it can create accounts.

## 1. Supabase (database)

1. Create a project at supabase.com. Save the database password.
2. Click **Connect** at the top of the project and copy the **Transaction pooler** connection string (port 6543). Vercel runs many short-lived function instances, and the transaction pooler is made for that. Replace `[YOUR-PASSWORD]` with your password (URL-encode special characters).
3. **Project Settings > Database > SSL Configuration**: download the CA certificate and open it in a text editor. You'll paste the whole text, including the BEGIN/END lines.

## 2. Vercel project #1: the API

1. **Add New > Project**, import this repository.
2. Set **Root Directory** to `apps/api`. Leave the framework as "Other". `apps/api/vercel.json` sets the build, the function, and a daily scheduled job.
3. Add **Environment Variables** (all environments):

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the transaction pooler string from step 1 |
| `DATABASE_CA_CERT` | the certificate text |
| `JWT_SECRET` | a long random string (32+ characters). Make one with `openssl rand -base64 48` |
| `CRON_SECRET` | another long random string. Vercel sends it to the scheduled job automatically |
| `ALLOW_MOCK_PAYMENTS` | `true` (demo: fake payments) |
| `OPERATOR_EMAILS` | your email, e.g. `you@example.com` |
| `CORS_ORIGINS`, `API_PUBLIC_URL`, `APP_RETURN_PREFIXES` | `https://placeholder.example` for now; you'll fix these in step 4 |

4. **Deploy.** The build compiles the API, creates the database tables, and adds the demo mosques. When it finishes, note the address, e.g. `https://masjid-api.vercel.app`. Opening `<address>/health` should show `{"ok":true}`. If the build fails at the migration step, the database address or certificate is wrong; the build log says which.

## 3. Vercel project #2: the web app

1. **Add New > Project**, import the same repository again.
2. Set **Root Directory** to `apps/app`. Leave the framework as "Other". `apps/app/vercel.json` sets the build and makes deep links work on refresh.
3. Add `EXPO_PUBLIC_API_URL` = the API address from step 2 (no trailing slash). It's baked in at build time, so changing it later means redeploying.
4. Deploy. Note the address, e.g. `https://masjid-donation.vercel.app`.

## 4. Point the API at the web app

In the **API** project's environment variables set:

- `CORS_ORIGINS` = the web app address, e.g. `https://masjid-donation.vercel.app`
- `API_PUBLIC_URL` = the API address
- `APP_RETURN_PREFIXES` = `https://masjid-donation.vercel.app,masjiddonation://`

Then **Redeploy** the API project (env var changes apply to new deployments). If you add a custom domain later, add it to `CORS_ORIGINS` too (comma-separated).

## 5. Try it

Open the web app address. Sign up as a donor and browse the demo mosques. Sign up with your `OPERATOR_EMAILS` address to get the Operator console (History tab) for approving organizations.

## Things to know

- **Scheduled jobs.** Vercel functions can't run a background timer, so `apps/api/vercel.json` schedules `GET /jobs/run` once a day. It charges due recurring donations (they're weekly or monthly, so daily is enough) and finishes settling bank payments. Vercel's free Hobby plan allows cron only once per day; on Pro you can change the schedule in `vercel.json` to hourly (`0 * * * *`). Stripe's webhook handles most payment updates in real time regardless.
- **Cold starts.** The first request after a quiet period is a bit slower.
- **Upload size.** Vercel functions accept request bodies up to about 4.5 MB, while the API's limit is 5 MB. A document between those sizes will be rejected by Vercel, so ask organizations to keep letters under 4 MB.
- **Stripe webhooks on Vercel are untested.** Stripe signs the raw request body, and I couldn't confirm that Vercel's runtime delivers it unmodified. Before going live, send a test event from the Stripe dashboard and check it succeeds. If signature checks fail, run the API on a server host instead (`render.yaml` in this repo does that).
- **Changing `JWT_SECRET`** signs everyone out.
- The API refuses to start in production unless the required settings are present, and refuses fake payments unless `ALLOW_MOCK_PAYMENTS=true`.
- Going live with real payments: remove `ALLOW_MOCK_PAYMENTS`, set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, add the webhook endpoint `<api address>/webhooks/payments` in Stripe, and delete the demo mosques from the database (they exist only because the demo has no Stripe key).

## Alternative: API on Render

If you'd rather run the API as an always-on server (background timer every minute, no cold starts, no webhook uncertainty), `render.yaml` is a ready-made blueprint. Use the Supabase **Session pooler** string (not the transaction pooler) there, and skip `CRON_SECRET`.
