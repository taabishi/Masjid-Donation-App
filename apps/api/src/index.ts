import Stripe from 'stripe';
import { createApp } from './app.js';
import { MockPaymentProvider, StripePaymentProvider } from './payments.js';
import { processDueRecurring } from './recurring.js';
import { Store } from './store.js';

const secret = process.env.JWT_SECRET;
if (!secret && process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET is required in production');

const port = Number(process.env.PORT ?? 4000);
const stripeKey = process.env.STRIPE_SECRET_KEY;
const payments = stripeKey
  ? new StripePaymentProvider(new Stripe(stripeKey), process.env.STRIPE_WEBHOOK_SECRET)
  : new MockPaymentProvider();
console.log(`Payments: ${payments.name}${stripeKey ? '' : ' (set STRIPE_SECRET_KEY for real payments)'}`);
if (stripeKey && !process.env.STRIPE_WEBHOOK_SECRET) console.warn('STRIPE_WEBHOOK_SECRET not set: bank-debit settlement and account updates will not be received');

// demo mosques only make sense with the mock provider; real mode starts empty
const store = new Store(process.env.DATA_FILE ?? 'data/db.json', !stripeKey);
const app = createApp(store, payments, secret ?? 'dev-only-secret', {
  apiPublicUrl: process.env.API_PUBLIC_URL ?? `http://localhost:${port}`,
  allowedReturnPrefixes: (process.env.APP_RETURN_PREFIXES ?? 'http://localhost:8081,masjiddonation://,exp://').split(','),
});

setInterval(() => processDueRecurring(store, payments).catch((e) => console.error('recurring run failed', e)), 60_000);

app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
