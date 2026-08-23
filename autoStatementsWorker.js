const { Worker } = require('bullmq');
const FormData = require('form-data');
const Redis = require('ioredis');
const pool = require('./db');
const tokenManager = require('./tokenManager');
const fetch = require('node-fetch');

const GOTENBERG_URL = process.env.GOTENBERG_URL || 'http://gotenberg:3000';
const BREVO_API_KEY = process.env.BREVO_API_KEY;

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT || 6379,
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD
});

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

function getToneTier(daysOverdue) {
  if (daysOverdue <= 0) return 'CURRENT';
  if (daysOverdue <= 30) return 'GENTLE';
  if (daysOverdue <= 60) return 'FIRM';
  if (daysOverdue <= 90) return 'URGENT';
  return 'CRITICAL';
}

// NFD-normalize + strip diacritics + replace invalid filename chars, falling
// back to contactId if the result is empty (e.g. all-symbol contact names).
function sanitizeForFilename(name, contactId) {
  const cleaned = (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || contactId;
}

// Currency-aware, crash-safe formatter. Uppercases/trims the code before
// attempting Intl.NumberFormat; on failure (malformed/invalid code), falls
// back to "CODE amount" rather than silently mislabeling as AUD.
function fmt(amount, currencyCode) {
  const cleanCode = (currencyCode || 'AUD').toString().trim().toUpperCase();
  try {
    return new Intl.NumberFormat('en-AU', { style: 'currency', currency: cleanCode }).format(amount);
  } catch (e) {
    return `${cleanCode} ${Number(amount).toFixed(2)}`;
  }
}

function buildStatementHtml(contact, clientName, overdueOnly, currencyCode) {
  const invoicesToShow = overdueOnly
    ? contact.Invoices.filter(inv => inv.DaysOverdue > 0)
    : contact.Invoices;
  const totalToShow = invoicesToShow.reduce((sum, inv) => sum + (inv.AmountDue || 0), 0);
  const totalLabel = overdueOnly ? 'Total Overdue' : 'Total Outstanding';

  const buckets = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 };
  invoicesToShow.forEach(inv => {
    const d = inv.DaysOverdue || 0;
    const amt = inv.AmountDue || 0;
    if (d === 0) buckets.current += amt;
    else if (d <= 30) buckets.d30 += amt;
    else if (d <= 60) buckets.d60 += amt;
    else if (d <= 90) buckets.d90 += amt;
    else buckets.d90plus += amt;
  });

  const invoiceRows = invoicesToShow.map(inv => {
    const isOverdue = inv.Status === 'OVERDUE';
    const rowBg = isOverdue ? '#fff5f5' : '#ffffff';
    const dueDateColor = isOverdue ? '#cc0000' : '#333333';
    const statusBadge = isOverdue
      ? `<span style="color:#cc0000;font-weight:bold;">${inv.DaysOverdue}d overdue</span>`
      : '<span style="color:#2e7d32;">Current</span>';
    const daysCell = isOverdue
      ? `<td style="padding:10px 12px;text-align:center;color:#cc0000;font-weight:bold;">${inv.DaysOverdue}</td>`
      : `<td style="padding:10px 12px;text-align:center;color:#2e7d32;">—</td>`;
    return `<tr style="background:${rowBg};border-bottom:1px solid #e0e0e0;">
      <td style="padding:10px 12px;">${inv.InvoiceNumber}</td>
      <td style="padding:10px 12px;">${inv.InvoiceDate || '&mdash;'}</td>
      <td style="padding:10px 12px;color:${dueDateColor};">${inv.DueDate || '&mdash;'}</td>
      <td style="padding:10px 12px;text-align:right;">${fmt(inv.AmountDue, currencyCode)}</td>
      ${daysCell}
      <td style="padding:10px 12px;text-align:center;">${statusBadge}</td>
    </tr>`;
  }).join('');

  const agingTable = `<div style="margin-top:20px;"><table style="width:100%;border-collapse:collapse;font-size:12px;">
    <thead><tr style="background:#f1f5f9;">
      <th style="padding:8px 12px;text-align:right;font-weight:600;color:#555;border:1px solid #e0e0e0;">Current</th>
      <th style="padding:8px 12px;text-align:right;font-weight:600;color:#555;border:1px solid #e0e0e0;">1–30 Days</th>
      <th style="padding:8px 12px;text-align:right;font-weight:600;color:#555;border:1px solid #e0e0e0;">31–60 Days</th>
      <th style="padding:8px 12px;text-align:right;font-weight:600;color:#92400e;border:1px solid #e0e0e0;">61–90 Days</th>
      <th style="padding:8px 12px;text-align:right;font-weight:600;color:#cc0000;border:1px solid #e0e0e0;">90+ Days</th>
      <th style="padding:8px 12px;text-align:right;font-weight:600;color:#1a56db;border:1px solid #e0e0e0;">Total</th>
    </tr></thead>
    <tbody><tr>
      <td style="padding:10px 12px;text-align:right;border:1px solid #e0e0e0;">${fmt(buckets.current, currencyCode)}</td>
      <td style="padding:10px 12px;text-align:right;border:1px solid #e0e0e0;">${fmt(buckets.d30, currencyCode)}</td>
      <td style="padding:10px 12px;text-align:right;border:1px solid #e0e0e0;">${fmt(buckets.d60, currencyCode)}</td>
      <td style="padding:10px 12px;text-align:right;background:#fffbeb;border:1px solid #e0e0e0;">${fmt(buckets.d90, currencyCode)}</td>
      <td style="padding:10px 12px;text-align:right;background:#fee2e2;font-weight:bold;border:1px solid #e0e0e0;">${fmt(buckets.d90plus, currencyCode)}</td>
      <td style="padding:10px 12px;text-align:right;font-weight:bold;color:#1a56db;border:1px solid #e0e0e0;">${fmt(totalToShow, currencyCode)}</td>
    </tr></tbody>
  </table></div>`;

  const paymentHistory = contact.PaymentPerformanceLabel
    ? `<div style="margin-top:16px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;font-size:12px;color:#555;"><strong style="color:#374151;">Payment History:</strong> ${contact.PaymentPerformanceLabel}</div>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
body{font-family:Arial,sans-serif;color:#333;margin:0;padding:0;}
.wrap{max-width:750px;margin:0 auto;padding:40px 30px;}
.hdr{border-bottom:3px solid #1a56db;padding-bottom:20px;margin-bottom:30px;}
.co{font-size:22px;font-weight:bold;color:#1a56db;}
.ttl{font-size:16px;color:#555;margin-top:4px;}
.meta{display:flex;justify-content:space-between;margin-bottom:30px;flex-wrap:wrap;gap:16px;}
.mb{font-size:13px;line-height:1.8;}
.mb strong{display:block;font-size:11px;text-transform:uppercase;color:#888;margin-bottom:2px;}
table{width:100%;border-collapse:collapse;font-size:13px;}
thead tr{background:#1a56db;color:white;}
thead th{padding:10px 12px;text-align:left;font-weight:600;}
.sum{margin-top:30px;text-align:right;}
.sbox{display:inline-block;background:#f0f4ff;border:1px solid #1a56db;border-radius:6px;padding:16px 24px;}
.slbl{font-size:12px;color:#555;text-transform:uppercase;}
.samt{font-size:24px;font-weight:bold;color:#1a56db;margin-top:4px;}
.ftr{margin-top:40px;padding-top:20px;border-top:1px solid #e0e0e0;font-size:11px;color:#999;text-align:center;}
</style></head><body><div class="wrap">
<div class="hdr"><div class="co">${clientName}</div><div class="ttl">Statement of Account</div></div>
<div class="meta">
  <div class="mb"><strong>Prepared By</strong>${clientName}</div>
  <div class="mb"><strong>Statement Date</strong>${contact.StatementDate}</div>
  <div class="mb"><strong>Account</strong>${contact.ContactName}</div>
  <div class="mb"><strong>Invoices Outstanding</strong>${invoicesToShow.length}</div>
</div>
<table><thead><tr>
  <th>Invoice #</th><th>Invoice Date</th><th>Due Date</th>
  <th style="text-align:right;">Amount Due</th>
  <th style="text-align:center;">Days Overdue</th>
  <th style="text-align:center;">Status</th>
</tr></thead><tbody>${invoiceRows}</tbody></table>
<div class="sum"><div class="sbox">
  <div class="slbl">${totalLabel}</div>
  <div class="samt">${fmt(totalToShow, currencyCode)}</div>
</div></div>
${agingTable}
${paymentHistory}
<div class="ftr">Statement generated automatically on ${contact.StatementDate}.<br>
Please contact us if you have any questions regarding your account.</div>
</div></body></html>`;
}

