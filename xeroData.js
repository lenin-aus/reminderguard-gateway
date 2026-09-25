'use strict';

// The data-access layer for statements: every read of Xero data the statement code
// needs goes through this module, and it returns plain, normalised objects, never raw
// Xero JSON. The statement builder (which turns these into the four PDF sections)
// depends only on the shapes below, so this module can later be replaced by one that
// reads a local cache without touching the builder.
//
// Conventions
//   - Amounts are integer cents (no floating-point drift when summing).
//   - Dates are 'YYYY-MM-DD' strings in the organisation's local calendar. Xero's
//     transaction dates are date-only, so they are never converted between timezones.
//   - ctx is { clientId, tenantId, accessToken }; a cache implementation would use clientId.
//
// Shapes
//   Invoice: { id, number, type, status, contactId, contactName, currency, date, dueDate, total,
//              amountPaid, amountCredited, amountDue, updatedAt,
//              payments: [{ id, date, amount, reference }] }
//   Credit:  { kind: 'creditNote' | 'overpayment' | 'prepayment', id, contactId, number, status,
//              currency, date, total, remaining,
//              allocations: [{ date, amount, invoiceId, invoiceNumber }] }
//   Contact: { id, name, email, archived }

const { createXeroClient } = require('./xeroClient');

const cents = (value) => Math.round((Number(value) || 0) * 100);

