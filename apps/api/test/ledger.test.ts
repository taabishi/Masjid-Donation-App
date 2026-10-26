import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceOf, createPayout, failPayout, completePayout, PLATFORM, post, recordDispute, recordRefund, settleDonation, settleUnsettled } from '../src/ledger.js';
import { MockPaymentProvider } from '../src/payments.js';
import { newId, Store, type Donation } from '../src/store.js';

function setup(policy?: Partial<Store['policy']>) {
  const store = new Store(undefined, false);
  Object.assign(store.policy, policy);
  const mosqueId = 'm1';
  const mk = (amountCents: number, status: Donation['status'] = 'succeeded', paymentRef = 'ref_' + newId()): Donation => {
    const d: Donation = { id: newId(), userId: 'u', mosqueId, amountCents, status, paymentRef, createdAt: new Date().toISOString() };
    store.data.donations.push(d);
    return d;
  };
  const total = () => store.data.ledger.reduce((s, e) => s + e.amountCents, 0);
  return { store, mosqueId, mk, total };
}

test('settling is idempotent and entries sum to the cash that landed (gross - fee)', () => {
  const { store, mosqueId, mk, total } = setup();
  const d = mk(1000);
  settleDonation(store, d, 59);
  settleDonation(store, d, 59);
  assert.equal(store.data.ledger.length, 2);
  assert.equal(balanceOf(store, mosqueId), 941); // fee passed through to the mosque
  assert.equal(total(), 941);
});

test('platform can absorb fees and take a cut; the books still balance', () => {
  const { store, mosqueId, mk, total } = setup({ passThroughProcessingFees: false, platformFeeBps: 500 });
  settleDonation(store, mk(2000), 88);
  assert.equal(balanceOf(store, mosqueId), 1900); // 2000 - 5% platform cut
  assert.equal(balanceOf(store, PLATFORM), 100 - 88); // cut minus the fee it absorbed
  assert.equal(total(), 2000 - 88);
});

test('only succeeded donations can be settled', () => {
  const { store, mk } = setup();
  assert.throws(() => settleDonation(store, mk(500, 'processing'), 10));
});

test('partial refunds are cumulative and idempotent; unsettled donations are ignored', () => {
  const { store, mosqueId, mk } = setup();
  const d = mk(1000);
  recordRefund(store, d, 200); // not settled yet: ignored
  assert.equal(store.data.ledger.length, 0);
  settleDonation(store, d, 59);
  recordRefund(store, d, 200);
  recordRefund(store, d, 200);
  recordRefund(store, d, 500); // total now 500, so another 300
  assert.equal(balanceOf(store, mosqueId), 941 - 500);
});

test('disputes deduct immediately and are reversed only if won', () => {
  const { store, mosqueId, mk } = setup();
  const d = mk(1000);
  settleDonation(store, d, 59);
  recordDispute(store, d, 'dp_1', 1000, 'opened');
  recordDispute(store, d, 'dp_1', 1000, 'opened');
  assert.equal(balanceOf(store, mosqueId), -59);
  recordDispute(store, d, 'dp_1', 1000, 'won');
  recordDispute(store, d, 'dp_1', 1000, 'won');
  assert.equal(balanceOf(store, mosqueId), 941);
  recordDispute(store, d, 'dp_unknown', 1000, 'won'); // never opened here: ignored
  assert.equal(balanceOf(store, mosqueId), 941);
});

test('payouts reserve money, cannot overdraw, and failures restore the balance', () => {
  const { store, mosqueId, mk } = setup();
  settleDonation(store, mk(1000), 59);
  assert.throws(() => createPayout(store, mosqueId, 942, 'ach_manual'));
  assert.throws(() => createPayout(store, mosqueId, 0, 'ach_manual'));
  const p = createPayout(store, mosqueId, 900, 'stripe_transfer');
  assert.equal(balanceOf(store, mosqueId), 41);
  assert.throws(() => createPayout(store, mosqueId, 100, 'ach_manual')); // money already reserved
  failPayout(store, p);
  failPayout(store, p);
  assert.equal(balanceOf(store, mosqueId), 941);
  const q = createPayout(store, mosqueId, 941, 'ach_manual');
  completePayout(store, q, 'TRACE');
  assert.equal(balanceOf(store, mosqueId), 0);
  assert.equal(q.status, 'completed');
});

test('ledger rejects non-integer amounts and duplicate keys', () => {
  const { store } = setup();
  assert.throws(() => post(store, { key: 'a', account: 'x', type: 'donation', amountCents: 1.5 }));
  assert.equal(post(store, { key: 'b', account: 'x', type: 'donation', amountCents: 1 }), true);
  assert.equal(post(store, { key: 'b', account: 'x', type: 'donation', amountCents: 1 }), false);
});

test('settleUnsettled picks up donations whose fee arrives later (bank debits)', async () => {
  const { store, mosqueId, mk } = setup();
  const provider = new MockPaymentProvider();
  let fee: number | null = null;
  provider.getFee = async () => fee;
  const d = mk(2000, 'succeeded', 'pi_bank');
  assert.equal(await settleUnsettled(store, provider), 0);
  assert.equal(balanceOf(store, mosqueId), 0);
  fee = 16;
  assert.equal(await settleUnsettled(store, provider), 1);
  assert.equal(balanceOf(store, mosqueId), 1984);
  assert.equal(await settleUnsettled(store, provider), 0);
  void d;
});