async function xeroGet(url, accessToken, tenantId) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Xero-tenant-id': tenantId, Accept: 'application/json' }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Xero request failed: ${JSON.stringify(data)}`);
  return data;
}

// Fetches all pages of AUTHORISED invoices for a tenant, accumulating until
// a page returns fewer than 100 results (Xero's unpaginated cap).
async function fetchAllInvoices(accessToken, tenantId) {
  let page = 1;
  let allInvoices = [];
  while (true) {
    const data = await xeroGet(
      `https://api.xero.com/api.xro/2.0/Invoices?Statuses=AUTHORISED&summaryOnly=false&page=${page}`,
      accessToken, tenantId
    );
    const pageInvoices = data.Invoices || [];
    allInvoices = allInvoices.concat(pageInvoices);
    if (pageInvoices.length < 100) break;
    page++;
  }
  return allInvoices;
}

async function updateStatementLog(logId, status, errorMessage, errorReason) {
  await pool.query(
    `UPDATE statement_logs
     SET status = $1, error_message = $2, error_reason = $3
     WHERE id = $4`,
    [status, errorMessage || null, errorReason || null, logId]
  );
}

const worker = new Worker('auto-statements', async (job) => {
  const { clientId, bucketKey, currencyCode, contactId, baseCurrency, todayDateString, logId } = job.data;

  console.log('[Worker] Job started for client', clientId, 'bucketKey:', bucketKey);

  const lockKey = `sent-statement:${clientId}:${bucketKey}:${todayDateString}`;
  const lockAcquired = await redis.set(lockKey, `PROCESSING:${job.id}`, 'NX', 'EX', 86400);

  if (!lockAcquired) {
    const currentVal = await redis.get(lockKey);
    if (currentVal === '1') {
      console.log(`[Worker] Skipped ${bucketKey} — already sent today`);
      return { status: 'SKIPPED_ALREADY_SENT' };
    }
    if (currentVal === `PROCESSING:${job.id}`) {
      // Stale lock from this same job's own earlier failed attempt — reclaim it.
    } else {
      const err = new Error(`LOCK_COLLISION: ${bucketKey} is locked by another active run.`);
      throw err;
    }
  }

  let emailSent = false;

  try {
    const { accessToken, tenantId } = await tokenManager.getValidToken(clientId);

    const configRes = await pool.query('SELECT * FROM client_config WHERE id = $1', [clientId]);
    const clientConfig = configRes.rows[0] || {};
    const clientName = clientConfig.client_name || 'Your Supplier';
    const overdueOnly = clientConfig.overdue_only === true;
    const senderEmail = clientConfig.sender_email;
    const senderName = clientConfig.sender_name || clientName;

    const allInvoices = await fetchAllInvoices(accessToken, tenantId);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let contactName = contactId;
    let totalOutstanding = 0;
    let invoiceList = [];

    for (const inv of allInvoices) {
      if (inv.Type !== 'ACCREC') continue;
      const invContact = inv.Contact || {};
      if (invContact.ContactID !== contactId) continue;

      const amountDue = parseFloat(inv.AmountDue) || 0;
      if (amountDue <= 0) continue;

      const invoiceCurrency = (inv.CurrencyCode || baseCurrency || 'AUD').toUpperCase();
      if (invoiceCurrency !== currencyCode.toUpperCase()) continue;

      contactName = invContact.Name || contactId;
      const invoiceDate = parseXeroDate(inv.DateString || inv.Date);
      const dueDate = parseXeroDate(inv.DueDateString || inv.DueDate);
      const daysOverdue = dueDate ? Math.max(0, daysDiff(dueDate, today)) : 0;

      invoiceList.push({
        InvoiceNumber: inv.InvoiceNumber || 'N/A',
        InvoiceDate: invoiceDate ? invoiceDate.toISOString().split('T')[0] : null,
        DueDate: dueDate ? dueDate.toISOString().split('T')[0] : null,
        DaysOverdue: daysOverdue,
        AmountDue: amountDue,
        Status: daysOverdue > 0 ? 'OVERDUE' : 'CURRENT'
      });
      totalOutstanding += amountDue;
    }

    // Zero-balance race: customer may have paid between enqueue and execution.
    if (totalOutstanding <= 0) {
      console.log(`[Worker] Skipping ${bucketKey} — no remaining balance due`);
      await updateStatementLog(logId, 'FAILED', 'No remaining balance due at execution time', 'ZERO_BALANCE');
      await redis.del(lockKey);
      return { status: 'SKIPPED_ZERO_BALANCE' };
    }

    // Fresh contact lookup — email always sourced here, never from the
    // enqueue-time payload, in case the customer's email changed in Xero.
    let contactData;
    try {
      contactData = await xeroGet(
        `https://api.xero.com/api.xro/2.0/Contacts/${contactId}`,
        accessToken, tenantId
      );
    } catch (e) {
      console.log(`[Worker] Terminal skip — contact ${contactId} missing/archived`);
      await updateStatementLog(logId, 'FAILED', e.message, 'CONTACT_NOT_FOUND');
      await redis.del(lockKey);
      return { status: 'SKIPPED_CONTACT_NOT_FOUND' };
    }

    const xeroContact = (contactData.Contacts || [])[0];
    const email = (xeroContact?.EmailAddress || '').trim();

    if (!xeroContact || !email) {
      console.log(`[Worker] Terminal skip — no valid email for ${bucketKey}`);
      await updateStatementLog(logId, 'FAILED', 'No valid email address on file in Xero', 'MISSING_EMAIL');
      await redis.del(lockKey);
      return { status: 'SKIPPED_NO_VALID_EMAIL' };
    }

    const contact = {
      ContactID: contactId,
      ContactName: contactName,
      StatementDate: todayDateString,
      Invoices: invoiceList
    };
    contact.OldestDaysOverdue = invoiceList.reduce((max, inv) => Math.max(max, inv.DaysOverdue), 0);
    contact.ToneTier = getToneTier(contact.OldestDaysOverdue);

    // Payment history lookup — same as before, non-fatal on failure.
    let performanceLabel = '';
    try {
      const paidData = await xeroGet(
        `https://api.xero.com/api.xro/2.0/Invoices?ContactIDs=${contactId}&Statuses=PAID`,
        accessToken, tenantId
      );
      const paidInvoices = (paidData.Invoices || []).filter(inv => inv.Type === 'ACCREC');
      if (paidInvoices.length > 0) {
        let totalDaysLate = 0, validCount = 0;
        for (const inv of paidInvoices) {
          const dueDateStr = inv.DueDateString || inv.DueDate;
          if (!dueDateStr) continue;
          let paidDateStr = inv.FullyPaidOnDate;
          if (!paidDateStr && inv.Payments?.length) paidDateStr = inv.Payments.at(-1).Date || inv.Payments.at(-1).DateString;
          if (!paidDateStr && inv.CreditNotes?.length) paidDateStr = inv.CreditNotes.at(-1).DateString || inv.CreditNotes.at(-1).Date;
          if (!paidDateStr) continue;
          const due = parseXeroDate(dueDateStr), paid = parseXeroDate(paidDateStr);
          if (!due || !paid) continue;
          due.setHours(0, 0, 0, 0); paid.setHours(0, 0, 0, 0);
          totalDaysLate += Math.floor((paid - due) / 86400000);
          validCount++;
        }
        if (validCount > 0) {
          const avgDaysLate = Math.round(totalDaysLate / validCount);
          performanceLabel = avgDaysLate < 0
            ? `Pays ${Math.abs(avgDaysLate)} days early on average (${validCount} invoices)`
            : avgDaysLate === 0
              ? `Pays on time on average (${validCount} invoices)`
              : `Pays ${avgDaysLate} days late on average (${validCount} invoices)`;
        }
      }
    } catch (e) {
      // Non-fatal — statement still sends without payment history.
    }
    contact.PaymentPerformanceLabel = performanceLabel;

    const html = buildStatementHtml(contact, clientName, overdueOnly, currencyCode);

    const form = new FormData();
    form.append('index.html', Buffer.from(html, 'utf-8'), { filename: 'index.html', contentType: 'text/html' });
    const pdfRes = await fetch(`${GOTENBERG_URL}/forms/chromium/convert/html`, {
      method: 'POST', body: form, headers: form.getHeaders()
    });
    if (!pdfRes.ok) {
      const err = new Error(`Gotenberg failed: ${pdfRes.status}`);
      await updateStatementLog(logId, 'FAILED', err.message, 'PDF_GEN_FAILED');
      await redis.del(lockKey);
      throw err;
    }
    const pdfBase64 = Buffer.from(await pdfRes.arrayBuffer()).toString('base64');
    const sanitizedName = sanitizeForFilename(contact.ContactName, contactId);

    const totalDueRaw = parseFloat(totalOutstanding.toFixed(2));
    const formattedTotalDue = fmt(totalDueRaw, currencyCode);

    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: [{ email }],
        subject: `Statement of Account — ${contact.ContactName} — ${todayDateString}`,
        htmlContent: '<p>Please find your statement attached.</p>',
        params: {
          contactName: contact.ContactName,
          currencyCode: currencyCode.toUpperCase(),
          totalDueRaw,
          formattedTotalDue,
          statementDate: todayDateString,
          invoices: invoiceList.map((inv) => ({
            ...inv,
            rawAmountDue: inv.AmountDue,
            formattedAmountDue: fmt(inv.AmountDue, currencyCode)
          }))
        },
        attachment: [{ content: pdfBase64, name: `Statement-${sanitizedName}-${currencyCode}.pdf` }]
      })
    });

    if (!brevoRes.ok) {
      const errBody = await brevoRes.text();
      const err = new Error(`Brevo send failed: ${brevoRes.status} - ${errBody}`);
      throw err;
    }

    emailSent = true;

    try {
      await redis.set(lockKey, '1', 'KEEPTTL');
      await updateStatementLog(logId, 'DELIVERED', null, null);
    } catch (postSendErr) {
      console.error('[Worker] Post-send finalization failed, swallowing to prevent duplicate email retry', postSendErr);
    }

    console.log(`[Worker] Sent statement for ${bucketKey} to ${email}`);
    return { status: 'SUCCESS' };
  } catch (err) {
    console.error(`[Worker] Failed for ${bucketKey}:`, err.message);

    if (emailSent) {
      // Email already went out — never retry, regardless of what failed after.
      return { status: 'SUCCESS_WITH_POST_PROCESSING_WARNING', error: err.message };
    }

    if (err.message && err.message.startsWith('LOCK_COLLISION')) {
      throw err;
    }

    const currentLock = await redis.get(lockKey);
    if (currentLock === `PROCESSING:${job.id}`) {
      await redis.del(lockKey);
    }

    await updateStatementLog(logId, 'FAILED', err.message, 'API_ERROR').catch(() => {});
    throw err;
  }
}, {
  connection: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT || 6379,
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD
  },
  limiter: { max: 20, duration: 60000 },
  concurrency: 2,
 settings: {
    backoffStrategy: (attemptsMade, err) => {
      return err && err.message && err.message.startsWith('LOCK_COLLISION') ? 60000 : 5000;
    }
  }
});

worker.on('failed', (job, err) => {
  console.error('[Worker] Job FAILED:', job?.id, err?.message, err?.stack);
});
worker.on('error', (err) => {
  console.error('[Worker] Worker-level ERROR:', err?.message, err?.stack);
});

module.exports = worker;
