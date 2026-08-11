const { Worker } = require('bullmq');
const { pool } = require('./db');
const Redis = require('ioredis');
const config = require('./config');
const { getValidXeroToken } = require('./tokenManager');
const { getTenantTodayDateString } = require('./xero');
const axios = require('axios');
const fetch = require('node-fetch');
const FormData = require('form-data');

const redis = new Redis(config.redisConnectionString);
const GOTENBERG_URL = config.GOTENBERG_URL || process.env.GOTENBERG_URL || 'http://gotenberg:3000';

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

// Crash-safe helper that preserves raw currency codes. Prevents Brevo double-symbol risk
function formatCurrency(amount, currencyCode) {
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currencyCode,
            currencyDisplay: 'narrowSymbol'
        }).format(amount);
    } catch (e) {
        return `${currencyCode} ${parseFloat(amount).toFixed(2)}`;
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
    
    const fmt = n => formatCurrency(n, currencyCode);

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
            <td style="padding:10px 12px;text-align:right;">${formatCurrency(inv.AmountDue, currencyCode)}</td>
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
    <div class="samt">${formatCurrency(totalToShow, currencyCode)}</div>
</div></div>
${agingTable}
${paymentHistory}
<div class="ftr">Statement generated automatically on ${contact.StatementDate}.<br>Please contact us if you have any questions regarding your account.</div>
</div></body></html>`;
}

const worker = new Worker('autoStatements', async job => {
    const { clientId, bucketKey, logId } = job.data;
    const [contactId, currencyCode] = bucketKey.split('_');
    const todayDateString = getTenantTodayDateString();
    
    // Idempotency Engine: Check Redis
    const idempotencyKey = `sent-statement:${clientId}:${bucketKey}:${todayDateString}`;
    
    const acquired = await redis.set(idempotencyKey, `PROCESSING:${job.id}`, 'NX', 'EX', 86400);
    
    if (!acquired) {
        const currentLock = await redis.get(idempotencyKey);
        if (currentLock !== `PROCESSING:${job.id}`) return;
    }

    try {
        const token = await getValidXeroToken(clientId);
        const { rows: configRows } = await pool.query('SELECT * FROM client_config WHERE id = $1', [clientId]);
        const clientConfig = configRows[0] || {};
        const tenantId = clientConfig.xero_tenant_id;
        const clientName = clientConfig.client_name || 'Your Supplier';
        const overdueOnly = clientConfig.overdue_only === true;
        const senderEmail = clientConfig.sender_email || 'accounts@company.com';
        const senderName = clientConfig.sender_name || clientName;

        const contactRes = await axios.get(`https://api.xero.com/api.xro/2.0/Contacts/${contactId}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'xero-tenant-id': tenantId, 'Accept': 'application/json' }
        });
        const contact = contactRes.data.Contacts[0];

        // Terminal Skips: If missing/archived contact or missing/invalid email
        if (!contact || contact.ContactStatus === 'ARCHIVED' || !contact.EmailAddress) {
            await pool.query(`
                UPDATE statement_logs 
                SET status = 'FAILED', error_reason = 'MISSING_EMAIL', error_message = 'Terminal skip: Missing or invalid contact data'
                WHERE id = $1
            `, [logId]);
            
            await redis.set(idempotencyKey, `FAILED:${job.id}`, 'KEEPTTL');
            return;
        }

        const recipientEmail = contact.EmailAddress.trim();
        const recipientName = contact.Name;

        const invoicesRes = await axios.get(`https://api.xero.com/api.xro/2.0/Invoices?ContactIDs=${contactId}&Statuses=AUTHORISED&Type=ACCREC`, {
            headers: { 'Authorization': `Bearer ${token}`, 'xero-tenant-id': tenantId, 'Accept': 'application/json' }
        });
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const currencyInvoices = invoicesRes.data.Invoices.filter(i => i.CurrencyCode === currencyCode && i.AmountDue > 0);
        const totalDue = currencyInvoices.reduce((sum, inv) => sum + inv.AmountDue, 0);

        if (totalDue <= 0) {
            await pool.query(`UPDATE statement_logs SET status = 'FAILED', error_reason = 'NO_BALANCE' WHERE id = $1`, [logId]);
            await redis.set(idempotencyKey, `FAILED:${job.id}`, 'KEEPTTL');
            return;
        }

        const formattedInvoices = currencyInvoices.map(inv => {
            const invoiceDate = parseXeroDate(inv.DateString || inv.Date);
            const dueDate = parseXeroDate(inv.DueDateString || inv.DueDate);
            const daysOverdue = dueDate ? Math.max(0, daysDiff(dueDate, today)) : 0;
            return {
                InvoiceNumber: inv.InvoiceNumber || 'N/A',
                InvoiceDate: invoiceDate ? invoiceDate.toISOString().split('T')[0] : null,
                DueDate: dueDate ? dueDate.toISOString().split('T')[0] : null,
                DaysOverdue: daysOverdue,
                AmountDue: inv.AmountDue,
                Status: daysOverdue > 0 ? 'OVERDUE' : 'CURRENT'
            };
        });

        const oldestDaysOverdue = Math.max(0, ...formattedInvoices.map(i => i.DaysOverdue));
        const toneTier = getToneTier(oldestDaysOverdue);

        // Fetch payment performance history for this contact
        let paymentPerformanceLabel = '';
        try {
            const paidData = await axios.get(`https://api.xero.com/api.xro/2.0/Invoices?ContactIDs=${contactId}&Statuses=PAID`, {
                headers: { 'Authorization': `Bearer ${token}`, 'xero-tenant-id': tenantId, 'Accept': 'application/json' }
            });
            const paidInvoices = (paidData.data.Invoices || []).filter(inv => inv.Type === 'ACCREC');
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
                    paymentPerformanceLabel = avgDaysLate < 0
                        ? `Pays ${Math.abs(avgDaysLate)} days early on average (${validCount} invoices)`
                        : avgDaysLate === 0
                          ? `Pays on time on average (${validCount} invoices)`
                          : `Pays ${avgDaysLate} days late on average (${validCount} invoices)`;
                }
            }
        } catch (perfErr) {
            console.error('Error fetching payment performance:', perfErr.message);
        }

        const contactObj = {
            ContactID: contactId,
            ContactName: recipientName,
            StatementDate: todayDateString,
            Invoices: formattedInvoices,
            PaymentPerformanceLabel: paymentPerformanceLabel,
            ToneTier: toneTier
        };

        const formattedTotal = formatCurrency(totalDue, currencyCode);
        const safeFilename = `Statement_${recipientName.replace(/[^a-z0-9]/gi, '_')}_${todayDateString}.pdf`;

        // Generate PDF via Gotenberg
        const html = buildStatementHtml(contactObj, clientName, overdueOnly, currencyCode);
        const form = new FormData();
        form.append('index.html', Buffer.from(html, 'utf-8'), { filename: 'index.html', contentType: 'text/html' });

        const pdfRes = await fetch(`${GOTENBERG_URL}/forms/chromium/convert/html`, {
            method: 'POST',
            body: form,
            headers: form.getHeaders()
        });
        if (!pdfRes.ok) throw new Error(`Gotenberg failed: ${pdfRes.status}`);
        const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
        const base64Pdf = pdfBuffer.toString('base64');

        const brevoPayload = {
            sender: { name: senderName, email: senderEmail },
            to: [{ email: recipientEmail, name: recipientName }],
            subject: `Your Account Statement - ${formattedTotal}`,
            htmlContent: `<p>Please find your attached statement for ${formattedTotal}.</p>`,
            attachment: [{ content: base64Pdf, name: safeFilename }]
        };

        await axios.post('https://api.brevo.com/v3/smtp/email', brevoPayload, {
            headers: { 'api-key': config.brevoApiKey, 'Content-Type': 'application/json' }
        });

        await pool.query(`
            UPDATE statement_logs 
            SET status = 'DELIVERED', recipient_name = $1, recipient_email = $2 
            WHERE id = $3
        `, [recipientName, recipientEmail, logId]);
        
        await redis.set(idempotencyKey, `DELIVERED:${job.id}`, 'KEEPTTL');

    } catch (error) {
        let reason = 'API_ERROR';
        if (error.response && error.response.status === 400) reason = 'INVALID_EMAIL';
        
        await pool.query(`
            UPDATE statement_logs 
            SET status = 'FAILED', error_reason = $1, error_message = $2 
            WHERE id = $3
        `, [reason, error.message, logId]);
        
        await redis.set(idempotencyKey, `FAILED:${job.id}`, 'KEEPTTL');
        throw error;
    }
}, {
    connection: redis,
    concurrency: 2,
    limiter: { max: 20, duration: 60000 },
    settings: {
        backoffStrategies: {
            lockCollisionDelay: (attemptsMade, err) => {
                return Math.min(1000 * Math.pow(2, attemptsMade), 30000);
            }
        }
    }
});

module.exports = worker;
