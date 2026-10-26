import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { MockPaymentProvider } from '../src/payments.js';
import { addPeriod, processDueRecurring } from '../src/recurring.js';
import { Store } from '../src/store.js';

const RET = { returnUrl: 'http://localhost:8081/payment-methods' };

async function setup() {
  const store = new Store();
  const payments = new MockPaymentProvider();
  const server = createApp(store, payments, 'test').listen(0);
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
  return { store, payments, call, close: () => server.close() };
}

test('donor flow: favorite, donate, recurring, history', async () => {
  const { store, payments, call, close } = await setup();
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
  assert.equal((await call('POST', '/donations', { mosqueId: m.id, amountCents: 5 }, t)).status, 400);
  assert.equal((await call('POST', '/donations', { mosqueId: m.id, amountCents: 500, causeId: 'nope' }, t)).status, 400);

  const rec = await call('POST', '/recurring', { mosqueId: m.id, amountCents: 1500, frequency: 'weekly' }, t);
  assert.equal(rec.status, 201);
  // not due yet
  assert.equal(await processDueRecurring(store, payments), 0);
  // due in 8 days -> one charge, schedule advances
  assert.equal(await processDueRecurring(store, payments, new Date(Date.now() + 8 * 86_400_000)), 1);
  const hist = (await call('GET', '/donations', undefined, t)).body;
  assert.equal(hist.length, 2);

  assert.equal((await call('DELETE', `/recurring/${rec.body.id}`, undefined, t)).status, 204);
  assert.equal((await call('GET', '/recurring', undefined, t)).body.length, 0);
  close();
});

test('admin flow: mosque must connect payouts before accepting donations', async () => {
  const { call, close } = await setup();
  const admin = await call('POST', '/auth/register', {
    name: 'Imam', email: 'imam@example.com', password: 'password1',
    mosque: { name: 'New Masjid', city: 'Austin', state: 'TX' },
  });
  const at = admin.body.token;
  const donor = (await call('POST', '/auth/register', { name: 'Sara', email: 'sara@example.com', password: 'password1' })).body.token;
  await call('POST', '/payment-methods', RET, donor);

  const mosque = (await call('GET', '/admin/mosque', undefined, at)).body;
  assert.equal((await call('POST', '/donations', { mosqueId: mosque.id, amountCents: 500 }, donor)).status, 409);

  assert.equal((await call('POST', '/admin/payouts/connect', RET, at)).status, 200);
  const cause = (await call('POST', '/admin/causes', { title: 'Roof Repair', description: 'Fix the roof' }, at)).body;
  assert.equal((await call('POST', '/donations', { mosqueId: mosque.id, amountCents: 2500, causeId: cause.id }, donor)).status, 201);

  const report = (await call('GET', '/admin/donations', undefined, at)).body;
  assert.equal(report.summary.totalCents, 2500);
  assert.equal(report.donations[0].donorName, 'Sara');
  assert.equal(report.donations[0].cause, 'Roof Repair');
  close();
});

test('authorization boundaries', async () => {
  const { call, close } = await setup();
  assert.equal((await call('GET', '/mosques')).status, 401);
  const donor = (await call('POST', '/auth/register', { name: 'A', email: 'a@example.com', password: 'password1' })).body.token;
  assert.equal((await call('GET', '/admin/mosque', undefined, donor)).status, 403);
  assert.equal((await call('POST', '/auth/login', { email: 'a@example.com', password: 'wrong' })).status, 401);
  close();
});

test('return page only redirects to allowed addresses', async () => {
  const { call, close } = await setup();
  const t = (await call('POST', '/auth/register', { name: 'A', email: 'a@example.com', password: 'password1' })).body.token;
  assert.equal((await call('POST', '/payment-methods', { returnUrl: 'https://evil.example/x' }, t)).status, 400);
  close();
});

test('monthly period clamps to end of month', () => {
  assert.equal(addPeriod('2026-01-31T00:00:00.000Z', 'monthly'), '2026-02-28T00:00:00.000Z');
});
