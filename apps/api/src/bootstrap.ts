import Stripe from 'stripe';
import { createApp } from './app.js';
import { productionConfigProblems } from './config.js';
import { createPgDb, createPgliteDb, migrate } from './db.js';
import { runBackgroundJobs } from './jobs.js';
import { MockPaymentProvider, StripePaymentProvider } from './payments.js';
import { Repo } from './repo.js';
import { seedDemoMosques } from './seed.js';

/**
 * Wire everything up from environment variables. Shared by the long-running server (index.ts)
 * and the Vercel serverless entry (serverless.ts).
 */
export async function buildServices(env: NodeJS.ProcessEnv, opts: { maxConnections?: number; runMigrations: boolean; seedDemoData: boolean }) {
  // Vercel sets VERCEL for every deployment (including previews): treat all of them as production
  const production = env.NODE_ENV === 'production' || !!env.VERCEL;
  if (production) {
    const problems = productionConfigProblems(env);
    if (problems.length) throw new Error('Refusing to start in production:\n - ' + problems.join('\n - '));
  }

  const stripeKey = env.STRIPE_SECRET_KEY;
  const payments = stripeKey ? new StripePaymentProvider(new Stripe(stripeKey), env.STRIPE_WEBHOOK_SECRET) : new MockPaymentProvider();
  console.log(`Payments: ${payments.name}${stripeKey ? '' : ' (set STRIPE_SECRET_KEY for real payments)'}`);
  if (stripeKey && !env.STRIPE_WEBHOOK_SECRET) console.warn('STRIPE_WEBHOOK_SECRET not set: bank-debit settlement and account updates will not be received');

  // Postgres (e.g. Supabase) when DATABASE_URL is set; otherwise an embedded local Postgres for development.
  const databaseUrl = env.DATABASE_URL;
  const db = databaseUrl
    ? await createPgDb(databaseUrl, { caCert: env.DATABASE_CA_CERT, insecureSsl: env.DATABASE_SSL_INSECURE === 'true', maxConnections: opts.maxConnections })
    : await createPgliteDb(env.DATA_DIR ?? 'data/pglite');
  console.log(`Database: ${databaseUrl ? 'Postgres' : 'embedded local Postgres (development only)'}`);
  if (opts.runMigrations) await migrate(db);

  const repo = new Repo(db, db, {
    passThroughProcessingFees: (env.PASS_THROUGH_FEES ?? 'true') === 'true',
    platformFeeBps: Number(env.PLATFORM_FEE_BPS ?? 0),
  });
  // demo mosques only make sense with the mock provider; real mode starts empty
  if (opts.seedDemoData && !stripeKey) await seedDemoMosques(repo);

  const port = Number(env.PORT ?? 4000);
  const app = createApp(repo, payments, env.JWT_SECRET ?? 'dev-only-secret', {
    apiPublicUrl: env.API_PUBLIC_URL ?? `http://localhost:${port}`,
    allowedReturnPrefixes: (env.APP_RETURN_PREFIXES ?? 'http://localhost:8081,masjiddonation://,exp://').split(','),
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
    operatorEmails: (env.OPERATOR_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    cronSecret: env.CRON_SECRET,
    runJobs: () => runBackgroundJobs(repo, payments),
  });

  return { app, repo, payments, port };
}
