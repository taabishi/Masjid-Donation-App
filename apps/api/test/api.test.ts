import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { MockPaymentProvider } from '../src/payments.js';
import { addPeriod, processDueRecurring } from '../src/recurring.js';
import { newRepo } from './helpers.js';
import type { NonprofitDirectory } from '../src/directory.js';

const RET = { returnUrl: 'http://localhost:8081/payment-methods' };

const stubDirectory: NonprofitDirectory = {
  async lookupEin(ein) {
    if (ein === '123456789') return { ein, name: 'New Masjid Inc', city: 'Austin', state: 'TX', subsectionCode: 3, nteeCode: 'X20' };
    if (ein === '999999999') throw new Error('directory down');
    return null;
  },
};

async function setup() {
  const { repo } = await newRepo({ seed: true });
  const payments = new MockPaymentProvider();
  const server = createApp(repo, payments, 'test', {
    apiPublicUrl: 'http://localhost',
    allowedReturnPrefixes: ['http://localhost:8081'],
    operatorEmails: ['ops@example.com'],
    directory: stubDirectory,
  }).listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const raw = async (path: string, body: Buffer, contentType: string, token: string, filename = 'letter.pdf') => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': contentType, 'x-filename': filename, authorization: `Bearer ${token}` }, body: new Uint8Array(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const download = async (path: string, token: string) => {
    const res = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
  };
  /** Register an organization and get it approved by the operator. */
  const verifiedMosque = async (email: string, ein: string, ops: string) => {
    const reg = await call('POST', '/auth/register', { name: 'Imam', email, password: 'password1', mosque: { name: 'New Masjid', city: 'Austin', state: 'TX' } });
    await call('POST', '/admin/verification', { ein, legalName: 'New Masjid Inc' }, reg.body.token);
    await call('POST', `/ops/verifications/${reg.body.user.mosqueId}`, { decision: 'approve' }, ops);
    return reg;
  };
  return { repo, payments, call, raw, download, verifiedMosque, close: async () => { server.close(); await repo.close(); } };
}

test('donor flow: favorite, donate, recurring, history', async () => {
  const { repo, payments, call, close } = await setup();
  const reg = await call('POST', '/auth/register', { name: 'Ali', email: 'ali@example.com', password: 'password1' });
  assert.equal(reg.status, 201);
  const t = reg.body.token;

  const mosques = (await call('GET', '/mosques?q=noor', undefined, t)).body;
  assert.equal(mosques.length, 1);
  const m = mosques[0];

  // no saved payment method yet
  const noPm = await call('POST', '/donations', { mosqueId: m.id, amountCents: 500 }, t);
  assert.equal(noPm.status, 409);
  assert.equal(noPm.body.code, 'no_payment_method');
  assert.equal((await call('POST', '/payment-methods', RET, t)).status, 200);
  assert.equal((await call('GET', '/payment-methods', undefined, t)).body.length, 1);

  assert.equal((await call('PUT', `/favorites/${m.id}`, undefined, t)).status, 204);
  assert.equal((await call('GET', '/favorites', undefined, t)).body[0].isFavorite, true);

  assert.equal((await call('POST', '/donations', { mosqueId: m.id, amountCents: 500 }, t)).status, 201);
  assert.equal((await call('POST', '/donations', { mosqueId: m.id, amountCents: 499 }, t)).status, 400);
  assert.equal((await call('POST', '/donations', { mosqueId: m.id, amountCents: 500, causeId: 'nope' }, t)).status, 400);

  const rec = await call('POST', '/recurring', { mosqueId: m.id, amountCents: 1500, frequency: 'weekly' }, t);
  assert.equal(rec.status, 201);
  // not due yet
  assert.equal(await processDueRecurring(repo, payments), 0);
  // due in 8 days -> one charge, schedule advances
  assert.equal(await processDueRecurring(repo, payments, new Date(Date.now() + 8 * 86_400_000)), 1);
  const hist = (await call('GET', '/donations', undefined, t)).body;
  assert.equal(hist.length, 2);

  assert.equal((await call('DELETE', `/recurring/${rec.body.id}`, undefined, t)).status, 204);
  assert.equal((await call('GET', '/recurring', undefined, t)).body.length, 0);
  await close();
});

