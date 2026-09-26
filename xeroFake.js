'use strict';

// A small in-memory Xero for tests of the sync: the parts of the accounting API the data layer uses
// (list filters, paging, IDs, If-Modified-Since on UpdatedDateUTC, by-id reads), over records you
// change with touch()/remove(). It records every call so tests can assert what was asked.
// touch(..., { bump: false }) changes a record WITHOUT moving UpdatedDateUTC, to test what a sync
// that trusts UpdatedDateUTC would miss.

const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => JSON.stringify(body) });

function createFakeXero({ start = new Date('2026-09-01T00:00:00Z') } = {}) {
  const clock = { now: new Date(start) };
  const store = { Invoices: [], CreditNotes: [], Overpayments: [], Prepayments: [], Contacts: [] };
  const idField = { Invoices: 'InvoiceID', CreditNotes: 'CreditNoteID', Overpayments: 'OverpaymentID', Prepayments: 'PrepaymentID', Contacts: 'ContactID' };
  const calls = [];
  const options = { hideFromLists: new Set(), failLists: new Set() };
  const stamp = () => clock.now.toISOString().slice(0, 19);

  const list = (name) => store[name];
  const find = (name, id) => store[name].find((r) => r[idField[name]] === id);

  function add(name, record) {
    store[name].push({ UpdatedDateUTCString: stamp(), ...record });
    return record;
  }
  function touch(name, id, patch, { bump = true } = {}) {
    const record = find(name, id);
    if (!record) throw new Error(`no ${name} ${id}`);
    Object.assign(record, patch);
    if (bump) record.UpdatedDateUTCString = stamp();
    return record;
  }
  function remove(name, id) {
    store[name] = store[name].filter((r) => r[idField[name]] !== id);
  }

  function filtered(name, query, headers) {
    let items = store[name];
    const ids = query.get('IDs');
    if (ids) items = items.filter((r) => ids.split(',').includes(r[idField[name]]));
    const contactIds = query.get('ContactIDs');
    if (contactIds) items = items.filter((r) => contactIds.split(',').includes(r.Contact?.ContactID));
    const statuses = query.get('Statuses');
    if (statuses) items = items.filter((r) => statuses.split(',').includes(r.Status));
    const where = query.get('where');
    if (where) {
      const type = /Type=="([A-Z]+)"/.exec(where);
      if (type) items = items.filter((r) => r.Type === type[1]);
      const contact = /Contact\.ContactID==Guid\("([^"]+)"\)/.exec(where);
      if (contact) items = items.filter((r) => r.Contact?.ContactID === contact[1]);
      const status = /Status=="([A-Z]+)"/.exec(where);
      if (status) items = items.filter((r) => r.Status === status[1]);
    }
    if (name === 'Contacts' && query.get('includeArchived') !== 'true' && !ids) items = items.filter((r) => r.ContactStatus !== 'ARCHIVED');
    const since = headers['If-Modified-Since'];
    if (since) items = items.filter((r) => r.UpdatedDateUTCString >= since);
    return items;
  }

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace('/api.xro/2.0/', '');
    const query = u.searchParams;
    const headers = init.headers || {};
    calls.push({ path, query: Object.fromEntries(query), since: headers['If-Modified-Since'] || null });
    const [name, id] = path.split('/');
    if (!store[name]) return json(404, { Title: `No fake for ${path}` });
    if (options.failLists.has(name) && !id) return json(404, { Title: 'gone' });
    if (id) {
      const record = find(name, id);
      return record ? json(200, { [name]: [record] }) : json(404, { Title: 'Not found' });
    }
    let items = filtered(name, query, headers);
    // A list can leave a row out (as paging over a changing list can); by-id reads still find it.
    if (!query.get('IDs')) items = items.filter((r) => !options.hideFromLists.has(r[idField[name]]));
    if (query.get('page')) {
      const page = Number(query.get('page'));
      items = items.slice((page - 1) * 100, page * 100);
    }
    return json(200, { [name]: items });
  };

  return {
    clock,
    store,
    calls,
    options,
    fetchImpl,
    add,
    touch,
    remove,
    list,
    advance: (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
      return clock.now;
    },
    guid,
  };
}

// Raw records in Xero's shape, with sensible defaults.
const rawInvoice = (n, over = {}) => ({
  InvoiceID: guid(1000 + n),
  InvoiceNumber: `INV-${n}`,
  Type: 'ACCREC',
  Status: 'AUTHORISED',
  Contact: { ContactID: guid(1), Name: 'Customer One' },
  CurrencyCode: 'AUD',
  DateString: '2026-08-01T00:00:00',
  DueDateString: '2026-08-15T00:00:00',
  Total: 100,
  AmountPaid: 0,
  AmountCredited: 0,
  AmountDue: 100,
  Payments: [],
  ...over,
});

const rawContact = (n, over = {}) => ({ ContactID: guid(n), Name: `Customer ${n}`, EmailAddress: `c${n}@example.test`, ContactStatus: 'ACTIVE', ...over });

const rawCreditNote = (n, over = {}) => ({
  CreditNoteID: guid(2000 + n),
  CreditNoteNumber: `CN-${n}`,
  Type: 'ACCRECCREDIT',
  Status: 'AUTHORISED',
  Contact: { ContactID: guid(1) },
  CurrencyCode: 'AUD',
  DateString: '2026-08-10T00:00:00',
  Total: 20,
  RemainingCredit: 20,
  Allocations: [],
  ...over,
});

module.exports = { createFakeXero, rawInvoice, rawContact, rawCreditNote, guid };
