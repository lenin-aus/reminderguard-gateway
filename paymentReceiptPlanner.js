'use strict';

// Consumes the five-minute planner tick (registered by scheduler.js) and enqueues one job per due
// org onto the 'payment-receipts' queue (paymentReceiptWorker.js). Loaded by
// scheduledCheckWorker.js, so it runs in the same process — no new Coolify app. Kept separate from
// paymentReceiptWorker.js, the same way xeroSyncPlan/xeroSyncWorker split planning from doing:
// a slow per-client check (Xero reads, a PDF, a Brevo send) never delays the next planning tick,
// and each client's check gets its own BullMQ job, with its own retry/backoff.

const { Worker, Queue } = require('bullmq');
const pool = require('./db');
const { runPlanner } = require('./paymentReceiptPlan');

const connection = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT || 6379,
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
};

const paymentReceiptsQueue = new Queue('payment-receipts', { connection });

// concurrency 1: two overlapping planning ticks would only double-enqueue (harmlessly, since
// jobIds are per-client — see paymentReceiptPlan.js — but there is no reason to let them overlap).
const paymentReceiptPlanner = new Worker(
  'payment-receipt-planner',
  async () => {
    const jobs = await runPlanner({ db: pool, queue: paymentReceiptsQueue });
    if (jobs.length > 0) console.log(`[payment-receipts] planner queued clients: ${jobs.map((j) => j.clientId).join(', ')}`);
  },
  { connection, concurrency: 1 }
);

paymentReceiptPlanner.on('failed', (job, err) => console.error('[payment-receipts] planner job FAILED:', err?.message));
paymentReceiptPlanner.on('error', (err) => console.error('[payment-receipts] planner worker error:', err?.message));

module.exports = paymentReceiptPlanner;