test('platform collects for a mosque before it onboards; operator pays out from the ledger', async () => {
  const { call, close } = await setup();
  const admin = await call('POST', '/auth/register', {
    name: 'Imam', email: 'imam@example.com', password: 'password1',
    mosque: { name: 'New Masjid', city: 'Austin', state: 'TX' },
  });
  const at = admin.body.token;
  const donor = (await call('POST', '/auth/register', { name: 'Sara', email: 'sara@example.com', password: 'password1' })).body.token;
  const ops = (await call('POST', '/auth/register', { name: 'Ops', email: 'ops@example.com', password: 'password1' })).body.token;
  await call('POST', '/payment-methods', RET, donor);

  const mosque = (await call('GET', '/admin/mosque', undefined, at)).body;
  assert.equal(mosque.payoutsConnected, false);
  await call('POST', '/admin/verification', { ein: '12-3456789', legalName: 'New Masjid Inc' }, at);
  assert.equal((await call('POST', `/ops/verifications/${mosque.id}`, { decision: 'approve' }, ops)).status, 200);
  const cause = (await call('POST', '/admin/causes', { title: 'Roof Repair', description: 'Fix the roof' }, at)).body;
  // donations work even though the mosque has not connected payouts
  assert.equal((await call('POST', '/donations', { mosqueId: mosque.id, amountCents: 2500, causeId: cause.id }, donor)).status, 201);

  const report = (await call('GET', '/admin/donations', undefined, at)).body;
  assert.equal(report.summary.totalCents, 2500);
  assert.equal(report.summary.balanceCents, 2397); // 2500 minus mock card fee (2.9% + 30c)
  assert.equal(report.donations[0].donorName, 'Sara');
  assert.equal(report.donations[0].cause, 'Roof Repair');

  // only operators can see balances or pay out
  assert.equal((await call('GET', '/ops/balances', undefined, donor)).status, 403);
  assert.equal((await call('POST', '/ops/payouts', { mosqueId: mosque.id, amountCents: 100, method: 'ach_manual' }, at)).status, 403);

  const bal = (await call('GET', '/ops/balances', undefined, ops)).body;
  assert.equal(bal.mosques.find((x: { mosqueId: string }) => x.mosqueId === mosque.id).owedCents, 2397);

  // manual ACH works before onboarding; Stripe transfer does not
  assert.equal((await call('POST', '/ops/payouts', { mosqueId: mosque.id, amountCents: 1000, method: 'ach_manual', reference: 'TRACE123' }, ops)).status, 201);
  assert.equal((await call('POST', '/ops/payouts', { mosqueId: mosque.id, amountCents: 100, method: 'stripe_transfer' }, ops)).status, 409);
  // cannot pay out more than is owed
  assert.equal((await call('POST', '/ops/payouts', { mosqueId: mosque.id, amountCents: 1398, method: 'ach_manual' }, ops)).status, 409);

  assert.equal((await call('POST', '/admin/payouts/connect', RET, at)).status, 200);
  assert.equal((await call('POST', '/ops/payouts', { mosqueId: mosque.id, amountCents: 1397, method: 'stripe_transfer' }, ops)).status, 201);
  const after = (await call('GET', '/admin/donations', undefined, at)).body;
  assert.equal(after.summary.balanceCents, 0);
  assert.equal(after.payouts.length, 2);
  await close();
});

test('reconciliation matches the provider balance', async () => {
  const { call, close, verifiedMosque } = await setup();
  const ops = (await call('POST', '/auth/register', { name: 'Ops', email: 'ops@example.com', password: 'password1' })).body.token;
  const m = (await verifiedMosque('i@example.com', '123456789', ops)).body;
  const donor = (await call('POST', '/auth/register', { name: 'D', email: 'd@example.com', password: 'password1' })).body.token;
  await call('POST', '/payment-methods', RET, donor);
  const mosqueId = m.user.mosqueId;
  await call('POST', '/donations', { mosqueId, amountCents: 700 }, donor);
  await call('POST', '/donations', { mosqueId, amountCents: 1200 }, donor);
  await call('POST', '/admin/payouts/connect', RET, m.token);
  await call('POST', '/ops/payouts', { mosqueId, amountCents: 500, method: 'stripe_transfer' }, ops);
  const rec = (await call('GET', '/ops/reconcile', undefined, ops)).body;
  assert.equal(rec.diffCents, 0);
  assert.equal(rec.unsettledDonations, 0);
  await close();
});

test('authorization boundaries', async () => {
  const { call, close } = await setup();
  assert.equal((await call('GET', '/mosques')).status, 401);
  const donor = (await call('POST', '/auth/register', { name: 'A', email: 'a@example.com', password: 'password1' })).body.token;
  assert.equal((await call('GET', '/admin/mosque', undefined, donor)).status, 403);
  assert.equal((await call('POST', '/auth/login', { email: 'a@example.com', password: 'wrong' })).status, 401);
  await close();
});

