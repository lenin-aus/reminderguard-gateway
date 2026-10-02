'use strict';

// Fixture Xero data for the local dev stack (XERO_FIXTURES=1). It stands in for the Xero
// client under xeroData.js: same request/getAllPages surface, answering from Xero-shaped JSON
// (the shapes were taken from a real Xero demo organisation). Never used in production.

const { rawInvoices, rawCreditNotes } = require('./statementFixtures');

const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = {
  cityLimo: '0a4cf37b-a1a8-4753-9ee2-f9207f63a8ff',
  pinnacle: guid(2),
  bayside: guid(3),
  harbour: guid(4),
  receiptTest: guid(5),
};

const contacts = [
  { ContactID: ids.cityLimo, Name: 'City Limousines', EmailAddress: 'accounts@citylimousines.example', ContactStatus: 'ACTIVE' },
  { ContactID: ids.pinnacle, Name: 'Pinnacle Management', EmailAddress: '', ContactStatus: 'ACTIVE' },
  { ContactID: ids.bayside, Name: 'Bayside Club', EmailAddress: 'finance@bayside.example', ContactStatus: 'ACTIVE' },
  { ContactID: ids.harbour, Name: 'Harbour Freight', EmailAddress: 'ap@harbourfreight.example', ContactStatus: 'ACTIVE' },
  // Only used by the payment-receipt fixtures below: isolated from every other contact so its
  // invoices and payments can never shift a total another test already asserts an exact figure for.
  { ContactID: ids.receiptTest, Name: 'Receipt Test Co', EmailAddress: 'ap@receipttest.example', ContactStatus: 'ACTIVE' },
];

const inv = (n, contactId, name, over) => ({
  InvoiceID: guid(100 + n),
  InvoiceNumber: `FX${1000 + n}`,
  Type: 'ACCREC',
  Status: 'AUTHORISED',
  Contact: { ContactID: contactId, Name: name },
  CurrencyCode: 'AUD',
  AmountPaid: 0,
  AmountCredited: 0,
  Payments: [],
  ...over,
});

const invoices = [
  ...rawInvoices,
  inv(1, ids.pinnacle, 'Pinnacle Management', { DateString: '2026-08-01T00:00:00', DueDateString: '2026-08-15T00:00:00', Total: 3080, AmountDue: 3080 }),
  inv(2, ids.bayside, 'Bayside Club', { DateString: '2026-09-01T00:00:00', DueDateString: '2026-09-08T00:00:00', Total: 3434, AmountDue: 3434 }),
  inv(3, ids.bayside, 'Bayside Club', { CurrencyCode: 'USD', DateString: '2026-09-10T00:00:00', DueDateString: '2026-09-20T00:00:00', Total: 100, AmountDue: 100 }),
  // Harbour Freight: one paid invoice (with its payment), one open invoice, plus credits below.
  inv(4, ids.harbour, 'Harbour Freight', {
    Status: 'PAID',
    DateString: '2026-06-01T00:00:00',
    DueDateString: '2026-06-15T00:00:00',
    Total: 500,
    AmountPaid: 500,
    AmountDue: 0,
    Payments: [{ PaymentID: guid(201), Date: '/Date(1782259200000+0000)/', Amount: 500, Reference: 'EFT' }],
  }),
  inv(5, ids.harbour, 'Harbour Freight', { DateString: '2026-09-15T00:00:00', DueDateString: '2026-10-15T00:00:00', Total: 900, AmountDue: 900 }),
  // Pinnacle Management has no email: its payment below is the "skipped, no email" receipt case.
  // PAID (not AUTHORISED), so it never shows up as still owing in any customer-list total.
  inv(6, ids.pinnacle, 'Pinnacle Management', {
    Status: 'PAID', DateString: '2026-08-20T00:00:00', DueDateString: '2026-09-03T00:00:00',
    Total: 150, AmountPaid: 150, AmountDue: 0,
  }),
  // Receipt Test Co exists only for the payment-receipt fixtures: a full payment (PAID, due 0 ->
  // "paid in full") and a partial one (still AUTHORISED, due > 0 -> "still outstanding").
  inv(7, ids.receiptTest, 'Receipt Test Co', {
    InvoiceNumber: 'RCT-1', Status: 'PAID', DateString: '2026-09-20T00:00:00', DueDateString: '2026-10-04T00:00:00',
    Total: 100, AmountPaid: 100, AmountDue: 0,
  }),
  inv(8, ids.receiptTest, 'Receipt Test Co', {
    InvoiceNumber: 'RCT-2', Status: 'AUTHORISED', DateString: '2026-09-22T00:00:00', DueDateString: '2026-10-06T00:00:00',
    Total: 200, AmountPaid: 50, AmountDue: 150,
  }),
];

