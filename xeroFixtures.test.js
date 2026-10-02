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
  assert.equal((await data.listOpenInvoices(ctx)).length, 7); // includes Receipt Test Co's partially paid invoice
  assert.equal((await data.listOpenCredits(ctx)).length, 3);
  const contacts = await data.getContactsByIds(ctx, [ids.pinnacle, ids.bayside]);
  assert.deepEqual(contacts.map((c) => [c.name, c.email !== '']), [['Pinnacle Management', false], ['Bayside Club', true]]);
});

test('an unknown contact is a Xero 404, like the real API', async () => {
  await assert.rejects(data.getContact(ctx, '99999999-9999-4999-8999-999999999999'), (err) => err instanceof XeroError && err.code === 'XERO_NOT_FOUND');
});

test('fixtures refuse a write except the one Action Queue needs', async () => {
  const res = await createFixtureFetch()('https://api.xero.com/api.xro/2.0/Invoices', { method: 'POST' });
  assert.equal(res.status, 405);
});

test('updateInvoiceExpectedPaymentDate writes through the fixture', async () => {
  const history = await data.getInvoiceHistory(ctx, ids.harbour);
  const invoiceId = history.find((i) => i.status === 'AUTHORISED').id;
  const updated = await data.updateInvoiceExpectedPaymentDate(ctx, invoiceId, '2026-10-16');
  assert.equal(updated.ExpectedPaymentDate, '2026-10-16T00:00:00');
});

test('an unknown invoice id is a 404 for the write too', async () => {
  await assert.rejects(
    data.updateInvoiceExpectedPaymentDate(ctx, '99999999-9999-4999-8999-999999999999', '2026-10-16'),
    (err) => err instanceof XeroError && err.code === 'XERO_NOT_FOUND'
  );
});

test('an organisation with a contact scope sees only those contacts, others see everything', async () => {
  const ctxFor = (tenantId) => ({ clientId: 6, tenantId, accessToken: 'x' });
  const names = async (tenantId) => (await data.listOpenInvoices(ctxFor(tenantId))).map((i) => i.contactName);
  const scoped = new Set(await names('dev-tenant-6'));
  assert.deepEqual([...scoped].sort(), ['Bayside Club', 'Harbour Freight']);
  assert.ok((await names('dev-tenant-7')).includes('City Limousines'));
  await assert.rejects(data.getContact(ctxFor('dev-tenant-6'), ids.cityLimo), /not found/);
});

test('Payments: customer receipts only, date-filtered, and Invoices/{id} returns a PDF when asked', async () => {
  const { createXeroPayments } = require('./xeroPayments');
  const client = createXeroClient({ limiter: createMemoryLimiter(), fetchImpl: createFixtureFetch(), sleep: async () => {} });
  const payments = createXeroPayments(client);

  const recent = await payments.getRecentReceiptPayments(ctx, '2020-01-01');
  assert.deepEqual(
    recent.map((p) => p.invoiceNumber).sort(),
    ['FX1006', 'RCT-1', 'RCT-2'],
    'the bill payment (ACCPAYPAYMENT) is excluded',
  );

  const none = await payments.getRecentReceiptPayments(ctx, '2099-01-01');
  assert.deepEqual(none, []);

  const pdf = await payments.getInvoicePdf(ctx, (await data.getOpenInvoices(ctx, ids.receiptTest))[0].id);
  assert.ok(Buffer.isBuffer(pdf) && pdf.toString().startsWith('%PDF'));

  assert.equal(await payments.getInvoiceAmountDue(ctx, (await data.getOpenInvoices(ctx, ids.receiptTest))[0].id), 15000);
});