test('return page only redirects to allowed addresses', async () => {
  const { call, close } = await setup();
  const t = (await call('POST', '/auth/register', { name: 'A', email: 'a@example.com', password: 'password1' })).body.token;
  assert.equal((await call('POST', '/payment-methods', { returnUrl: 'https://evil.example/x' }, t)).status, 400);
  await close();
});

test('monthly period clamps to end of month', () => {
  assert.equal(addPeriod('2026-01-31T00:00:00.000Z', 'monthly'), '2026-02-28T00:00:00.000Z');
});

test('unverified organizations are hidden and cannot receive donations or payouts', async () => {
  const { call, close } = await setup();
  const reg = await call('POST', '/auth/register', { name: 'Imam', email: 'imam@example.com', password: 'password1', mosque: { name: 'Hidden Masjid', city: 'Austin', state: 'TX' } });
  const mosqueId = reg.body.user.mosqueId;
  const donor = (await call('POST', '/auth/register', { name: 'Sara', email: 'sara@example.com', password: 'password1' })).body.token;
  const ops = (await call('POST', '/auth/register', { name: 'Ops', email: 'ops@example.com', password: 'password1' })).body.token;
  await call('POST', '/payment-methods', RET, donor);

  assert.equal((await call('GET', '/mosques?q=hidden', undefined, donor)).body.length, 0);
  const direct = await call('GET', `/mosques/${mosqueId}`, undefined, donor);
  assert.equal(direct.body.acceptingDonations, false);
  const don = await call('POST', '/donations', { mosqueId, amountCents: 500 }, donor);
  assert.equal(don.status, 409);
  assert.equal(don.body.code, 'not_accepting');
  assert.equal((await call('POST', '/recurring', { mosqueId, amountCents: 500, frequency: 'weekly' }, donor)).status, 409);
  assert.equal((await call('POST', '/admin/payouts/connect', RET, reg.body.token)).status, 409);
  assert.equal((await call('POST', '/ops/payouts', { mosqueId, amountCents: 100, method: 'ach_manual' }, ops)).status, 409);
  await close();
});

test('verification: submit EIN, human review, approval makes the organization live', async () => {
  const { call, close } = await setup();
  const ops = (await call('POST', '/auth/register', { name: 'Ops', email: 'ops@example.com', password: 'password1' })).body.token;
  const donor = (await call('POST', '/auth/register', { name: 'Sara', email: 'sara@example.com', password: 'password1' })).body.token;
  const reg = await call('POST', '/auth/register', { name: 'Imam', email: 'imam@example.com', password: 'password1', mosque: { name: 'New Masjid', city: 'Austin', state: 'TX' } });
  const at = reg.body.token;
  const mosqueId = reg.body.user.mosqueId;

  assert.equal((await call('GET', '/admin/verification', undefined, at)).body.status, 'unverified');
  assert.equal((await call('POST', '/admin/verification', { ein: '12-34', legalName: 'X' }, at)).status, 400);

  const sub = await call('POST', '/admin/verification', { ein: '12-3456789', legalName: 'New Masjid, Inc.' }, at);
  assert.equal(sub.status, 201);
  assert.equal(sub.body.status, 'pending_review');
  assert.equal(sub.body.ein, '12-3456789');
  assert.equal(sub.body.lookup.status, 'found');
  assert.equal(sub.body.lookup.nameMatch, 'exact');
  assert.equal(sub.body.lookup.stateMatch, true);
  assert.equal(sub.body.lookup.is501c3, true);

  // the same EIN can't be claimed by a second account while this claim stands
  const other = await call('POST', '/auth/register', { name: 'Other', email: 'other@example.com', password: 'password1', mosque: { name: 'Copycat', city: 'Austin', state: 'TX' } });
  assert.equal((await call('POST', '/admin/verification', { ein: '123456789', legalName: 'Copycat' }, other.body.token)).status, 409);

  // only operators review
  assert.equal((await call('GET', '/ops/verifications', undefined, donor)).status, 403);
  assert.equal((await call('POST', `/ops/verifications/${mosqueId}`, { decision: 'approve' }, at)).status, 403);
  const queue = (await call('GET', '/ops/verifications', undefined, ops)).body;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].adminEmail, 'imam@example.com');

  // rejection needs a reason, then the organization can fix and resubmit
  assert.equal((await call('POST', `/ops/verifications/${mosqueId}`, { decision: 'reject' }, ops)).status, 400);
  assert.equal((await call('POST', `/ops/verifications/${mosqueId}`, { decision: 'reject', note: 'Name does not match' }, ops)).status, 200);
  const rejected = (await call('GET', '/admin/verification', undefined, at)).body;
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.note, 'Name does not match');
  assert.equal((await call('POST', `/ops/verifications/${mosqueId}`, { decision: 'approve' }, ops)).status, 409); // nothing pending
  assert.equal((await call('POST', '/admin/verification', { ein: '123456789', legalName: 'New Masjid Inc' }, at)).status, 201);

  assert.equal((await call('POST', `/ops/verifications/${mosqueId}`, { decision: 'approve' }, ops)).status, 200);
  assert.equal((await call('GET', '/mosques?q=new masjid', undefined, donor)).body.length, 1);
  await call('POST', '/payment-methods', RET, donor);
  assert.equal((await call('POST', '/donations', { mosqueId, amountCents: 500 }, donor)).status, 201);
  assert.equal((await call('POST', '/admin/payouts/connect', RET, at)).status, 200);
  // locked once verified
  assert.equal((await call('POST', '/admin/verification', { ein: '123456789', legalName: 'New Masjid Inc' }, at)).status, 409);
  await close();
});