// Payments are also their own Xero endpoint (GET /Payments), read by the receipt worker directly
// (not nested under an invoice). Dates are relative to "now" so they always fall inside the
// worker's lookback window, whenever the stack happens to run.
const recentDate = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString().slice(0, 19);
const pay = (n, invoiceId, invoiceNumber, contactId, contactName, amount, hoursAgo, over = {}) => ({
  PaymentID: guid(400 + n),
  Status: 'AUTHORISED',
  PaymentType: 'ACCRECPAYMENT',
  Amount: amount,
  DateString: recentDate(hoursAgo),
  Invoice: { InvoiceID: invoiceId, InvoiceNumber: invoiceNumber, CurrencyCode: 'AUD', Contact: { ContactID: contactId, Name: contactName } },
  ...over,
});
const payments = [
  pay(1, guid(106), 'FX1006', ids.pinnacle, 'Pinnacle Management', 150, 3), // -> SKIPPED_NO_EMAIL
  pay(2, guid(107), 'RCT-1', ids.receiptTest, 'Receipt Test Co', 100, 2), // -> SENT, paid in full
  pay(3, guid(108), 'RCT-2', ids.receiptTest, 'Receipt Test Co', 50, 1), // -> SENT, still outstanding
  pay(4, guid(104), 'FX1004', ids.harbour, 'Harbour Freight', 500, 240, { PaymentType: 'ACCPAYPAYMENT' }), // a bill payment: must be ignored
];

const creditNotes = rawCreditNotes;
const overpayments = [
  { OverpaymentID: guid(301), Type: 'RECEIVE-OVERPAYMENT', Status: 'AUTHORISED', Contact: { ContactID: ids.harbour }, CurrencyCode: 'AUD', DateString: '2026-09-18T00:00:00', Total: 25, RemainingCredit: 25, Allocations: [] },
];
const prepayments = [
  { PrepaymentID: guid(302), Reference: 'Deposit', Type: 'RECEIVE-PREPAYMENT', Status: 'AUTHORISED', Contact: { ContactID: ids.harbour }, CurrencyCode: 'AUD', DateString: '2026-09-02T00:00:00', Total: 100, RemainingCredit: 100, Allocations: [] },
];

// The dev seed's other organisations see only some of the contacts, so switching organisations
// visibly changes the customer list. Any other tenant (dev-tenant-7, a sign-in that created a new
// org) sees everything.
const TENANT_CONTACTS = {
  'dev-tenant-6': [ids.bayside, ids.harbour],
  'dev-tenant-5': [ids.pinnacle],
};
const visibleTo = (tenantId, contactId) => !TENANT_CONTACTS[tenantId] || TENANT_CONTACTS[tenantId].includes(contactId);

const ID_FIELD = { Invoices: 'InvoiceID', CreditNotes: 'CreditNoteID', Overpayments: 'OverpaymentID', Prepayments: 'PrepaymentID', Payments: 'PaymentID' };

const SOURCES = { Invoices: invoices, CreditNotes: creditNotes, Overpayments: overpayments, Prepayments: prepayments, Payments: payments };

// A payment's contact lives at Invoice.Contact, unlike every other fixture source.
const contactIdOf = (x) => x.Contact?.ContactID || x.Invoice?.Contact?.ContactID;

