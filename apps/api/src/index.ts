import Stripe from 'stripe';
import { createApp } from './app.js';
import { createPgDb, createPgliteDb, migrate } from './db.js';
import { settleUnsettled } from './ledger.js';
import { MockPaymentProvider, StripePaymentProvider } from './payments.js';
import { processDueRecurring } from './recurring.js';
import { Repo } from './repo.js';
import { seedDemoMosques } from './seed.js';

const production = process.env.NODE_ENV === 'production';
const secret = process.env.JWT_SECRET;
if (!secret && production) throw new Error('JWT_SECRET is required in production');

const port = Number(process.env.PORT ?? 4000);
const stripeKey = process.env.STRIPE_SECRET_KEY;
const payments = stripeKey
  ? new StripePaymentProvider(new Stripe(stripeKey), process.env.STRIPE_WEBHOOK_SECRET)
  : new MockPaymentProvider();
console.log(`Payments: ${payments.name}${stripeKey ? '' : ' (set STRIPE_SECRET_KEY for real payments)'}`);
if (stripeKey && !process.env.STRIPE_WEBHOOK_SECRET) console.warn('STRIPE_WEBHOOK_SECRET not set: bank-debit settlement and account updates will not be received');

// Postgres (e.g. Supabase) when DATABASE_URL is set; otherwise an embedded local Postgres for development.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl && production) throw new Error('DATABASE_URL is required in production');
const db = databaseUrl
  ? await createPgDb(databaseUrl, { caCert: process.env.DATABASE_CA_CERT, insecureSsl: process.env.DATABASE_SSL_INSECURE === 'true' })
  : await createPgliteDb(process.env.DATA_DIR ?? 'data/pglite');
console.log(`Database: ${databaseUrl ? 'Postgres' : 'embedded local Postgres (development only)'}`);
await migrate(db);

const repo = new Repo(db, db, {
  passThroughProcessingFees: (process.env.PASS_THROUGH_FEES ?? 'true') === 'true',
  platformFeeBps: Number(process.env.PLATFORM_FEE_BPS ?? 0),
});
// demo mosques only make sense with the mock provider; real mode starts empty
if (!stripeKey) await seedDemoMosques(repo);

const app = createApp(repo, payments, secret ?? 'dev-only-secret', {
  apiPublicUrl: process.env.API_PUBLIC_URL ?? `http://localhost:${port}`,
  allowedReturnPrefixes: (process.env.APP_RETURN_PREFIXES ?? 'http://localhost:8081,masjiddonation://,exp://').split(','),
  operatorEmails: (process.env.OPERATOR_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
});

const tick = () =>
  processDueRecurring(repo, payments)
    .then(() => settleUnsettled(repo, payments))
    .catch((e) => console.error('background run failed', e));
setInterval(tick, 60_000);
void tick();

app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
