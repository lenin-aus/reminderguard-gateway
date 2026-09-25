const { getXeroContext } = require('./xeroContext');
const { getXeroData } = require('./xeroData');
const { getOrFetchBaseCurrency, getTenantTodayDateString } = require('./shared');
const { daysBetween } = require('./statementModel');

// Returns an array of bucket objects — { bucketKey, contactId, currencyCode,
// hasEmail, totalOutstanding } — for a client matching the given
// recipient_filter value, pre-filtered to hasEmail === true && totalDue > 0
// before scheduled selection. This is an optimization only; the actual
// duplicate-prevention mechanism is the worker's atomic SET NX lock.
// recipientFilter: 'active' | 'outstanding' | 'outstanding_or_credits' | 'overdue'
//
// Xero is read through the shared data layer (paged, rate-limited). totalOutstanding is net of
// credit notes, overpayments and prepayments, matching the statement itself, so a customer whose
// credits cover what they owe is not selected. Amounts here are dollars.
async function getFilteredContacts(clientId, recipientFilter, timeZone = 'Australia/Melbourne') {
  const data = getXeroData();
  const ctx = await getXeroContext(clientId);
  const baseCurrency = await getOrFetchBaseCurrency(clientId);

  const [invoices, credits] = await Promise.all([data.listOpenInvoices(ctx), data.listOpenCredits(ctx)]);

  const today = getTenantTodayDateString(timeZone);
  const ninetyDaysAgo = daysBefore(today, 90);

  const buckets = {};
  for (const inv of invoices) {
    if (!inv.contactId) continue;
    const invoiceCurrency = (inv.currency || baseCurrency || 'AUD').toUpperCase();
    const bucketKey = `${inv.contactId}_${invoiceCurrency}`;

    if (!buckets[bucketKey]) {
      buckets[bucketKey] = {
        bucketKey,
        contactId: inv.contactId,
        currencyCode: invoiceCurrency,
        hasEmail: false,
        totalOutstanding: 0,
        totalCredited: 0,
        totalOverdue: 0,
        latestInvoiceDate: null
      };
    }
    const bucket = buckets[bucketKey];

    const isOverdue = inv.dueDate ? inv.dueDate < today : false;

    bucket.totalOutstanding += inv.amountDue / 100;
    bucket.totalCredited += inv.amountCredited / 100;
    if (isOverdue) bucket.totalOverdue += inv.amountDue / 100;
    if (inv.date && (!bucket.latestInvoiceDate || inv.date > bucket.latestInvoiceDate)) {
      bucket.latestInvoiceDate = inv.date;
    }
  }

  for (const credit of credits) {
    const bucket = buckets[`${credit.contactId}_${String(credit.currency || baseCurrency || 'AUD').toUpperCase()}`];
    if (bucket) bucket.totalOutstanding -= credit.remaining / 100;
  }

  const matched = Object.values(buckets).filter((b) => {
    switch (recipientFilter) {
      case 'active':
        return (b.latestInvoiceDate && b.latestInvoiceDate >= ninetyDaysAgo) || b.totalOutstanding > 0;
      case 'outstanding':
        return b.totalOutstanding > 0;
      case 'outstanding_or_credits':
        return b.totalOutstanding > 0 || b.totalCredited > 0;
      case 'overdue':
        return b.totalOverdue > 0;
      default:
        return false;
    }
  });

  // Dedupe contactIds before the lookup — a customer can appear as multiple
  // bucketKeys (one per currency) but should only be looked up once.
  const uniqueContactIds = [...new Set(matched.map((b) => b.contactId))];
  const emailByContactId = {};
  try {
    for (const c of await data.getContactsByIds(ctx, uniqueContactIds)) {
      emailByContactId[c.id] = c.email.length > 0;
    }
  } catch (e) {
    // Leave contacts as hasEmail: false (default) on failure.
  }

  for (const bucket of matched) {
    bucket.hasEmail = emailByContactId[bucket.contactId] || false;
  }

  // Pre-filter: only buckets with a valid email and a genuine positive
  // balance are worth scheduling. Optimization only — the worker's own
  // terminal-skip checks and atomic lock remain the real safety net.
  return matched.filter((b) => b.hasEmail && b.totalOutstanding > 0);
}

function daysBefore(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

module.exports = { getFilteredContacts };
