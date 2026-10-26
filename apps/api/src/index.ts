import Stripe from 'stripe';
import { createApp } from './app.js';
import { MockPaymentProvider, StripePaymentProvider } from './payments.js';
import { settleUnsettled } from './ledger.js';
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
store.policy = {
  passThroughProcessingFees: (process.env.PASS_THROUGH_FEES ?? 'true') === 'true',
  platformFeeBps: Number(process.env.PLATFORM_FEE_BPS ?? 0),
};
const app = createApp(store, payments, secret ?? 'dev-only-secret', {
  apiPublicUrl: process.env.API_PUBLIC_URL ?? `http://localhost:${port}`,
  allowedReturnPrefixes: (process.env.APP_RETURN_PREFIXES ?? 'http://localhost:8081,masjiddonation://,exp://').split(','),
  operatorEmails: (process.env.OPERATOR_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
});

const tick = () =>
  processDueRecurring(store, payments)
    .then(() => settleUnsettled(store, payments))
    .catch((e) => console.error('background run failed', e));
setInterval(tick, 60_000);
tick();

app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
