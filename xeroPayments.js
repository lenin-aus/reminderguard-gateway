'use strict';

// Payments, for the Payment Receipt automation only (xeroData.js is the statements data layer;
// this is deliberately separate, a different feature with a different cadence). Read-only, through
// the shared rate-limited client, like everything else that talks to Xero.
//
// Shape: { id, status, amount, date, invoiceId, invoiceNumber, currency, reference,
//          contactId, contactName }

const { xeroLocalDate, cents } = require('./xeroData');

const RECEIPT_PAYMENT_TYPE = 'ACCRECPAYMENT';

function normalizePayment(p) {
  return {
    id: p.PaymentID,
    status: p.Status,
    amount: cents(p.BankAmount ?? p.Amount),
    date: xeroLocalDate(p.DateString || p.Date),
    invoiceId: p.Invoice?.InvoiceID || null,
    invoiceNumber: p.Invoice?.InvoiceNumber || '',
    currency: p.Invoice?.CurrencyCode || null,
    reference: p.Invoice?.Reference || '',
    contactId: p.Invoice?.Contact?.ContactID || null,
    contactName: p.Invoice?.Contact?.Name || '',
  };
}

function createXeroPayments(client) {
  return {
    // Customer receipts only (ACCRECPAYMENT, not a bill payment), authorised, something paid, from
    // `sinceDate` ('YYYY-MM-DD') on. The caller still dedupes against payment_receipt_log — this
    // window only bounds how far back a check looks, in case the worker was down for a while.
    async getRecentReceiptPayments(ctx, sinceDate) {
      const raw = await client.getAllPages(ctx, 'Payments', {
        query: { where: `Date >= DateTime(${sinceDate.replace(/-/g, ',')})` },
        listKey: 'Payments',
      });
      return raw
        .filter((p) => p.PaymentType === RECEIPT_PAYMENT_TYPE && p.Status === 'AUTHORISED')
        .map(normalizePayment)
        .filter((p) => p.amount > 0);
    },

    // The Xero-rendered invoice PDF — the receipt attachment. Goes through the same limiter and
    // daily-quota tracking as every other Xero call.
    getInvoicePdf: (ctx, invoiceId) => client.requestBinary(ctx, `Invoices/${invoiceId}`, { accept: 'application/pdf' }),

    // AmountDue decides full vs partial; read fresh, never from the payment's own line.
    async getInvoiceAmountDue(ctx, invoiceId) {
      const data = await client.request(ctx, `Invoices/${invoiceId}`);
      return cents((data.Invoices || [])[0]?.AmountDue);
    },
  };
}

let defaultPayments = null;
function getXeroPayments() {
  if (!defaultPayments) {
    const { getXeroClient } = require('./xeroData');
    defaultPayments = createXeroPayments(getXeroClient());
  }
  return defaultPayments;
}

module.exports = { createXeroPayments, getXeroPayments, normalizePayment, RECEIPT_PAYMENT_TYPE };
