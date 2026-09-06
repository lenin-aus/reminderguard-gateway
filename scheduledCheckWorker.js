// scheduledCheckWorker.js
// Global heartbeat consumer. One job every 15 minutes for ALL clients.
// Replaces the old per-client cron/upsertJobScheduler model entirely.

const { Worker, Queue } = require('bullmq');
const Redis = require('ioredis');
const pool = require('./db');
const { computeFirstRun, computeNextRun } = require('./scheduleCalc');
const { getFilteredContacts } = require('./recipientSelector');
const { getOrFetchBaseCurrency, getTenantTodayDateString } = require('./shared');

const connection = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT || 6379,
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD
};

const redis = new Redis(connection);

// Send jobs go here — owned by server.js / autoStatementsWorker.js.
const autoStatementsQueue = new Queue('auto-statements', { connection });

const STALE_RUN_MINUTES = 15;
const LOCK_TTL_MS = 15 * 60 * 1000;

// Any run still 'running' past the timeout is assumed dead (worker crash,
// redeploy mid-run). Marked failed so the UNIQUE constraint stops blocking,
// and so it shows as failed rather than hanging in the dashboard forever.
// Duplicate emails are prevented by the per-bucket locks in
// autoStatementsWorker.js, not by this reset.
async function resetStaleRuns() {
  const { rowCount } = await pool.query(
    `UPDATE scheduled_runs
     SET status = 'failed',
         finished_at = now(),
         error = COALESCE(error, 'Stale run — worker died or redeployed mid-run')
     WHERE status = 'running'
       AND started_at < now() - ($1 || ' minutes')::interval`,
    [STALE_RUN_MINUTES]
  );
  if (rowCount > 0) console.log(`[Heartbeat] Reset ${rowCount} stale run(s)`);
}

// next_run_at IS NULL means the schedule was just saved/changed and has never
// been scheduled. Backfill it and deliberately do NOT run this tick — saving
// a config should never fire statements immediately.
async function backfillNextRun(config) {
  const nextRun = computeFirstRun(config, new Date());
  await pool.query('UPDATE client_config SET next_run_at = $1 WHERE id = $2', [nextRun, config.id]);
  console.log(`[Heartbeat] Client ${config.id} backfilled next_run_at = ${nextRun.toISOString()}`);
}

async function finishRun(runId, status, contactCount, error) {
  await pool.query(
    `UPDATE scheduled_runs
     SET status = $1, finished_at = now(), contact_count = $2, error = $3
     WHERE id = $4`,
    [status, contactCount === undefined ? null : contactCount, error || null, runId]
  );
}

