import { createApp } from './app.js';
import { MockPaymentProvider } from './payments.js';
import { processDueRecurring } from './recurring.js';
import { Store } from './store.js';

const secret = process.env.JWT_SECRET;
if (!secret && process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET is required in production');

const store = new Store(process.env.DATA_FILE ?? 'data/db.json');
const payments = new MockPaymentProvider();
const app = createApp(store, payments, secret ?? 'dev-only-secret');

setInterval(() => processDueRecurring(store, payments).catch((e) => console.error('recurring run failed', e)), 60_000);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