// Xero sends dates two ways: an ISO-like local string ('2026-07-03T00:00:00', in the
// *String fields) and a legacy '/Date(ms+0000)/' whose milliseconds are that local
// date's midnight expressed as UTC. Both mean the same calendar day.
function xeroLocalDate(value) {
  if (!value) return null;
  if (typeof value === 'string' && value.startsWith('/Date(')) {
    const ms = parseInt(value.slice(6), 10);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

// UpdatedDateUTC is a true instant, unlike the date-only fields.
function xeroInstant(value) {
  if (!value) return null;
  if (typeof value === 'string' && value.startsWith('/Date(')) {
    const ms = parseInt(value.slice(6), 10);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  const d = new Date(value.endsWith('Z') ? value : `${value}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeInvoice(x) {
  return {
    id: x.InvoiceID,
    number: x.InvoiceNumber || '',
    type: x.Type,
    status: x.Status,
    contactId: x.Contact?.ContactID || null,
    contactName: x.Contact?.Name || '',
    currency: x.CurrencyCode,
    date: xeroLocalDate(x.DateString || x.Date),
    dueDate: xeroLocalDate(x.DueDateString || x.DueDate),
    total: cents(x.Total),
    amountPaid: cents(x.AmountPaid),
    amountCredited: cents(x.AmountCredited),
    amountDue: cents(x.AmountDue),
    updatedAt: xeroInstant(x.UpdatedDateUTCString || x.UpdatedDateUTC),
    payments: (x.Payments || [])
      .filter((p) => p.Status !== 'DELETED')
      .map((p) => ({
        id: p.PaymentID,
        date: xeroLocalDate(p.DateString || p.Date),
        amount: cents(p.Amount),
        reference: p.Reference || '',
      })),
  };
}

function normalizeAllocations(x) {
  return (x.Allocations || []).map((a) => ({
    date: xeroLocalDate(a.DateString || a.Date),
    amount: cents(a.Amount),
    // Xero returns only a stub of the invoice here (its number is often empty), so callers
    // that need the number look it up by id among the contact's invoices.
    invoiceId: a.Invoice?.InvoiceID || null,
    invoiceNumber: a.Invoice?.InvoiceNumber || '',
  }));
}

// Only the receivable side is a customer credit: ACCRECCREDIT credit notes and
// RECEIVE-* overpayments/prepayments. Their ACCPAY/SPEND counterparts belong to a
// supplier relationship with the same contact and are ignored.
const CREDIT_KINDS = {
  creditNote: {
    path: 'CreditNotes',
    listKey: 'CreditNotes',
    isReceivable: (x) => x.Type === 'ACCRECCREDIT',
    idField: 'CreditNoteID',
    label: (x) => x.CreditNoteNumber || 'Credit note',
  },
  overpayment: {
    path: 'Overpayments',
    listKey: 'Overpayments',
    isReceivable: (x) => x.Type === 'RECEIVE-OVERPAYMENT',
    idField: 'OverpaymentID',
    label: (x) => x.Reference || 'Overpayment',
  },
  prepayment: {
    path: 'Prepayments',
    listKey: 'Prepayments',
    isReceivable: (x) => x.Type === 'RECEIVE-PREPAYMENT',
    idField: 'PrepaymentID',
    label: (x) => x.Reference || 'Prepayment',
  },
};

// Statuses that are real ledger entries. DRAFT/SUBMITTED are not posted; VOIDED/DELETED
// are gone (Xero's own statements leave them out too).
const POSTED_CREDIT_STATUSES = new Set(['AUTHORISED', 'PAID']);

// A contact whose history needs more pages than this is logged as a warning.
const HISTORY_WARN_PAGES = 5;

function normalizeCredit(kind, x) {
  const spec = CREDIT_KINDS[kind];
  return {
    kind,
    id: x[spec.idField],
    contactId: x.Contact?.ContactID || null,
    number: spec.label(x),
    status: x.Status,
    currency: x.CurrencyCode,
    date: xeroLocalDate(x.DateString || x.Date),
    total: cents(x.Total),
    remaining: cents(x.RemainingCredit),
    allocations: normalizeAllocations(x),
  };
}

// Contact ids are interpolated into Xero 'where' filters, so they must be plain GUIDs.
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function assertGuid(id) {
  if (!GUID.test(String(id))) throw new Error(`Not a valid Xero contact id: ${id}`);
  return id;
}

function createXeroData(client) {
  async function creditsOfKind(ctx, kind, query) {
    const spec = CREDIT_KINDS[kind];
    const raw = await client.getAllPages(ctx, spec.path, { query, listKey: spec.listKey });
    return raw
      .filter((x) => spec.isReceivable(x) && POSTED_CREDIT_STATUSES.has(x.Status))
      .map((x) => normalizeCredit(kind, x));
  }

  return {
    async getContact(ctx, contactId) {
      const data = await client.request(ctx, `Contacts/${assertGuid(contactId)}`);
      const c = (data.Contacts || [])[0];
      if (!c) return null;
      return {
        id: c.ContactID,
        name: c.Name || '',
        email: (c.EmailAddress || '').trim(),
        archived: c.ContactStatus === 'ARCHIVED',
      };
    },

    // Every AUTHORISED receivable invoice with a balance, for one contact.
    async getOpenInvoices(ctx, contactId) {
      const raw = await client.getAllPages(ctx, 'Invoices', {
        query: { ContactIDs: assertGuid(contactId), Statuses: 'AUTHORISED' },
        listKey: 'Invoices',
      });
      return raw.map(normalizeInvoice).filter((i) => i.type === 'ACCREC' && i.amountDue > 0);
    },

    // All posted receivable credits of a contact, of every kind and age. The caller keeps
    // remaining > 0 for "unallocated" and uses dates for the Activity section. A contact's
    // credits are few, so one history-wide fetch per kind is cheaper and more exact than
    // several date-windowed ones.
    async getCredits(ctx, contactId) {
      const where = `Contact.ContactID==Guid("${assertGuid(contactId)}")`;
      const lists = await Promise.all(Object.keys(CREDIT_KINDS).map((kind) => creditsOfKind(ctx, kind, { where })));
      return lists.flat();
    },

    // A contact's complete receivable history (AUTHORISED and PAID), with each invoice's Payments.
    // Deliberately not narrowed with If-Modified-Since: that header filters on when a record was
    // last edited, not on payment dates, so a payment missed by it would silently corrupt the
    // opening balance and every running balance below it. Measured on a real organisation the
    // full history is small (4 invoices, 1 page, 18 KB for its largest contact); a contact
    // needing more than HISTORY_WARN_PAGES pages is logged so large clients show up early.
    async getInvoiceHistory(ctx, contactId) {
      const raw = await client.getAllPages(ctx, 'Invoices', {
        query: { ContactIDs: assertGuid(contactId), Statuses: 'AUTHORISED,PAID' },
        listKey: 'Invoices',
        warnPages: HISTORY_WARN_PAGES,
        label: `invoice history of contact ${contactId}`,
      });
      return raw.map(normalizeInvoice).filter((i) => i.type === 'ACCREC');
    },

    // Several contacts at once (the customer list needs each contact's email), in chunks so the
    // URL stays short. A contact Xero does not return is simply absent from the result.
    async getContactsByIds(ctx, contactIds, chunkSize = 30) {
      const found = [];
      for (let i = 0; i < contactIds.length; i += chunkSize) {
        const chunk = contactIds.slice(i, i + chunkSize).map(assertGuid);
        const data = await client.request(ctx, 'Contacts', { query: { IDs: chunk.join(',') } });
        for (const c of data.Contacts || []) {
          found.push({ id: c.ContactID, name: c.Name || '', email: (c.EmailAddress || '').trim(), archived: c.ContactStatus === 'ARCHIVED' });
        }
      }
      return found;
    },

    // Daily-quota bookkeeping shared with the Xero client's limiter (see xeroClient.assertBudget).
    assertBudget: (ctx, extraCalls = 0) => client.assertBudget(ctx, extraCalls),
    dayRemaining: (tenantId) => client.limiter.getDayRemaining(tenantId),
    addPending: (tenantId, calls) => client.limiter.addPending(tenantId, calls),
    takePending: (tenantId, calls) => client.limiter.takePending(tenantId, calls),
    getPending: (tenantId) => client.limiter.getPending(tenantId),

    // Organisation-wide, for the customer list and the recipient selector.
    async listOpenInvoices(ctx) {
      const raw = await client.getAllPages(ctx, 'Invoices', {
        query: { Statuses: 'AUTHORISED' },
        listKey: 'Invoices',
      });
      return raw.map(normalizeInvoice).filter((i) => i.type === 'ACCREC' && i.amountDue > 0);
    },

    async listOpenCredits(ctx) {
      const where = 'Status=="AUTHORISED"';
      const lists = await Promise.all(Object.keys(CREDIT_KINDS).map((kind) => creditsOfKind(ctx, kind, { where })));
      return lists.flat().filter((c) => c.remaining > 0);
    },
  };
}

let defaultData = null;
// The production instance, wired to Redis. Created on first use so that requiring this
// module (for tests, or by a process that never calls Xero) does not open a connection.
function getXeroData() {
  if (!defaultData) {
    const Redis = require('ioredis');
    const { createRedisLimiter } = require('./xeroLimiter');
    const redis = new Redis({
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT || 6379,
      username: process.env.REDIS_USERNAME,
      password: process.env.REDIS_PASSWORD,
    });
    // XERO_FIXTURES=1 (local dev stack only) swaps Xero for fixture data underneath the same
    // client, limiter and data layer, so the real code paths run without a Xero connection.
    const fixtures = process.env.XERO_FIXTURES === '1';
    if (fixtures) console.warn('[xero] XERO_FIXTURES=1: answering from fixture data, not from Xero');
    const fetchImpl = fixtures ? require('./xeroFixtures').createFixtureFetch() : undefined;
    defaultData = createXeroData(createXeroClient({ limiter: createRedisLimiter(redis), ...(fetchImpl ? { fetchImpl } : {}) }));
  }
  return defaultData;
}

module.exports = { createXeroData, getXeroData, xeroLocalDate, normalizeInvoice, normalizeCredit, cents, HISTORY_WARN_PAGES };
