'use strict';

// Fixture Xero data for the local dev stack (XERO_FIXTURES=1). It stands in for the Xero
// client under xeroData.js: same request/getAllPages surface, answering from Xero-shaped JSON
// (the shapes were taken from a real Xero demo organisation). Never used in production.

const { rawInvoices, rawCreditNotes } = require('./statementFixtures');

const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = { cityLimo: '0a4cf37b-a1a8-4753-9ee2-f9207f63a8ff', pinnacle: guid(2), bayside: guid(3), harbour: guid(4) };

const contacts = [
  { ContactID: ids.cityLimo, Name: 'City Limousines', EmailAddress: 'accounts@citylimousines.example', ContactStatus: 'ACTIVE' },
  { ContactID: ids.pinnacle, Name: 'Pinnacle Management', EmailAddress: '', ContactStatus: 'ACTIVE' },
  { ContactID: ids.bayside, Name: 'Bayside Club', EmailAddress: 'finance@bayside.example', ContactStatus: 'ACTIVE' },
  { ContactID: ids.harbour, Name: 'Harbour Freight', EmailAddress: 'ap@harbourfreight.example', ContactStatus: 'ACTIVE' },
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

const SOURCES = { Invoices: invoices, CreditNotes: creditNotes, Overpayments: overpayments, Prepayments: prepayments };

// Understands the filters xeroData.js uses: ContactIDs/Statuses on Invoices, and
// where=Contact.ContactID==Guid("..") [AND Status=="..."] on the credit endpoints.
function filterList(path, query, tenantId) {
  let items = (SOURCES[path] || []).filter((x) => visibleTo(tenantId, x.Contact?.ContactID));
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
  }
  return items;
}

function json(status, body) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

// A stand-in for fetch(), so the REAL Xero client (paging, retries, limiter) runs on top of it.
// It pages lists 100 at a time like Xero does, and answers only GETs on api.xro/2.0.
function createFixtureFetch() {
  return async (url, init = {}) => {
    if ((init.method || 'GET') !== 'GET') return json(405, { error: 'Fixtures answer GET only' });
    const u = new URL(url);
    const path = u.pathname.replace('/api.xro/2.0/', '');
    const query = u.searchParams;
    const tenantId = init.headers?.['Xero-tenant-id'];

    if (path.startsWith('Contacts/')) {
      const id = path.slice('Contacts/'.length);
      const found = contacts.filter((c) => c.ContactID === id && visibleTo(tenantId, c.ContactID));
      return found.length ? json(200, { Contacts: found }) : json(404, { Title: 'Not found' });
    }
    if (path === 'Contacts') {
      const wanted = String(query.get('IDs') || '').split(',');
      return json(200, { Contacts: contacts.filter((c) => wanted.includes(c.ContactID) && visibleTo(tenantId, c.ContactID)) });
    }
    if (path === 'Organisation') return json(200, { Organisations: [{ BaseCurrency: 'AUD', Name: 'Fixture Organisation', ShortCode: '!fixture' }] });
    if (SOURCES[path]) {
      const all = filterList(path, query, tenantId);
      const page = Number(query.get('page') || 1);
      return json(200, { [path]: all.slice((page - 1) * 100, page * 100) });
    }
    return json(404, { Title: `No fixture for ${path}` });
  };
}

module.exports = { createFixtureFetch, ids };
