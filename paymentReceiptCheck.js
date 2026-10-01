'use strict';

// One org's payment-receipt check: reads recent customer-receipt payments from Xero, skips
// anything already logged, emails a receipt (Xero's own invoice PDF attached) via Brevo for the
// rest, logs every outcome, and — if anything was skipped for a missing email — one alert to the
// bookkeeper. No BullMQ here (that is paymentReceiptWorker.js, which wraps checkClient() in a
// Worker): kept side-effect-free to require, so the gateway process can also call checkClient()
// directly (the manual check route in server.js) without starting a second queue consumer.

const fetch = require('node-fetch');
const pool = require('./db');
const { getXeroContext } = require('./xeroContext');
const { getXeroData } = require('./xeroData');
const { getXeroPayments } = require('./xeroPayments');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_API_URL = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';
const CHECK_WINDOW_DAYS = 2;

function fmt(amount, currencyCode) {
  const code = (currencyCode || 'AUD').toString().trim().toUpperCase();
  try {
    return new Intl.NumberFormat('en-AU', { style: 'currency', currency: code }).format(amount);
  } catch {
    return `${code} ${Number(amount).toFixed(2)}`;
  }
}

async function sendViaBrevo({ senderEmail, senderName, toEmail, ccEmail, subject, htmlContent, attachment }) {
  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: toEmail }],
      ...(ccEmail ? { cc: [{ email: ccEmail }] } : {}),
      subject,
      htmlContent,
      ...(attachment ? { attachment: [attachment] } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Brevo send failed: ${res.status} - ${await res.text()}`);
}

// One payment -> a dedup check, a receipt email or a SKIPPED_NO_EMAIL row. Never throws for a
// single payment's own failure (a FAILED row is logged instead, so one bad payment can't stop the
// rest of the run); only a config/Xero-connection problem affecting the whole client propagates.
async function processPayment({ clientId, payment, config, ctx, payments, live, alreadyHandled }) {
  if (alreadyHandled.has(payment.id)) return null;

  const logRow = async (status, extra = {}) => {
    await pool.query(
      `INSERT INTO payment_receipt_log (client_id, payment_id, invoice_number, contact_name, amount_paid, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (client_id, payment_id) DO UPDATE SET
         status = EXCLUDED.status, error_message = EXCLUDED.error_message, created_at = now()`,
      [clientId, payment.id, payment.invoiceNumber, payment.contactName, payment.amount, status, extra.errorMessage || null]
    );
  };

  let contact = null;
  if (payment.contactId) {
    try {
      contact = await live.getContact(ctx, payment.contactId);
    } catch (e) {
      if (e.code !== 'XERO_NOT_FOUND') throw e;
    }
  }

  if (!contact || !contact.email) {
    await logRow('SKIPPED_NO_EMAIL');
    return { skipped: true };
  }

  try {
    const [amountDue, pdfBytes] = await Promise.all([
      payments.getInvoiceAmountDue(ctx, payment.invoiceId),
      payments.getInvoicePdf(ctx, payment.invoiceId),
    ]);

    const isPartial = amountDue > 0;
    const currency = payment.currency || 'AUD';
    const amountPaid = payment.amount / 100;
    const subject = isPartial
      ? `Part payment received — ${fmt(amountDue / 100, currency)} still outstanding — Invoice ${payment.invoiceNumber}`
      : `Payment received in full — Invoice ${payment.invoiceNumber} — Thank you`;
    const htmlContent = [
      `<p>Dear ${payment.contactName || 'Valued Customer'},</p>`,
      `<p>${
        isPartial
          ? `Thank you for your payment of ${fmt(amountPaid, currency)} against Invoice ${payment.invoiceNumber}.`
          : `Thank you for your payment of ${fmt(amountPaid, currency)}. Invoice ${payment.invoiceNumber} is now paid in full.`
      }</p>`,
      isPartial ? `<p>A balance of ${fmt(amountDue / 100, currency)} remains outstanding.</p>` : '',
      '<p>Please find your official receipt attached to this email.</p>',
    ].join('\n');

    await sendViaBrevo({
      senderEmail: config.sender_email,
      senderName: config.sender_name || config.client_name,
      toEmail: config.receipt_test_email || contact.email,
      ccEmail: config.receipt_cc_email,
      subject,
      htmlContent,
      attachment: { content: pdfBytes.toString('base64'), name: `Receipt-${payment.invoiceNumber}.pdf` },
    });

    await logRow('SENT');
    return { sent: true };
  } catch (e) {
    console.error(`[payment-receipts] client=${clientId} payment=${payment.id} failed:`, e.message);
    await logRow('FAILED', { errorMessage: e.message });
    return { failed: true };
  }
}

async function alertSkipped({ config, skipped }) {
  if (skipped.length === 0 || !config.receipt_alert_email) return;
  const lines = skipped
    .map((p) => `• Invoice ${p.invoiceNumber} — ${p.contactName} — ${fmt(p.amount / 100, p.currency || 'AUD')} (no email address in Xero)`)
    .join('<br>');
  await sendViaBrevo({
    senderEmail: config.sender_email,
    senderName: config.sender_name || config.client_name,
    toEmail: config.receipt_alert_email,
    subject: `${skipped.length} receipt${skipped.length === 1 ? '' : 's'} could not be sent`,
    htmlContent: `<p>The following payment${skipped.length === 1 ? '' : 's'} could not be emailed a receipt because the contact has no email address in Xero:</p><p>${lines}</p><p>Add the email address in Xero; it will be picked up on the next check.</p>`,
  });
}

async function checkClient(clientId) {
  const { rows } = await pool.query('SELECT * FROM client_config WHERE id = $1', [clientId]);
  const config = rows[0];
  if (!config || !config.receipts_enabled) return { checked: false, reason: 'not enabled' };

  const ctx = await getXeroContext(clientId);
  const payments = getXeroPayments();
  const live = getXeroData();

  const sinceDate = new Date(Date.now() - CHECK_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const candidates = await payments.getRecentReceiptPayments(ctx, sinceDate);

  const { rows: handled } = candidates.length
    ? await pool.query(
        `SELECT payment_id FROM payment_receipt_log WHERE client_id = $1 AND payment_id = ANY($2) AND status IN ('SENT', 'SKIPPED_NO_EMAIL')`,
        [clientId, candidates.map((p) => p.id)]
      )
    : { rows: [] };
  const alreadyHandled = new Set(handled.map((r) => r.payment_id));

  let sent = 0;
  const skipped = [];
  for (const payment of candidates) {
    const result = await processPayment({ clientId, payment, config, ctx, payments, live, alreadyHandled });
    if (result?.skipped) skipped.push(payment);
    if (result?.sent) sent++;
  }
  await alertSkipped({ config, skipped });

  await pool.query(
    `INSERT INTO payment_receipt_state (client_id, last_checked_at, last_error, last_error_at)
     VALUES ($1, now(), NULL, NULL)
     ON CONFLICT (client_id) DO UPDATE SET last_checked_at = now(), last_error = NULL, last_error_at = NULL`,
    [clientId]
  );

  return { checked: true, candidates: candidates.length, sent, skipped: skipped.length };
}

module.exports = { checkClient };
