'use strict';

// The customer list behind Auto Statements, as a pure function of Xero data: one bucket per
// contact per currency, with credits netted off so the list, the KPI tiles, the send modal and
// the statement PDF all agree on what a customer owes.
//   theyOwe       open invoices minus remaining credits (credit notes, overpayments, prepayments)
//   overdueAmount overdue invoices, but never more than theyOwe
//   daysOverdue   days past the oldest overdue invoice's due date
// A bucket whose credits cover everything owed is left out: there is nothing to send.

const { daysBetween } = require('./statementModel');

function buildCustomerBuckets({ invoices, credits, emailByContactId, today, baseCurrency = 'AUD' }) {
  const buckets = new Map();
  const currencyOf = (x) => String(x.currency || baseCurrency).toUpperCase();

  for (const inv of invoices) {
    if (inv.type !== 'ACCREC' || !inv.contactId || inv.amountDue <= 0) continue;
    const currencyCode = currencyOf(inv);
    const bucketKey = `${inv.contactId}_${currencyCode}`;
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {
        bucketKey,
        contactId: inv.contactId,
        contactName: inv.contactName || inv.contactId,
        currencyCode,
        owed: 0,
        credit: 0,
        overdue: 0,
        daysOverdue: 0,
      });
    }
    const b = buckets.get(bucketKey);
    b.owed += inv.amountDue;
    const late = inv.dueDate ? Math.max(0, daysBetween(inv.dueDate, today)) : 0;
    if (late > 0) b.overdue += inv.amountDue;
    if (late > b.daysOverdue) b.daysOverdue = late;
  }

  for (const c of credits) {
    const b = buckets.get(`${c.contactId}_${currencyOf(c)}`);
    if (b && c.remaining > 0) b.credit += c.remaining;
  }

  const customers = [];
  for (const b of buckets.values()) {
    const net = b.owed - b.credit;
    if (net <= 0) continue;
    customers.push({
      bucketKey: b.bucketKey,
      contactId: b.contactId,
      contactName: b.contactName,
      currencyCode: b.currencyCode,
      hasEmail: Boolean(emailByContactId[b.contactId]),
      theyOwe: net / 100,
      overdueAmount: Math.min(b.overdue, net) / 100,
      daysOverdue: b.daysOverdue,
    });
  }
  return customers;
}

module.exports = { buildCustomerBuckets };
