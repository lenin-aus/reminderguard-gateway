const { Worker, UnrecoverableError } = require('bullmq');
const FormData = require('form-data');
const Redis = require('ioredis');
const pool = require('./db');
const fetch = require('node-fetch');
const { getXeroContext, getXeroTenantId } = require('./xeroContext');
const { getXeroData } = require('./xeroData');
const { buildStatementModel } = require('./statementModel');
const { renderStatementHtml } = require('./statementHtml');
const { renderTemplate, toSubject, bodyToHtml } = require('./statementTemplate');
const { statementLockKey } = require('./statementOptions');

const GOTENBERG_URL = process.env.GOTENBERG_URL || 'http://gotenberg:3000';
const BREVO_API_KEY = process.env.BREVO_API_KEY;
// Overridable so the local dev stack can point at a stub and never reach the real service.
const BREVO_API_URL = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT || 6379,
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD
});

// NFD-normalize + strip diacritics + replace invalid filename chars, falling
// back to contactId if the result is empty (e.g. all-symbol contact names).
function sanitizeForFilename(name, contactId) {
  const cleaned = (name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
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

async function updateStatementLog(logId, status, errorMessage, errorReason) {
  await pool.query(
    `UPDATE statement_logs
     SET status = $1, error_message = $2, error_reason = $3
     WHERE id = $4`,
    [status, errorMessage || null, errorReason || null, logId]
  );
}

// A job that ends for a reason no retry can fix: the log row is marked FAILED with a stable
// reason, the lock is released, and the job completes with a SKIPPED_* status (no retry).
async function skip(logId, lockKey, reason, message, status) {
  await updateStatementLog(logId, 'FAILED', message, reason);
  await redis.del(lockKey);
  return { status };
}

const worker = new Worker('auto-statements', async (job) => {
  const { clientId, bucketKey, currencyCode, contactId, todayDateString, logId, options = null, optionsHash = 'default', estimatedCalls = 0 } = job.data;

  console.log('[Worker] Job started for client', clientId, 'bucketKey:', bucketKey);

  const lockKey = statementLockKey(clientId, bucketKey, todayDateString, optionsHash);
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

  const data = getXeroData();
  let emailSent = false;
  let tenantId = null;
  // The calls this job reserved against the daily quota are given back once it is finished
  // for good (sent, skipped, or out of retries), not on each retry.
  const finished = () => tenantId && estimatedCalls ? data.takePending(tenantId, estimatedCalls).catch(() => {}) : Promise.resolve();

  try {
    const configRes = await pool.query('SELECT * FROM client_config WHERE id = $1', [clientId]);
    const clientConfig = configRes.rows[0] || {};
    const clientName = clientConfig.client_name || 'Your Supplier';
    const senderEmail = clientConfig.sender_email;
    const senderName = clientConfig.sender_name || clientName;

    if (!senderEmail) {
      console.log(`[Worker] Terminal skip — client ${clientId} has no sender_email`);
      await finished();
      return await skip(logId, lockKey, 'MISSING_SENDER', 'This client has no sender email address configured', 'SKIPPED_NO_SENDER');
    }

    tenantId = await getXeroTenantId(clientId);
    const ctx = await getXeroContext(clientId);
    await data.assertBudget(ctx);

    // Fresh contact lookup — email always sourced here, never from the
    // enqueue-time payload, in case the customer's email changed in Xero.
    let contact;
    try {
      contact = await data.getContact(ctx, contactId);
    } catch (e) {
      if (e.code !== 'XERO_NOT_FOUND') throw e;
    }
    if (!contact) {
      console.log(`[Worker] Terminal skip — contact ${contactId} missing/archived`);
      await finished();
      return await skip(logId, lockKey, 'CONTACT_NOT_FOUND', 'Contact not found in Xero', 'SKIPPED_CONTACT_NOT_FOUND');
    }
    if (!contact.email) {
      console.log(`[Worker] Terminal skip — no valid email for ${bucketKey}`);
      await finished();
      return await skip(logId, lockKey, 'MISSING_EMAIL', 'No valid email address on file in Xero', 'SKIPPED_NO_VALID_EMAIL');
    }

    // A ranged send needs the contact's whole history (for the opening balance and the
    // Activity section); a scheduled send only needs what is open today.
    const range = options?.range || null;
    const [invoices, credits] = await Promise.all([
      range ? data.getInvoiceHistory(ctx, contactId) : data.getOpenInvoices(ctx, contactId),
      data.getCredits(ctx, contactId),
    ]);

    const model = buildStatementModel({ currency: currencyCode, today: todayDateString, range, invoices, credits });

    // Zero-balance race: customer may have paid between enqueue and execution.
    if (model.outstanding.total <= 0) {
      console.log(`[Worker] Skipping ${bucketKey} — no remaining balance due`);
      await finished();
      return await skip(logId, lockKey, 'ZERO_BALANCE', 'No remaining balance due at execution time', 'SKIPPED_ZERO_BALANCE');
    }

    if (model.checks && model.checks.difference !== 0) {
      // The history does not add up to the balance Xero reports: something this statement cannot
      // see (a refund, a manual journal). Logged so it can be reconciled; the statement still sends.
      console.warn(`[Worker] LEDGER_MISMATCH client=${clientId} bucket=${bucketKey} difference=${model.checks.difference} cents (ledger ${model.checks.ledgerBalance}, Xero balance ${model.checks.currentBalance})`);
    }

    const html = renderStatementHtml(model, { companyName: clientName, contactName: contact.name });

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
    const sanitizedName = sanitizeForFilename(contact.name, contactId);

    const totalDueRaw = model.outstanding.total / 100;
    const vars = { your_company_name: clientName, ...(range ? { start_date: range.start, end_date: range.end } : {}) };
    const subject = options?.subject
      ? toSubject(renderTemplate(options.subject, vars))
      : `Statement of Account — ${contact.name} — ${todayDateString}`;
    const htmlContent = options?.body
      ? bodyToHtml(renderTemplate(options.body, vars))
      : '<p>Please find your statement attached.</p>';

    const brevoRes = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: [{ email: contact.email }],
        ...(options?.replyTo ? { replyTo: { email: options.replyTo } } : {}),
        ...(options?.bcc ? { bcc: [{ email: options.bcc }] } : {}),
        subject,
        htmlContent,
        params: {
          contactName: contact.name,
          currencyCode: currencyCode.toUpperCase(),
          totalDueRaw,
          formattedTotalDue: fmt(totalDueRaw, currencyCode),
          statementDate: todayDateString
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

    await finished();
    console.log(`[Worker] Sent statement for ${bucketKey} to ${contact.email}`);
    return { status: 'SUCCESS' };
  } catch (err) {
    console.error(`[Worker] Failed for ${bucketKey}:`, err.message);

    if (emailSent) {
      // Email already went out — never retry, regardless of what failed after.
      await finished();
      return { status: 'SUCCESS_WITH_POST_PROCESSING_WARNING', error: err.message };
    }

    if (err.message && err.message.startsWith('LOCK_COLLISION')) {
      throw err;
    }

    const currentLock = await redis.get(lockKey);
    if (currentLock === `PROCESSING:${job.id}`) {
      await redis.del(lockKey);
    }

    // Out of the daily Xero quota: retrying cannot help, and says so clearly in the log row.
    if (err.code === 'XERO_DAILY_LIMIT') {
      await updateStatementLog(logId, 'FAILED', err.message, 'XERO_DAILY_LIMIT').catch(() => {});
      await finished();
      throw new UnrecoverableError(err.message);
    }

    await updateStatementLog(logId, 'FAILED', err.message, 'API_ERROR').catch(() => {});
    if (job.attemptsMade + 1 >= (job.opts.attempts || 1)) await finished();
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
