import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEin, formatEin, nameMatch, normalizeEin, ProPublicaDirectory } from '../src/directory.js';

test('EIN normalization', () => {
  assert.equal(normalizeEin('12-3456789'), '123456789');
  assert.equal(normalizeEin(' 12 3456789 '), '123456789');
  assert.equal(normalizeEin('12345678'), null);
  assert.equal(normalizeEin('000000000'), null);
  assert.equal(normalizeEin('12-345678a'), null);
  assert.equal(formatEin('123456789'), '12-3456789');
});

test('name matching ignores punctuation and corporate suffixes', () => {
  assert.equal(nameMatch('Masjid Al-Noor, Inc.', 'MASJID AL NOOR'), 'exact');
  assert.equal(nameMatch('Masjid Al Noor of Dearborn', 'Masjid Al Noor'), 'close');
  assert.equal(nameMatch('Islamic Center', 'Baptist Church of Austin'), 'different');
  assert.equal(nameMatch('', 'Anything'), 'different');
});

test('checkEin reports found / not_found / unavailable without throwing', async () => {
  const rec = { ein: '123456789', name: 'New Masjid Inc', state: 'TX', subsectionCode: 3 };
  const found = await checkEin({ lookupEin: async () => rec }, '123456789', 'New Masjid', 'tx');
  assert.deepEqual([found.status, found.nameMatch, found.stateMatch, found.is501c3], ['found', 'exact', true, true]);
  const other = await checkEin({ lookupEin: async () => ({ ...rec, subsectionCode: 7, state: 'CA' }) }, '123456789', 'New Masjid', 'TX');
  assert.deepEqual([other.stateMatch, other.is501c3], [false, false]);
  assert.equal((await checkEin({ lookupEin: async () => null }, '1', 'x', 'TX')).status, 'not_found');
  assert.equal((await checkEin({ lookupEin: async () => { throw new Error('boom'); } }, '1', 'x', 'TX')).status, 'unavailable');
});

test('ProPublica client parses the documented shape, 404 as not found, other errors as failures', async () => {
  const mk = (status: number, body?: unknown) => new ProPublicaDirectory('https://x.test/api/v2', (async () => new Response(JSON.stringify(body ?? {}), { status })) as typeof fetch);
  const org = await mk(200, { organization: { ein: 530196605, name: 'AMERICAN NATIONAL RED CROSS', city: 'WASHINGTON', state: 'DC', subsection_code: 3, ntee_code: 'P20', ruling_date: '1946-02-01' } }).lookupEin('530196605');
  assert.deepEqual(org, { ein: '530196605', name: 'AMERICAN NATIONAL RED CROSS', city: 'WASHINGTON', state: 'DC', subsectionCode: 3, nteeCode: 'P20', rulingDate: '1946-02-01' });
  assert.equal(await mk(404).lookupEin('111111111'), null);
  assert.equal(await mk(200, {}).lookupEin('111111111'), null);
  await assert.rejects(mk(503).lookupEin('111111111'));
  // leading zeros are restored when the API returns the EIN as a number
  assert.equal((await mk(200, { organization: { ein: 12345678, name: 'X' } }).lookupEin('012345678'))?.ein, '012345678');
});

import { productionConfigProblems } from '../src/config.js';

test('production refuses to start with risky or missing settings', () => {
  const good = {
    JWT_SECRET: 'x'.repeat(32), DATABASE_URL: 'postgres://x', CORS_ORIGINS: 'https://app.example', API_PUBLIC_URL: 'https://api.example',
    STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x',
  };
  assert.deepEqual(productionConfigProblems(good), []);
  assert.equal(productionConfigProblems({}).length, 5);
  // forgetting Stripe must not silently fall back to fake payments
  const noStripe = { ...good, STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined };
  assert.equal(productionConfigProblems(noStripe).length, 1);
  assert.deepEqual(productionConfigProblems({ ...noStripe, ALLOW_MOCK_PAYMENTS: 'true' }), []);
  assert.equal(productionConfigProblems({ ...good, STRIPE_WEBHOOK_SECRET: undefined }).length, 1);
  assert.equal(productionConfigProblems({ ...good, JWT_SECRET: 'short' }).length, 1);
});
