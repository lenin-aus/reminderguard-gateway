const tokenManager = require('./tokenManager');
const fetch = require('node-fetch');
const { getOrFetchBaseCurrency, getTenantTodayDateString } = require('./shared');

function parseXeroDate(dateVal) {
  if (!dateVal) return null;
  if (typeof dateVal === 'string' && dateVal.startsWith('/Date(')) {
    const ms = parseInt(dateVal.replace('/Date(', '').replace(/[^0-9]/g, ''));
    return new Date(ms);
  }
  const d = new Date(dateVal);
  return isNaN(d.getTime()) ? null : d;
}

async function xeroGet(url, accessToken, tenantId) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Xero-tenant-id': tenantId, Accept: 'application/json' }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Xero request failed: ${JSON.stringify(data)}`);
  return data;
}

// Returns an array of bucket objects — { bucketKey, contactId, currencyCode,
// hasEmail, totalOutstanding } — for a client matching the given
// recipient_filter value, pre-filtered to hasEmail === true && totalDue > 0
// before scheduled selection. This is an optimization only; the actual
// duplicate-prevention mechanism is the worker's atomic SET NX lock.
// recipientFilter: 'active' | 'outstanding' | 'outstanding_or_credits' | 'overdue'
async function getFilteredContacts(clientId, recipientFilter) {
  const { accessToken, tenantId } = await tokenManager.getValidToken(clientId);
  const baseCurrency = await getOrFetchBaseCurrency(clientId);

  const invoicesData = await xeroGet(
    'https://api.xero.com/api.xro/2.0/Invoices?Statuses=AUTHORISED&summaryOnly=false',
    accessToken, tenantId
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ninetyDaysAgo = new Date(today);
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const buckets = {};
  for (const inv of invoicesData.Invoices || []) {
    if (inv.Type !== 'ACCREC') continue;
    const contact = inv.Contact || {};
    const contactId = contact.ContactID;
    if (!contactId) continue;

    const amountDue = parseFloat(inv.AmountDue) || 0;
    const amountCredited = parseFloat(inv.AmountCredited) || 0;

    const invoiceCurrency = (inv.CurrencyCode || baseCurrency || 'AUD').toUpperCase();
    const bucketKey = `${contactId}_${invoiceCurrency}`;

    if (!buckets[bucketKey]) {
      buckets[bucketKey] = {
        bucketKey,
        contactId,
        currencyCode: invoiceCurrency,
        hasEmail: false,
        totalOutstanding: 0,
        totalCredited: 0,
        totalOverdue: 0,
        latestInvoiceDate: null
      };
    }
    const bucket = buckets[bucketKey];

    const invoiceDate = parseXeroDate(inv.DateString || inv.Date);
    const dueDate = parseXeroDate(inv.DueDateString || inv.DueDate);
    const isOverdue = dueDate ? dueDate.getTime() < today.getTime() : false;

    bucket.totalOutstanding += amountDue;
    bucket.totalCredited += amountCredited;
    if (isOverdue) bucket.totalOverdue += amountDue;
    if (invoiceDate && (!bucket.latestInvoiceDate || invoiceDate > bucket.latestInvoiceDate)) {
      bucket.latestInvoiceDate = invoiceDate;
    }
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

  // Dedupe contactIds before batching /Contacts?IDs=... — a customer can
  // appear as multiple bucketKeys (one per currency) but should only be
  // looked up once.
  const uniqueContactIds = [...new Set(matched.map((b) => b.contactId))];
  const emailByContactId = {};

  const CHUNK_SIZE = 30;
  for (let i = 0; i < uniqueContactIds.length; i += CHUNK_SIZE) {
    const chunk = uniqueContactIds.slice(i, i + CHUNK_SIZE);
    try {
      const contactsData = await xeroGet(
        `https://api.xero.com/api.xro/2.0/Contacts?IDs=${chunk.join(',')}`,
        accessToken, tenantId
      );
      for (const c of contactsData.Contacts || []) {
        emailByContactId[c.ContactID] = (c.EmailAddress || '').trim().length > 0;
      }
    } catch (e) {
      // Leave this chunk's contacts as hasEmail: false (default) on failure.
    }
  }

  for (const bucket of matched) {
    bucket.hasEmail = emailByContactId[bucket.contactId] || false;
  }

  // Pre-filter: only buckets with a valid email and a genuine positive
  // balance are worth scheduling. Optimization only — the worker's own
  // terminal-skip checks and atomic lock remain the real safety net.
  return matched.filter((b) => b.hasEmail && b.totalOutstanding > 0);
}

module.exports = { getFilteredContacts };