async function runClient(config) {
  const clientId = config.id;
  const scheduledFor = new Date(config.next_run_at);
  const scheduledForIso = scheduledFor.toISOString();

  // Layer 1 — fast path. Blocks a second tick in the same window.
  const lockKey = `SCHEDULED:${clientId}:${scheduledForIso}`;
  const gotLock = await redis.set(lockKey, '1', 'NX', 'PX', LOCK_TTL_MS);
  if (!gotLock) {
    console.log(`[Heartbeat] Client ${clientId} — lock held, skipping`);
    return;
  }

  // Layer 2 — durable. Survives a Redis flush; this is the real guard.
  let runId;
  try {
    const { rows } = await pool.query(
      `INSERT INTO scheduled_runs (client_id, scheduled_for, status, recipient_filter)
       VALUES ($1, $2, 'running', $3)
       RETURNING id`,
      [clientId, scheduledFor, config.recipient_filter || 'outstanding']
    );
    runId = rows[0].id;
  } catch (e) {
    if (e.code === '23505') {
      console.log(`[Heartbeat] Client ${clientId} — run ${scheduledForIso} already claimed`);
      return;
    }
    throw e;
  }

  // Advance BEFORE any Xero/queue work. If this process dies mid-run the
  // schedule has already moved on, so the heartbeat can never loop the same
  // slot. Anchored to scheduledFor, not now(), so cadence doesn't drift by
  // however late the tick picked it up.
  try {
    const nextRun = computeNextRun(config, scheduledFor);
    await pool.query('UPDATE client_config SET next_run_at = $1 WHERE id = $2', [nextRun, clientId]);
    console.log(`[Heartbeat] Client ${clientId} — next_run_at advanced to ${nextRun.toISOString()}`);
  } catch (e) {
    await finishRun(runId, 'failed', null, `computeNextRun failed: ${e.message}`);
    console.error(`[Heartbeat] Client ${clientId} — could not advance next_run_at:`, e.message);
    return;
  }

  try {
    // Re-read config. The row from the tick query could be minutes stale by
    // the time a busy tick reaches this client.
    const { rows: freshRows } = await pool.query('SELECT * FROM client_config WHERE id = $1', [clientId]);
    const fresh = freshRows[0];

    if (!fresh || !fresh.auto_statements_enabled) {
      await finishRun(runId, 'skipped_disabled', 0, null);
      console.log(`[Heartbeat] Client ${clientId} — disabled, skipping`);
      return;
    }

    const buckets = await getFilteredContacts(clientId, fresh.recipient_filter || 'outstanding');

    if (buckets.length === 0) {
      await finishRun(runId, 'skipped_no_recipients', 0, null);
      console.log(`[Heartbeat] Client ${clientId} — no contacts matched filter`);
      return;
    }

    const baseCurrency = await getOrFetchBaseCurrency(clientId);
    const todayDateString = getTenantTodayDateString();

    // Pre-check the per-bucket idempotency keys (optimization only — the
    // worker's atomic SET NX lock is the real duplicate guard).
    const sentKeys = buckets.map((b) => `sent-statement:${clientId}:${b.bucketKey}:${todayDateString}`);
    const sentFlags = await redis.mget(sentKeys);
    const toEnqueue = buckets.filter((_, i) => !sentFlags[i]);

    if (toEnqueue.length === 0) {
      await finishRun(runId, 'completed', 0, 'All buckets already sent today');
      console.log(`[Heartbeat] Client ${clientId} — all buckets already sent today`);
      return;
    }

    // Insert PROCESSING rows at enqueue time so the dashboard shows
    // "Sending..." during queue wait, matching the manual trigger route.
    const insertValues = [];
    const insertParams = [];
    let p = 1;
    for (const b of toEnqueue) {
      insertValues.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, 'PROCESSING')`);
      insertParams.push(clientId, b.contactId, b.bucketKey, b.currencyCode, 'scheduled');
    }
    const { rows: insertedLogs } = await pool.query(
      `INSERT INTO statement_logs (client_id, contact_id, bucket_key, currency_code, trigger_type, status)
       VALUES ${insertValues.join(', ')}
       RETURNING id, bucket_key`,
      insertParams
    );
    const logIdByBucketKey = {};
    for (const row of insertedLogs) logIdByBucketKey[row.bucket_key] = row.id;

    const jobs = toEnqueue.map((b) => ({
      name: 'send-statements',
      data: {
        clientId,
        bucketKey: b.bucketKey,
        currencyCode: b.currencyCode,
        contactId: b.contactId,
        baseCurrency,
        todayDateString,
        logId: logIdByBucketKey[b.bucketKey]
      },
      opts: {
        jobId: `send-sched-${clientId}-${b.bucketKey}-${todayDateString}`,
        backoff: { type: 'custom' },
        attempts: 5,
        removeOnComplete: { age: 86400, count: 100 },
        removeOnFail: { age: 604800, count: 500 }
      }
    }));

    await autoStatementsQueue.addBulk(jobs);
    await finishRun(runId, 'completed', toEnqueue.length, null);
    console.log(`[Heartbeat] Client ${clientId} — queued ${toEnqueue.length} bucket(s)`);
  } catch (e) {
    await finishRun(runId, 'failed', null, e.message).catch(() => {});
    console.error(`[Heartbeat] Client ${clientId} — run failed:`, e.message);
  }
}

async function tick() {
  await resetStaleRuns();

  const { rows } = await pool.query(
    `SELECT * FROM client_config
     WHERE auto_statements_enabled = true
       AND (next_run_at IS NULL OR next_run_at <= now())
     ORDER BY next_run_at NULLS FIRST`
  );

  if (rows.length === 0) return;
  console.log(`[Heartbeat] ${rows.length} client(s) due`);

  for (const config of rows) {
    try {
      if (config.next_run_at === null) {
        await backfillNextRun(config);
        continue;
      }
      await runClient(config);
    } catch (e) {
      // One bad client must never abort the tick for everyone else.
      console.error(`[Heartbeat] Client ${config.id} — unhandled error:`, e.message, e.stack);
    }
  }
}

// concurrency: 1 — two overlapping ticks would race on the same due clients.
// The locks would catch it, but serialising is cheaper and simpler.
const scheduledCheckWorker = new Worker('auto-statements-scheduler', async () => {
  await tick();
}, { connection, concurrency: 1 });

scheduledCheckWorker.on('failed', (job, err) => {
  console.error('[Heartbeat] Job FAILED:', job?.id, err?.message, err?.stack);
});
scheduledCheckWorker.on('error', (err) => {
  console.error('[Heartbeat] Worker-level ERROR:', err?.message, err?.stack);
});

module.exports = scheduledCheckWorker;
