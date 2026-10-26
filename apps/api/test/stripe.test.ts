import test from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';
import { StripePaymentProvider } from '../src/payments.js';
import type { Mosque } from '../src/store.js';

const mosque = { id: 'm1', name: 'Masjid', payoutAccountId: 'acct_1', payoutsConnected: true } as Mosque;

function fake(overrides: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[][]> = {};
  const rec = (name: string, ret: unknown) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return Promise.resolve(typeof ret === 'function' ? (ret as (...a: unknown[]) => unknown)(...args) : ret);
  };
  const stripe = {
    paymentIntents: { create: rec('pi', { id: 'pi_1', status: 'succeeded' }) },
    checkout: { sessions: { create: rec('session', { url: 'https://checkout.stripe.test/s' }) } },
    accounts: {
      create: rec('acctCreate', { id: 'acct_new' }),
      retrieve: rec('acctGet', { charges_enabled: true, details_submitted: true }),
    },
    accountLinks: { create: rec('link', { url: 'https://connect.stripe.test/onboard' }) },
    customers: {
      listPaymentMethods: rec('list', {
        data: [
          { id: 'pm_card', type: 'card', card: { brand: 'visa', last4: '4242' } },
          { id: 'pm_bank', type: 'us_bank_account', us_bank_account: { bank_name: 'Chase', last4: '6789' } },
          { id: 'pm_other', type: 'sepa_debit' },
        ],
      }),
    },
    paymentMethods: { retrieve: rec('pmGet', { customer: 'cus_1' }), detach: rec('detach', {}) },
    ...overrides,
  } as unknown as Stripe;
  return { stripe, calls };
}

test('charge routes funds to the mosque account, off-session, with an idempotency key', async () => {
  const { stripe, calls } = fake();
  const p = new StripePaymentProvider(stripe, 'whsec');
  const r = await p.charge({ amountCents: 500, customerId: 'cus_1', paymentMethodId: 'pm_card', mosque, description: 'd', idempotencyKey: 'k1' });
  assert.deepEqual(r, { status: 'succeeded', reference: 'pi_1' });
  const [params, opts] = calls.pi[0] as [Record<string, unknown>, Record<string, unknown>];
  assert.equal(params.amount, 500);
  assert.equal(params.confirm, true);
  assert.equal(params.off_session, true);
  assert.deepEqual(params.transfer_data, { destination: 'acct_1' });
  assert.equal(opts.idempotencyKey, 'k1');
});

test('bank debits report processing; card declines report failed; outages throw', async () => {
  const req = { amountCents: 500, customerId: 'c', paymentMethodId: 'p', mosque, description: 'd', idempotencyKey: 'k' };
  let p = new StripePaymentProvider(fake({ paymentIntents: { create: async () => ({ id: 'pi_2', status: 'processing' }) } }).stripe, undefined);
  assert.equal((await p.charge(req)).status, 'processing');

  p = new StripePaymentProvider(fake({ paymentIntents: { create: async () => { throw Object.assign(new Error('Card declined'), { type: 'StripeCardError' }); } } }).stripe, undefined);
  assert.deepEqual(await p.charge(req), { status: 'failed', error: 'Card declined' });

  p = new StripePaymentProvider(fake({ paymentIntents: { create: async () => { throw Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }); } } }).stripe, undefined);
  await assert.rejects(p.charge(req));
});

test('lists cards and bank accounts, ignores other types', async () => {
  const p = new StripePaymentProvider(fake().stripe, undefined);
  assert.deepEqual(await p.listMethods('cus_1'), [
    { id: 'pm_card', type: 'card', label: 'Visa •••• 4242' },
    { id: 'pm_bank', type: 'us_bank_account', label: 'Chase •••• 6789' },
  ]);
});

test('add-method uses a hosted setup session; onboarding creates a Connect account once', async () => {
  const { stripe, calls } = fake();
  const p = new StripePaymentProvider(stripe, undefined);
  assert.equal((await p.beginAddPaymentMethod('cus_1', 'https://x/return')).url, 'https://checkout.stripe.test/s');
  assert.equal((calls.session[0][0] as { mode: string }).mode, 'setup');

  const fresh = await p.beginMosqueOnboarding({ ...mosque, payoutAccountId: undefined }, 'https://x/return');
  assert.equal(fresh.accountId, 'acct_new');
  const existing = await p.beginMosqueOnboarding(mosque, 'https://x/return');
  assert.equal(existing.accountId, 'acct_1');
  assert.equal(calls.acctCreate.length, 1);
});

test('cannot detach another customer\'s payment method', async () => {
  const p = new StripePaymentProvider(fake().stripe, undefined);
  await assert.rejects(p.removeMethod('cus_other', 'pm_card'));
});

test('webhook parsing requires a signature and maps events', () => {
  const stripe = fake({
    webhooks: {
      constructEvent: (_b: unknown, sig: string) => {
        if (sig !== 'good') throw new Error('bad signature');
        return { type: 'payment_intent.succeeded', data: { object: { id: 'pi_9' } } };
      },
    },
  }).stripe;
  const p = new StripePaymentProvider(stripe, 'whsec');
  assert.throws(() => p.parseWebhook(Buffer.from('{}'), undefined));
  assert.throws(() => p.parseWebhook(Buffer.from('{}'), 'bad'));
  assert.deepEqual(p.parseWebhook(Buffer.from('{}'), 'good'), { kind: 'payment', reference: 'pi_9', status: 'succeeded' });
});
