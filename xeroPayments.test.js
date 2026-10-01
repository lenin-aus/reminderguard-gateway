'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createXeroClient } = require('./xeroClient');
const { createMemoryLimiter } = require('./xeroLimiter');
const { createXeroPayments } = require('./xeroPayments');

const ctx = { clientId: 8, tenantId: 'T1', accessToken: 'tok' };

const payment = (over = {}) => ({
  PaymentID: 'p-1',
  Status: 'AUTHORISED',
  PaymentType: 'ACCRECPAYMENT',
  Amount: 100,
  DateString: '2026-09-26T00:00:00',
  Invoice: { InvoiceID: 'inv-1', InvoiceNumber: 'ORC1042', CurrencyCode: 'AUD', Contact: { ContactID: 'c-1', Name: 'Boom FM' } },
  ...over,
});

function fakeClient(responses) {
  const queue = [...responses];
  const requests = [];
  const client = createXeroClient({
    limiter: createMemoryLimiter(),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return queue.shift();
    },
  });
  return { payments: createXeroPayments(client), requests };
}

const json = (status, body) => ({ status, ok: status < 300, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const pdf = (bytes) => ({
  status: 200,
  ok: true,
  headers: { get: () => null },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

test('only AUTHORISED customer-receipt payments with something paid come back, normalised', async () => {
  const { payments, requests } = fakeClient([
    json(200, {
      Payments: [
        payment(),
        payment({ PaymentID: 'p-2', PaymentType: 'ACCPAYPAYMENT' }), // a bill payment, not a receipt
        payment({ PaymentID: 'p-3', Status: 'DELETED' }),
        payment({ PaymentID: 'p-4', Amount: 0 }),
      ],
    }),
  ]);

  const result = await payments.getRecentReceiptPayments(ctx, '2026-09-20');

  assert.deepEqual(result, [
    {
      id: 'p-1',
      status: 'AUTHORISED',
      amount: 10000,
      date: '2026-09-26',
      invoiceId: 'inv-1',
      invoiceNumber: 'ORC1042',
      currency: 'AUD',
      reference: '',
      contactId: 'c-1',
      contactName: 'Boom FM',
    },
  ]);
  assert.match(decodeURIComponent(requests[0].url), /where=Date >= DateTime\(2026,09,20\)/);
});

test('getInvoiceAmountDue reads AmountDue fresh, in cents', async () => {
  const { payments } = fakeClient([json(200, { Invoices: [{ AmountDue: 12.5 }] })]);
  assert.equal(await payments.getInvoiceAmountDue(ctx, 'inv-1'), 1250);
});

test('getInvoicePdf returns the raw bytes, through requestBinary', async () => {
  const bytes = Buffer.from('%PDF fake');
  const { payments, requests } = fakeClient([pdf(bytes)]);
  const result = await payments.getInvoicePdf(ctx, 'inv-1');
  assert.equal(result.toString(), bytes.toString());
  assert.equal(requests[0].init.headers.Accept, 'application/pdf');
});