// Understands the filters xeroData.js and xeroPayments.js use: ContactIDs/Statuses on Invoices,
// where=Contact.ContactID==Guid("..") [AND Status=="..."] on the credit endpoints, and
// where=Date >= DateTime(y,m,d) on Payments.
function filterList(path, query, tenantId) {
  let items = (SOURCES[path] || []).filter((x) => visibleTo(tenantId, contactIdOf(x)));
  const ids = query.get('IDs');
  if (ids) items = items.filter((x) => ids.split(',').includes(x[ID_FIELD[path]]));
  const contactIds = query.get('ContactIDs');
  if (contactIds) {
    const wanted = contactIds.split(',');
    items = items.filter((x) => wanted.includes(x.Contact?.ContactID));
  }
  const statuses = query.get('Statuses');
  if (statuses) {
    const wanted = statuses.split(',');
    items = items.filter((x) => wanted.includes(x.Status));
  }
  const where = query.get('where');
  if (where) {
    const contact = /Contact\.ContactID==Guid\("([^"]+)"\)/.exec(where);
    if (contact) items = items.filter((x) => x.Contact?.ContactID === contact[1]);
    const status = /Status=="([A-Z]+)"/.exec(where);
    if (status) items = items.filter((x) => x.Status === status[1]);
    const since = /Date >= DateTime\((\d+),(\d+),(\d+)\)/.exec(where);
    if (since) {
      const cutoff = `${since[1]}-${since[2]}-${since[3]}`;
      items = items.filter((x) => (x.DateString || '').slice(0, 10) >= cutoff);
    }
  }
  return items;
}

function json(status, body) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

// A tiny fake PDF: enough bytes to attach and send, never actually rendered.
function pdf(label) {
  const bytes = Buffer.from(`%PDF-1.4 fixture invoice ${label}`);
  return { status: 200, ok: true, headers: { get: () => null }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

// A stand-in for fetch(), so the REAL Xero client (paging, retries, limiter) runs on top of it.
// It pages lists 100 at a time like Xero does, and answers only GETs on api.xro/2.0 — except the
// one write Action Queue needs (Approve & Send setting an invoice's ExpectedPaymentDate), added so
// that whole flow can be proven on the local stack before it is ever run for real.
function createFixtureFetch() {
  return async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace('/api.xro/2.0/', '');
    const query = u.searchParams;
    const tenantId = init.headers?.['Xero-tenant-id'];

    if ((init.method || 'GET') === 'POST' && path.startsWith('Invoices/')) {
      const id = path.slice('Invoices/'.length);
      const found = invoices.find((x) => x.InvoiceID === id && visibleTo(tenantId, contactIdOf(x)));
      if (!found) return json(404, { Title: 'Not found' });
      const body = JSON.parse(init.body || '{}');
      const patch = body.Invoices?.[0] || {};
      if (patch.ExpectedPaymentDate) found.ExpectedPaymentDate = `${patch.ExpectedPaymentDate}T00:00:00`;
      return json(200, { Invoices: [found] });
    }
    if ((init.method || 'GET') !== 'GET') return json(405, { error: 'Fixtures answer GET only' });

    if (path.startsWith('Contacts/')) {
      const id = path.slice('Contacts/'.length);
      const found = contacts.filter((c) => c.ContactID === id && visibleTo(tenantId, c.ContactID));
      return found.length ? json(200, { Contacts: found }) : json(404, { Title: 'Not found' });
    }
    if (path === 'Contacts') {
      // With IDs: those contacts. Without: every contact (what the sync's full pull reads), paged.
      const ids = query.get('IDs');
      let list = contacts.filter((c) => visibleTo(tenantId, c.ContactID));
      if (ids) list = list.filter((c) => ids.split(',').includes(c.ContactID));
      const page = Number(query.get('page') || 1);
      return json(200, { Contacts: ids ? list : list.slice((page - 1) * 100, page * 100) });
    }
    if (path === 'Organisation') return json(200, { Organisations: [{ BaseCurrency: 'AUD', Name: 'Fixture Organisation', ShortCode: '!fixture' }] });
    const [listName, itemId] = path.split('/');
    if (listName === 'Invoices' && itemId && String(init.headers?.Accept || '').includes('pdf')) {
      const found = invoices.find((x) => x.InvoiceID === itemId && visibleTo(tenantId, contactIdOf(x)));
      return found ? pdf(found.InvoiceNumber) : json(404, { Title: 'Not found' });
    }
    if (itemId && SOURCES[listName]) {
      const found = SOURCES[listName].find((x) => x[ID_FIELD[listName]] === itemId && visibleTo(tenantId, x.Contact?.ContactID));
      return found ? json(200, { [listName]: [found] }) : json(404, { Title: 'Not found' });
    }
    if (SOURCES[path]) {
      const all = filterList(path, query, tenantId);
      const page = Number(query.get('page') || 1);
      return json(200, { [path]: all.slice((page - 1) * 100, page * 100) });
    }
    return json(404, { Title: `No fixture for ${path}` });
  };
}

module.exports = { createFixtureFetch, ids };
