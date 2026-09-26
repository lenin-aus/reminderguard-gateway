'use strict';

// The same interface as xeroData.js, answered from the synced copy in Postgres (xeroSync.js) instead
// of from Xero. Returns the same normalised shapes, and applies the same filters as the live reads,
// so the customer list and the statement builder cannot tell the difference:
//   - open invoices are AUTHORISED with something owing;
//   - history is AUTHORISED and PAID;
//   - credits are the posted receivable ones, "open" meaning something remaining.
// Only ctx.clientId is used: no Xero call, no token, so it works while a connection has expired.
// The budget helpers belong to the live client's limiter and are passed straight through.

const { XeroError } = require('./xeroClient');
const { SPECS } = require('./xeroSync');

const CREDIT_KINDS = ['creditNote', 'overpayment', 'prepayment'];

function createLocalData({ db, live }) {
  const invoiceSpec = SPECS.invoices;
  const contactSpec = SPECS.contacts;
  const creditSpec = SPECS.creditNote; // the three kinds share one table and column mapping

  async function invoices(clientId, where, params = []) {
    const { rows } = await db.query(
      `SELECT * FROM xero_invoices WHERE client_id = $1 ${where} ORDER BY date, number, invoice_id`,
      [clientId, ...params]
    );
    return rows.map(invoiceSpec.fromRow);
  }

  async function credits(clientId, where, params = []) {
    const { rows } = await db.query(
      `SELECT * FROM xero_credits WHERE client_id = $1 ${where} ORDER BY date, number, credit_id`,
      [clientId, ...params]
    );
    return rows.map(creditSpec.fromRow);
  }

  return {
    async getContact(ctx, contactId) {
      const { rows } = await db.query('SELECT * FROM xero_contacts WHERE client_id = $1 AND contact_id = $2', [ctx.clientId, contactId]);
      if (rows.length === 0) throw new XeroError('Xero resource not found', { code: 'XERO_NOT_FOUND', status: 404 });
      return contactSpec.fromRow(rows[0]);
    },

    getOpenInvoices: (ctx, contactId) =>
      invoices(ctx.clientId, `AND contact_id = $2 AND status = 'AUTHORISED' AND amount_due > 0`, [contactId]),

    getCredits: (ctx, contactId) => credits(ctx.clientId, 'AND contact_id = $2', [contactId]),

    getInvoiceHistory: (ctx, contactId) => invoices(ctx.clientId, 'AND contact_id = $2', [contactId]),

    async getContactsByIds(ctx, contactIds) {
      if (contactIds.length === 0) return [];
      const { rows } = await db.query('SELECT * FROM xero_contacts WHERE client_id = $1 AND contact_id = ANY($2::text[])', [ctx.clientId, contactIds]);
      return rows.map(contactSpec.fromRow);
    },

    listOpenInvoices: (ctx) => invoices(ctx.clientId, `AND status = 'AUTHORISED' AND amount_due > 0`),

    // Live "open" credits are the AUTHORISED ones with something remaining.
    listOpenCredits: (ctx) => credits(ctx.clientId, `AND status = 'AUTHORISED' AND remaining > 0`),

    assertBudget: (ctx, extraCalls) => live.assertBudget(ctx, extraCalls),
    dayRemaining: (tenantId) => live.dayRemaining(tenantId),
    addPending: (tenantId, calls) => live.addPending(tenantId, calls),
    takePending: (tenantId, calls) => live.takePending(tenantId, calls),
    getPending: (tenantId) => live.getPending(tenantId),
  };
}

module.exports = { createLocalData, CREDIT_KINDS };
