const { Worker } = require('bullmq');
const FormData = require('form-data');
const pool = require('./db');
const tokenManager = require('./tokenManager');
const fetch = require('node-fetch');

const GOTENBERG_URL = process.env.GOTENBERG_URL || 'http://gotenberg:3000';
const BREVO_API_KEY = process.env.BREVO_API_KEY;

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

function buildStatementHtml(contact, clientName, overdueOnly) {
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
  const fmt = n => '$' + n.toFixed(2);

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
      <td style="padding:10px 12px;text-align:right;">$${inv.AmountDue.toFixed(2)}</td>
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
      <td style="padding:10px 12px;text-align:right;border:1px solid #e0e0e0;">${fmt(buckets.current)}</td>
      <td style="padding:10px 12px;text-align:right;border:1px solid #e0e0e0;">${fmt(buckets.d30)}</td>
      <td style="padding:10px 12px;text-align:right;border:1px solid #e0e0e0;">${fmt(buckets.d60)}</td>
      <td style="padding:10px 12px;text-align:right;background:#fffbeb;border:1px solid #e0e0e0;">${fmt(buckets.d90)}</td>
      <td style="padding:10px 12px;text-align:right;background:#fee2e2;font-weight:bold;border:1px solid #e0e0e0;">${fmt(buckets.d90plus)}</td>
      <td style="padding:10px 12px;text-align:right;font-weight:bold;color:#1a56db;border:1px solid #e0e0e0;">${fmt(totalToShow)}</td>
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
  <div class="samt">$${totalToShow.toFixed(2)} AUD</div>
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

const worker = new Worker('auto-statements', async (job) => {
  const { clientId, contactIds: selectedContactIds } = job.data;

  console.log('[Worker] Job started for client', clientId, 'contacts:', selectedContactIds);

  const { accessToken, tenantId } = await tokenManager.getValidToken(clientId);

  const configRes = await pool.query('SELECT * FROM client_config WHERE id = $1', [clientId]);
  const clientConfig = configRes.rows[0] || {};
  const clientName = clientConfig.client_name || 'Your Supplier';
  const overdueOnly = clientConfig.overdue_only === true;
  const senderEmail = clientConfig.sender_email;
  const senderName = clientConfig.sender_name || clientName;

  console.log('[Worker] Client config fetched:', clientConfig.client_name);

  const invoicesData = await xeroGet(
    'https://api.xero.com/api.xro/2.0/Invoices?Statuses=AUTHORISED&summaryOnly=false',
    accessToken, tenantId
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];

  const buckets = {};
  for (const inv of invoicesData.Invoices || []) {
    if (inv.Type !== 'ACCREC') continue;
    const contact = inv.Contact || {};
    const contactId = contact.ContactID;
    if (!contactId || !selectedContactIds.includes(contactId)) continue;

    const amountDue = parseFloat(inv.AmountDue) || 0;
    if (amountDue <= 0) continue;
    if (inv.CurrencyCode && inv.CurrencyCode !== 'AUD') continue;

    if (!buckets[contactId]) {
      buckets[contactId] = {
        ContactID: contactId,
        ContactName: contact.Name || contactId,
        TotalOutstanding: 0,
        InvoiceCount: 0,
        OldestDaysOverdue: 0,
        StatementDate: todayStr,
        Invoices: []
      };
    }
    const bucket = buckets[contactId];
    const invoiceDate = parseXeroDate(inv.DateString || inv.Date);
    const dueDate = parseXeroDate(inv.DueDateString || inv.DueDate);
    const daysOverdue = dueDate ? Math.max(0, daysDiff(dueDate, today)) : 0;

    bucket.Invoices.push({
      InvoiceNumber: inv.InvoiceNumber || 'N/A',
      InvoiceDate: invoiceDate ? invoiceDate.toISOString().split('T')[0] : null,
      DueDate: dueDate ? dueDate.toISOString().split('T')[0] : null,
      DaysOverdue: daysOverdue,
      AmountDue: amountDue,
      Status: daysOverdue > 0 ? 'OVERDUE' : 'CURRENT'
    });
    bucket.TotalOutstanding += amountDue;
    bucket.InvoiceCount += 1;
    if (daysOverdue > bucket.OldestDaysOverdue) bucket.OldestDaysOverdue = daysOverdue;
  }

  console.log('[Worker] Fetched invoices, contact count in buckets:', Object.keys(buckets).length);

  const sentResults = [];
  const skippedResults = [];
  const failedResults = [];

  console.log('[Worker] Processing', Object.values(buckets).length, 'contacts');

  for (const contact of Object.values(buckets)) {
    contact.ToneTier = getToneTier(contact.OldestDaysOverdue);
    contact.TotalOutstanding = parseFloat(contact.TotalOutstanding.toFixed(2));

    try {
      const existing = await pool.query(
        'SELECT 1 FROM sent_statements WHERE contact_id = $1 AND statement_date = $2',
        [contact.ContactID, todayStr]
      );
      if (existing.rows.length > 0) continue;

      const contactData = await xeroGet(
        `https://api.xero.com/api.xro/2.0/Contacts/${contact.ContactID}`,
        accessToken, tenantId
      );
      const email = ((contactData.Contacts || [])[0]?.EmailAddress || '').trim();

      if (!email) {
        await pool.query(
          `INSERT INTO sent_statements (contact_id, contact_name, statement_date, alert_email, created_at, updated_at)
           VALUES ($1, $2, 'SKIPPED-NO-EMAIL', $3, NOW(), NOW())
           ON CONFLICT (contact_id, statement_date) DO NOTHING`,
          [contact.ContactID, contact.ContactName, clientConfig.auto_statements_email]
        );
        skippedResults.push({ contactId: contact.ContactID, contactName: contact.ContactName, reason: 'NO_EMAIL' });
        continue;
      }

      const paidData = await xeroGet(
        `https://api.xero.com/api.xro/2.0/Invoices?ContactIDs=${contact.ContactID}&Statuses=PAID`,
        accessToken, tenantId
      );
      const paidInvoices = (paidData.Invoices || []).filter(inv => inv.Type === 'ACCREC');
      let avgDaysLate = null, paidCount = 0, performanceLabel = '';
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
          avgDaysLate = Math.round(totalDaysLate / validCount);
          paidCount = validCount;
          performanceLabel = avgDaysLate < 0
            ? `Pays ${Math.abs(avgDaysLate)} days early on average (${paidCount} invoices)`
            : avgDaysLate === 0
              ? `Pays on time on average (${paidCount} invoices)`
              : `Pays ${avgDaysLate} days late on average (${paidCount} invoices)`;
        }
      }
      contact.PaymentPerformanceLabel = performanceLabel;

      const html = buildStatementHtml(contact, clientName, overdueOnly);

      const form = new FormData();
      form.append('index.html', Buffer.from(html, 'utf-8'), { filename: 'index.html', contentType: 'text/html' });
      const pdfRes = await fetch(`${GOTENBERG_URL}/forms/chromium/convert/html`, {
        method: 'POST', body: form, headers: form.getHeaders()
      });
      if (!pdfRes.ok) throw new Error(`Gotenberg failed: ${pdfRes.status}`);
      const pdfBase64 = Buffer.from(await pdfRes.arrayBuffer()).toString('base64');

      const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
        body: JSON.stringify({
          sender: { email: senderEmail, name: senderName },
          to: [{ email }],
          subject: `Statement of Account — ${contact.ContactName} — ${todayStr}`,
          htmlContent: '<p>Please find your statement attached.</p>',
          attachment: [{ content: pdfBase64, name: `Statement-${contact.ContactName}.pdf` }]
        })
      });
     if (!brevoRes.ok) {
     const errBody = await brevoRes.text();
     throw new Error(`Brevo send failed: ${brevoRes.status} - ${errBody}`);
   }

      await pool.query(
        `INSERT INTO sent_statements (contact_id, contact_name, statement_date, alert_email, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [contact.ContactID, contact.ContactName, todayStr, email]
      );
      sentResults.push({ contactId: contact.ContactID, contactName: contact.ContactName, email });

    } catch (err) {
      console.error(`[Worker] Failed for ${contact.ContactName}:`, err.message);
      failedResults.push({ contactId: contact.ContactID, contactName: contact.ContactName, error: err.message });
    }
  }

  return { sent: sentResults, skipped: skippedResults, failed: failedResults };
}, {
  connection: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT || 6379,
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD
  }
});

module.exports = worker;
