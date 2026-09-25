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
//   Invoice: { id, number, type, status, contactId, currency, date, dueDate, total,
//              amountPaid, amountCredited, amountDue, updatedAt,
//              payments: [{ id, date, amount, reference }] }
//   Credit:  { kind: 'creditNote' | 'overpayment' | 'prepayment', id, number, status,
//              currency, date, total, remaining,
//              allocations: [{ date, amount, invoiceNumber }] }
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

function normalizeCredit(kind, x) {
  const spec = CREDIT_KINDS[kind];
  return {
    kind,
    id: x[spec.idField],
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

// Xero timestamps for If-Modified-Since are UTC, without an offset.
function toModifiedSince(utcIso) {
  return utcIso.slice(0, 19);
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

    // Receivable invoices (AUTHORISED or PAID) that changed on or after modifiedSinceUtc,
    // each with its Payments. Xero filters on UpdatedDateUTC, which is when a record was
    // last edited, not when a payment is dated: the caller must still filter every payment
    // by its own date and discard invoices that were merely edited.
    async getInvoiceActivity(ctx, contactId, { modifiedSinceUtc }) {
      const raw = await client.getAllPages(ctx, 'Invoices', {
        query: { ContactIDs: assertGuid(contactId), Statuses: 'AUTHORISED,PAID' },
        listKey: 'Invoices',
        headers: { 'If-Modified-Since': toModifiedSince(modifiedSinceUtc) },
      });
      return raw.map(normalizeInvoice).filter((i) => i.type === 'ACCREC');
    },

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
    defaultData = createXeroData(createXeroClient({ limiter: createRedisLimiter(redis) }));
  }
  return defaultData;
}

module.exports = { createXeroData, getXeroData, xeroLocalDate, normalizeInvoice, normalizeCredit, cents };
