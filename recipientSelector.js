const tokenManager = require('./tokenManager');
const { getValidXeroToken } = require('./tokenManager');
const fetch = require('node-fetch');
const axios = require('axios');
const { pool } = require('./db');
const autoStatementsQueue = require('./autoStatementsQueue');
const config = require('./config');
const Redis = require('ioredis');

const redis = new Redis(config.redisConnectionString);

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

function getTenantTodayDateString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

async function runAutomatedBatching(clientId) {
    try {
        const token = await getValidXeroToken(clientId);
        const { rows: configRows } = await pool.query('SELECT xero_tenant_id FROM client_config WHERE id = $1', [clientId]);
        const tenantId = configRows[0].xero_tenant_id;
        
        const todayDateString = getTenantTodayDateString();

        const invoicesRes = await axios.get('https://api.xero.com/api.xro/2.0/Invoices?Statuses=AUTHORISED&Type=ACCREC', {
            headers: { 'Authorization': `Bearer ${token}`, 'xero-tenant-id': tenantId, 'Accept': 'application/json' }
        });

        const buckets = {};
        for (const inv of invoicesRes.data.Invoices || []) {
            if (inv.AmountDue <= 0) continue;
            const contactId = inv.Contact.ContactID;
            const currency = inv.CurrencyCode;
            const bucketKey = config.BUCKET_KEY_FORMAT(contactId, currency);
            
            if (!buckets[bucketKey]) buckets[bucketKey] = { contactId, currency, totalDue: 0, bucketKey };
            buckets[bucketKey].totalDue += inv.AmountDue;
        }

        const contactIds = [...new Set(Object.values(buckets).map(b => b.contactId))];
        const contactEmailMap = {};
        
        for (let i = 0; i < contactIds.length; i += 30) {
            const batch = contactIds.slice(i, i + 30);
            const contactsRes = await axios.get(`https://api.xero.com/api.xro/2.0/Contacts?IDs=${batch.join(',')}`, {
                headers: { 'Authorization': `Bearer ${token}`, 'xero-tenant-id': tenantId, 'Accept': 'application/json' }
            });
            for (const contact of contactsRes.data.Contacts) {
                contactEmailMap[contact.ContactID] = !!contact.EmailAddress;
            }
        }

        // Filter contacts by hasEmail === true and totalDue > 0
        const validBuckets = Object.values(buckets).filter(b => 
            contactEmailMap[b.contactId] === true && b.totalDue > 0
        );

        if (validBuckets.length === 0) return;

        const mgetKeys = validBuckets.map(b => `sent-statement:${clientId}:${b.bucketKey}:${todayDateString}`);
        const existingLocks = await redis.mget(mgetKeys);
        
        const keysToProcess = validBuckets.filter((_, idx) => !existingLocks[idx]);

        if (keysToProcess.length === 0) return;

        const jobsToAdd = [];
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const bucket of keysToProcess) {
                // Mirror the POST route's PROCESSING-row batch insertion into Postgres to generate log_id values
                const { rows } = await client.query(`
                    INSERT INTO statement_logs 
                    (client_id, contact_id, bucket_key, currency_code, trigger_type, status) 
                    VALUES ($1, $2, $3, $4, 'AUTOMATIC', 'PROCESSING') 
                    RETURNING id
                `, [clientId, bucket.contactId, bucket.bucketKey, bucket.currency]);
                
                const logId = rows[0].id;
                jobsToAdd.push({
                    name: `statement_${bucket.bucketKey}`,
                    data: { clientId, bucketKey: bucket.bucketKey, logId, triggerType: 'AUTOMATIC' },
                    opts: { jobId: `auto_${logId}_${bucket.bucketKey}`, backoff: { type: 'lockCollisionDelay' }, attempts: 5 }
                });
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        // Call autoStatementsQueue.addBulk()
        if (jobsToAdd.length > 0) {
            await autoStatementsQueue.addBulk(jobsToAdd);
        }

    } catch (error) {
        console.error('Error in automated batching:', error);
    }
}

module.exports = {
  parseXeroDate,
  daysDiff,
  getTenantTodayDateString,
  xeroGet,
  getFilteredContacts,
  runAutomatedBatching
};
