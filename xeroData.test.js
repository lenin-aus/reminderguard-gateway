'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createXeroData, xeroLocalDate, normalizeInvoice, cents } = require('./xeroData');

const CTX = { clientId: 8, tenantId: 'T1', accessToken: 'tok' };
const CONTACT = '0a4cf37b-a1a8-4753-9ee2-f9207f63a8ff';

// Records what was asked and answers from canned lists keyed by endpoint.
function fakeClient(lists = {}, contacts = {}) {
  const calls = [];
  return {
    calls,
    async request(ctx, path, opts) {
      calls.push({ path, opts });
      return contacts;
    },
    async getAllPages(ctx, path, opts) {
      calls.push({ path, opts });
      return lists[path] || [];
    },
  };
}

const invoice = (over = {}) => ({
  InvoiceID: 'inv-1',
  InvoiceNumber: 'ORC1002',
  Type: 'ACCREC',
  Status: 'AUTHORISED',
  Contact: { ContactID: CONTACT },
  CurrencyCode: 'AUD',
  DateString: '2026-07-03T00:00:00',
  DueDateString: '2026-07-13T00:00:00',
  Total: 1100,
  AmountPaid: 850,
  AmountCredited: 0,
  AmountDue: 250,
  UpdatedDateUTCString: '2026-07-13T02:15:30',
  Payments: [],
  ...over,
});

test('xeroLocalDate reads both of Xero\'s date formats as the same calendar day', () => {
  assert.equal(xeroLocalDate('2026-07-03T00:00:00'), '2026-07-03');
  assert.equal(xeroLocalDate('/Date(1783036800000+0000)/'), '2026-07-03');
  assert.equal(xeroLocalDate(null), null);
  assert.equal(xeroLocalDate(undefined), null);
});

test('amounts become integer cents without floating-point drift', () => {
  assert.equal(cents(0.1 + 0.2), 30);
  assert.equal(cents(660.1), 66010);
  assert.equal(cents('1100.00'), 110000);
  assert.equal(cents(null), 0);
});

test('normalizeInvoice maps fields, drops deleted payments and reads the update instant as UTC', () => {
  const n = normalizeInvoice(
    invoice({
      Payments: [
        { PaymentID: 'p1', DateString: '2026-07-13T00:00:00', Amount: 850, Reference: 'EFT' },
        { PaymentID: 'p2', DateString: '2026-07-14T00:00:00', Amount: 5, Status: 'DELETED' },
      ],
    })
  );
  assert.equal(n.number, 'ORC1002');
  assert.equal(n.date, '2026-07-03');
  assert.equal(n.dueDate, '2026-07-13');
  assert.equal(n.amountDue, 25000);
  assert.equal(n.updatedAt, '2026-07-13T02:15:30.000Z');
  assert.deepEqual(n.payments, [{ id: 'p1', date: '2026-07-13', amount: 85000, reference: 'EFT' }]);
});

test('getOpenInvoices asks for one contact\'s AUTHORISED invoices and keeps only receivables with a balance', async () => {
  const client = fakeClient({
    Invoices: [invoice(), invoice({ InvoiceID: 'b', Type: 'ACCPAY' }), invoice({ InvoiceID: 'c', AmountDue: 0 })],
  });
  const result = await createXeroData(client).getOpenInvoices(CTX, CONTACT);

  assert.deepEqual(result.map((i) => i.id), ['inv-1']);
  assert.deepEqual(client.calls[0].opts.query, { ContactIDs: CONTACT, Statuses: 'AUTHORISED' });
});

