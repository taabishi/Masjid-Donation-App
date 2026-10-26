import test from 'node:test';
import assert from 'node:assert/strict';
import { completePayout, createPayout, failPayout, PLATFORM, recordDispute, recordRefund, settleDonation, settleUnsettled } from '../src/ledger.js';
import { MockPaymentProvider } from '../src/payments.js';
import { newId, type Donation } from '../src/types.js';
import { newRepo } from './helpers.js';

async function setup(policy?: Partial<import('../src/types.js').FeePolicy>) {
  const { repo, db } = await newRepo({ policy });
  const mosqueId = newId();
  await repo.createMosque({ id: mosqueId, name: 'M', city: 'C', state: 'S', address: '', description: '', causes: [], payoutsConnected: false });
  const userId = newId();
  await repo.createUser({ id: userId, name: 'U', email: `${userId}@x.test`, passwordHash: 'x', role: 'donor' });
  const mk = (amountCents: number, status: Donation['status'] = 'succeeded', paymentRef = 'ref_' + newId()) =>
    repo.createDonation({ id: newId(), userId, mosqueId, amountCents, status, paymentRef, createdAt: new Date().toISOString() });
  return { repo, db, mosqueId, mk, total: () => repo.ledgerTotal() };
}

test('settling is idempotent and entries sum to the cash that landed (gross - fee)', async () => {
  const { repo, mosqueId, mk, total } = await setup();
  const d = await mk(1000);
  await settleDonation(repo, d, 59);
  await settleDonation(repo, d, 59);
  assert.equal((await repo.recentLedger()).length, 2);
  assert.equal(await repo.balanceOf(mosqueId), 941); // fee passed through to the mosque
  assert.equal(await total(), 941);
});

test('platform can absorb fees and take a cut; the books still balance', async () => {
  const { repo, mosqueId, mk, total } = await setup({ passThroughProcessingFees: false, platformFeeBps: 500 });
  await settleDonation(repo, await mk(2000), 88);
  assert.equal(await repo.balanceOf(mosqueId), 1900); // 2000 - 5% platform cut
  assert.equal(await repo.balanceOf(PLATFORM), 100 - 88); // cut minus the fee it absorbed
  assert.equal(await total(), 2000 - 88);
});

test('only succeeded donations can be settled', async () => {
  const { repo, mk } = await setup();
  await assert.rejects(settleDonation(repo, await mk(500, 'processing'), 10));
});

test('partial refunds are cumulative and idempotent; unsettled donations are ignored', async () => {
  const { repo, mosqueId, mk } = await setup();
  const d = await mk(1000);
  await recordRefund(repo, d, 200); // not settled yet: ignored
  assert.equal((await repo.recentLedger()).length, 0);
  await settleDonation(repo, d, 59);
  await recordRefund(repo, d, 200);
  await recordRefund(repo, d, 200);
  await recordRefund(repo, d, 500); // total now 500, so another 300
  assert.equal(await repo.balanceOf(mosqueId), 941 - 500);
});

test('disputes deduct immediately and are reversed only if won', async () => {
  const { repo, mosqueId, mk } = await setup();
  const d = await mk(1000);
  await settleDonation(repo, d, 59);
  await recordDispute(repo, d, 'dp_1', 1000, 'opened');
  await recordDispute(repo, d, 'dp_1', 1000, 'opened');
  assert.equal(await repo.balanceOf(mosqueId), -59);
  await recordDispute(repo, d, 'dp_1', 1000, 'won');
  await recordDispute(repo, d, 'dp_1', 1000, 'won');
  assert.equal(await repo.balanceOf(mosqueId), 941);
  await recordDispute(repo, d, 'dp_unknown', 1000, 'won'); // never opened here: ignored
  assert.equal(await repo.balanceOf(mosqueId), 941);
});

test('payouts reserve money, cannot overdraw, and failures restore the balance', async () => {
  const { repo, mosqueId, mk } = await setup();
  await settleDonation(repo, await mk(1000), 59);
  await assert.rejects(createPayout(repo, mosqueId, 942, 'ach_manual'));
  await assert.rejects(createPayout(repo, mosqueId, 0, 'ach_manual'));
  const p = await createPayout(repo, mosqueId, 900, 'stripe_transfer');
  assert.equal(await repo.balanceOf(mosqueId), 41);
  await assert.rejects(createPayout(repo, mosqueId, 100, 'ach_manual')); // money already reserved
  await failPayout(repo, p);
  await failPayout(repo, p);
  assert.equal(await repo.balanceOf(mosqueId), 941);
  const q = await createPayout(repo, mosqueId, 941, 'ach_manual');
  await completePayout(repo, q, 'TRACE');
  assert.equal(await repo.balanceOf(mosqueId), 0);
  assert.deepEqual((await repo.payoutsForMosque(mosqueId)).map((x) => [x.status, x.reference]), [['completed', 'TRACE']]);
});

test('two simultaneous payouts cannot spend the same money', async () => {
  const { repo, mosqueId, mk } = await setup();
  await settleDonation(repo, await mk(1000), 0);
  const results = await Promise.allSettled([createPayout(repo, mosqueId, 700, 'ach_manual'), createPayout(repo, mosqueId, 700, 'ach_manual')]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(await repo.balanceOf(mosqueId), 300);
});

test('settleUnsettled picks up donations whose fee arrives later (bank debits)', async () => {
  const { repo, mosqueId, mk } = await setup();
  const provider = new MockPaymentProvider();
  let fee: number | null = null;
  provider.getFee = async () => fee;
  await mk(2000, 'succeeded', 'pi_bank');
  assert.equal(await settleUnsettled(repo, provider), 0);
  assert.equal(await repo.balanceOf(mosqueId), 0);
  fee = 16;
  assert.equal(await settleUnsettled(repo, provider), 1);
  assert.equal(await repo.balanceOf(mosqueId), 1984);
  assert.equal(await settleUnsettled(repo, provider), 0);
});

// ---- database-level guarantees ----

test('the database refuses to edit, delete or truncate ledger entries', async () => {
  const { repo, db, mk } = await setup();
  await settleDonation(repo, await mk(1000), 59);
  await assert.rejects(db.query('UPDATE ledger_entries SET amount_cents = 1'), /append-only/);
  await assert.rejects(db.query('DELETE FROM ledger_entries'), /append-only/);
  await assert.rejects(db.query('TRUNCATE ledger_entries'), /append-only/);
  assert.equal(await repo.ledgerTotal(), 941);
});

test('row level security is enabled on every table (blocks Supabase anon-key access)', async () => {
  const { db } = await setup();
  const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
    `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'`,
  );
  assert.ok(rows.length >= 8);
  assert.deepEqual(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname), []);
});

test('a retried charge cannot create a second donation row', async () => {
  const { repo, mk } = await setup();
  const first = await mk(500, 'succeeded', 'pi_same');
  const second = await mk(500, 'succeeded', 'pi_same');
  assert.equal(second.id, first.id);
  assert.equal((await repo.donationsForUser(first.userId)).length, 1);
});

test('database constraints reject bad money values', async () => {
  const { db, mosqueId, mk } = await setup();
  await assert.rejects(mk(0));
  await assert.rejects(db.query(`INSERT INTO payouts (id, mosque_id, amount_cents, method, status, created_at) VALUES ('p', $1, -5, 'ach_manual', 'pending', now())`, [mosqueId]));
});
