'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createXeroClient, XeroError } = require('./xeroClient');
const { createMemoryLimiter } = require('./xeroLimiter');
const { createXeroData } = require('./xeroData');
const { createFixtureFetch, ids } = require('./xeroFixtures');

const ctx = { clientId: 7, tenantId: 'fixture-tenant', accessToken: 'x' };
const data = createXeroData(createXeroClient({ limiter: createMemoryLimiter(), fetchImpl: createFixtureFetch(), sleep: async () => {} }));

test('the real client and data layer run on top of the fixtures', async () => {
  const history = await data.getInvoiceHistory(ctx, ids.harbour);
  assert.deepEqual(history.map((i) => [i.number, i.status]), [['FX1004', 'PAID'], ['FX1005', 'AUTHORISED']]);
  assert.equal(history[0].payments[0].date, '2026-06-24');
  const credits = await data.getCredits(ctx, ids.harbour);
  assert.deepEqual(credits.map((c) => [c.kind, c.remaining]).sort(), [['overpayment', 2500], ['prepayment', 10000]]);
});

test('org-wide lists are complete and contacts report whether they have an email', async () => {
  assert.equal((await data.listOpenInvoices(ctx)).length, 6);
  assert.equal((await data.listOpenCredits(ctx)).length, 3);
  const contacts = await data.getContactsByIds(ctx, [ids.pinnacle, ids.bayside]);
  assert.deepEqual(contacts.map((c) => [c.name, c.email !== '']), [['Pinnacle Management', false], ['Bayside Club', true]]);
});

test('an unknown contact is a Xero 404, like the real API', async () => {
  await assert.rejects(data.getContact(ctx, '99999999-9999-4999-8999-999999999999'), (err) => err instanceof XeroError && err.code === 'XERO_NOT_FOUND');
});

test('fixtures refuse anything but GET', async () => {
  const res = await createFixtureFetch()('https://api.xero.com/api.xro/2.0/Invoices', { method: 'POST' });
  assert.equal(res.status, 405);
});