test('directory failures and unknown EINs still go to human review', async () => {
  const { call, close } = await setup();
  const reg = await call('POST', '/auth/register', { name: 'Imam', email: 'imam@example.com', password: 'password1', mosque: { name: 'Small Masjid', city: 'Austin', state: 'TX' } });
  const notFound = await call('POST', '/admin/verification', { ein: '111111111', legalName: 'Small Masjid' }, reg.body.token);
  assert.equal(notFound.body.status, 'pending_review');
  assert.equal(notFound.body.lookup.status, 'not_found');
  const down = await call('POST', '/admin/verification', { ein: '999999999', legalName: 'Small Masjid' }, reg.body.token);
  assert.equal(down.body.lookup.status, 'unavailable');
  assert.equal(down.body.status, 'pending_review');
  await close();
});

test('verification documents: type checks, size of set, operator-only download', async () => {
  const { call, raw, download, close } = await setup();
  const ops = (await call('POST', '/auth/register', { name: 'Ops', email: 'ops@example.com', password: 'password1' })).body.token;
  const donor = (await call('POST', '/auth/register', { name: 'Sara', email: 'sara@example.com', password: 'password1' })).body.token;
  const reg = await call('POST', '/auth/register', { name: 'Imam', email: 'imam@example.com', password: 'password1', mosque: { name: 'M', city: 'Austin', state: 'TX' } });
  const at = reg.body.token;
  const mosqueId = reg.body.user.mosqueId;
  const pdf = Buffer.from('%PDF-1.4 fake determination letter');

  const up = await raw('/admin/verification/documents', pdf, 'application/pdf', at, 'IRS letter.pdf');
  assert.equal(up.status, 201);
  assert.equal(up.body.filename, 'IRS letter.pdf');
  assert.equal((await raw('/admin/verification/documents', Buffer.from('<script>alert(1)</script>'), 'application/pdf', at)).status, 415); // content != type
  assert.equal((await raw('/admin/verification/documents', Buffer.from('hello'), 'text/html', at)).status, 415);
  assert.equal((await raw('/admin/verification/documents', pdf, 'application/pdf', donor)).status, 403);
  assert.equal((await raw('/admin/verification/documents', Buffer.alloc(6 * 1024 * 1024, 1), 'application/pdf', at)).status, 413);
  for (let i = 0; i < 4; i++) assert.equal((await raw('/admin/verification/documents', pdf, 'application/pdf', at)).status, 201);
  assert.equal((await raw('/admin/verification/documents', pdf, 'application/pdf', at)).status, 409); // limit of 5

  await call('POST', '/admin/verification', { ein: '123456789', legalName: 'M' }, at);
  const queue = (await call('GET', '/ops/verifications', undefined, ops)).body;
  assert.equal(queue[0].documents.length, 5);
  const path = `/ops/verifications/${mosqueId}/documents/${up.body.id}`;
  assert.equal((await download(path, donor)).status, 403);
  assert.equal((await download(path, at)).status, 403);
  const got = await download(path, ops);
  assert.equal(got.status, 200);
  assert.equal(got.type, 'application/pdf');
  assert.deepEqual(got.bytes, pdf);
  await close();
});