test('getCredits merges credit notes, overpayments and prepayments, receivable side only', async () => {
  const client = fakeClient({
    CreditNotes: [
      { CreditNoteID: 'cn1', CreditNoteNumber: 'ORC1037', Type: 'ACCRECCREDIT', Status: 'AUTHORISED', CurrencyCode: 'AUD', DateString: '2026-08-23T00:00:00', Total: 60.5, RemainingCredit: 60.5, Allocations: [] },
      { CreditNoteID: 'cn2', CreditNoteNumber: 'SUP1', Type: 'ACCPAYCREDIT', Status: 'AUTHORISED', CurrencyCode: 'AUD', DateString: '2026-08-01T00:00:00', Total: 10, RemainingCredit: 10 },
      { CreditNoteID: 'cn3', CreditNoteNumber: 'ORC9', Type: 'ACCRECCREDIT', Status: 'VOIDED', CurrencyCode: 'AUD', DateString: '2026-08-02T00:00:00', Total: 10, RemainingCredit: 0 },
      { CreditNoteID: 'cn4', CreditNoteNumber: 'ORC8', Type: 'ACCRECCREDIT', Status: 'DRAFT', CurrencyCode: 'AUD', DateString: '2026-08-02T00:00:00', Total: 10, RemainingCredit: 10 },
      {
        CreditNoteID: 'cn5', CreditNoteNumber: 'ORC7', Type: 'ACCRECCREDIT', Status: 'PAID', CurrencyCode: 'AUD', DateString: '2026-07-01T00:00:00', Total: 40, RemainingCredit: 0,
        Allocations: [{ Amount: 40, DateString: '2026-07-02T00:00:00', Invoice: { InvoiceNumber: 'ORC1002' } }],
      },
    ],
    Overpayments: [
      { OverpaymentID: 'op1', Type: 'RECEIVE-OVERPAYMENT', Status: 'AUTHORISED', CurrencyCode: 'AUD', DateString: '2026-09-01T00:00:00', Total: 25, RemainingCredit: 25 },
      { OverpaymentID: 'op2', Type: 'SPEND-OVERPAYMENT', Status: 'AUTHORISED', CurrencyCode: 'AUD', DateString: '2026-09-01T00:00:00', Total: 5, RemainingCredit: 5 },
    ],
    Prepayments: [
      { PrepaymentID: 'pp1', Reference: 'Deposit', Type: 'RECEIVE-PREPAYMENT', Status: 'AUTHORISED', CurrencyCode: 'AUD', DateString: '2026-09-10T00:00:00', Total: 100, RemainingCredit: 100 },
    ],
  });
  const credits = await createXeroData(client).getCredits(CTX, CONTACT);

  assert.deepEqual(credits.map((c) => c.id).sort(), ['cn1', 'cn5', 'op1', 'pp1']);
  const cn1 = credits.find((c) => c.id === 'cn1');
  assert.deepEqual([cn1.kind, cn1.number, cn1.date, cn1.total, cn1.remaining], ['creditNote', 'ORC1037', '2026-08-23', 6050, 6050]);
  assert.deepEqual(credits.find((c) => c.id === 'cn5').allocations, [{ date: '2026-07-02', amount: 4000, invoiceNumber: 'ORC1002' }]);
  assert.equal(credits.find((c) => c.id === 'pp1').number, 'Deposit');
  assert.equal(credits.find((c) => c.id === 'op1').number, 'Overpayment');
  for (const call of client.calls) assert.equal(call.opts.query.where, `Contact.ContactID==Guid("${CONTACT}")`);
});

test('getInvoiceActivity sends If-Modified-Since as a UTC timestamp and keeps receivables only', async () => {
  const client = fakeClient({ Invoices: [invoice(), invoice({ InvoiceID: 'b', Type: 'ACCPAY' })] });
  const result = await createXeroData(client).getInvoiceActivity(CTX, CONTACT, { modifiedSinceUtc: '2026-05-26T14:00:00.000Z' });

  assert.deepEqual(result.map((i) => i.id), ['inv-1']);
  assert.deepEqual(client.calls[0].opts.query, { ContactIDs: CONTACT, Statuses: 'AUTHORISED,PAID' });
  assert.deepEqual(client.calls[0].opts.headers, { 'If-Modified-Since': '2026-05-26T14:00:00' });
});

test('contact ids are validated before they reach a Xero filter', async () => {
  const data = createXeroData(fakeClient());
  const bad = 'x") OR (Total>0';
  await assert.rejects(data.getCredits(CTX, bad), /valid Xero contact id/);
  await assert.rejects(data.getOpenInvoices(CTX, bad), /valid Xero contact id/);
  await assert.rejects(data.getInvoiceActivity(CTX, bad, { modifiedSinceUtc: '2026-01-01T00:00:00Z' }), /valid Xero contact id/);
  await assert.rejects(data.getContact(CTX, bad), /valid Xero contact id/);
});

test('getContact trims the email and reports an archived contact', async () => {
  const client = fakeClient({}, { Contacts: [{ ContactID: CONTACT, Name: 'City Limousines', EmailAddress: '  a@b.co ', ContactStatus: 'ARCHIVED' }] });
  assert.deepEqual(await createXeroData(client).getContact(CTX, CONTACT), { id: CONTACT, name: 'City Limousines', email: 'a@b.co', archived: true });
  assert.equal(await createXeroData(fakeClient({}, { Contacts: [] })).getContact(CTX, CONTACT), null);
});

test('listOpenCredits keeps only credits that still have a balance', async () => {
  const client = fakeClient({
    CreditNotes: [
      { CreditNoteID: 'a', Type: 'ACCRECCREDIT', Status: 'AUTHORISED', CurrencyCode: 'AUD', Total: 10, RemainingCredit: 10 },
      { CreditNoteID: 'b', Type: 'ACCRECCREDIT', Status: 'AUTHORISED', CurrencyCode: 'AUD', Total: 10, RemainingCredit: 0 },
    ],
  });
  const credits = await createXeroData(client).listOpenCredits(CTX);
  assert.deepEqual(credits.map((c) => c.id), ['a']);
  assert.equal(client.calls[0].opts.query.where, 'Status=="AUTHORISED"');
});
