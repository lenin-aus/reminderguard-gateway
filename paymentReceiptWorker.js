'use strict';

// Consumes 'payment-receipts' (job 'check-client', { clientId }), queued by paymentReceiptPlan.js.
// The actual per-client logic is checkClient(), in paymentReceiptCheck.js (kept separate so the
// gateway process can also call it directly, for the manual check route in server.js, without
// starting a second consumer of this queue). Not unit-tested directly, same as
// autoStatementsWorker.js and scheduledCheckWorker.js: the BullMQ wiring is covered by the local
// stack's fixture-backed integration check (stack:verify-receipts), and the parts with real logic
// (the planner, xeroPayments, receiptConfig, checkClient's Brevo/subject-line choices) are
// unit- or fixture-tested on their own.

const { Worker } = require('bullmq');
const pool = require('./db');
const { getXeroRedis } = require('./xeroData');
const { checkClient } = require('./paymentReceiptCheck');
const { acquireReceiptLock } = require('./paymentReceiptPlan');

const connection = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT || 6379,
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
};

const worker = new Worker(
  'payment-receipts',
  async (job) => {
    const { clientId } = job.data;
    // One check per org at a time (see paymentReceiptPlan.js's comment on the jobId bug this
    // replaced). A lock already held just means a check is already running — not an error, and not
    // something to log every tick: this job simply has nothing to do.
    const release = await acquireReceiptLock(getXeroRedis(), clientId);
    if (!release) return;
    try {
      await checkClient(clientId);
    } catch (e) {
      console.error(`[payment-receipts] client=${clientId} check failed:`, e.message);
      await pool.query(
        `INSERT INTO payment_receipt_state (client_id, last_error, last_error_at)
         VALUES ($1, $2, now())
         ON CONFLICT (client_id) DO UPDATE SET last_error = EXCLUDED.last_error, last_error_at = now()`,
        [clientId, String(e.message).slice(0, 500)]
      );
      throw e;
    } finally {
      await release().catch(() => {});
    }
  },
  { connection, concurrency: 2 }
);

worker.on('failed', (job, err) => console.error('[payment-receipts] job FAILED:', job?.id, err?.message));
worker.on('error', (err) => console.error('[payment-receipts] worker error:', err?.message));

module.exports = worker;
