const tokenManager = require('./tokenManager');
const fetch = require('node-fetch');

function parseXeroDate(dateVal) {
  if (!dateVal) return null;
  if (typeof dateVal === 'string' && dateVal.startsWith('/Date(')) {
    const ms = parseInt(dateVal.replace('/Date(', '').replace(/[^0-9]/g, ''));
    return new Date(ms);
  }
  const d = new Date(dateVal);
  return isNaN(d.getTime()) ? null : d;
}

function daysDiff(date, today) {
  if (!date) return 0;
  return Math.floor((today - date) / (1000 * 60 * 60 * 24));
}

async function xeroGet(url, accessToken, tenantId) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Xero-tenant-id': tenantId, Accept: 'application/json' }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Xero request failed: ${JSON.stringify(data)}`);
  return data;
}

// Returns contactIds[] for a client matching the given recipient_filter value.
// recipientFilter: 'active' | 'outstanding' | 'outstanding_or_credits' | 'overdue'
async function getFilteredContacts(clientId, recipientFilter) {
  const { accessToken, tenantId } = await tokenManager.getValidToken(clientId);

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

    if (!buckets[contactId]) {
      buckets[contactId] = {
        ContactID: contactId,
        totalOutstanding: 0,
        totalCredited: 0,
        totalOverdue: 0,
        latestInvoiceDate: null
      };
    }
    const bucket = buckets[contactId];

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

  return matched.map((b) => b.ContactID);
}

module.exports = { getFilteredContacts };
