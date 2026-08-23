const pool = require('./db');
const Redis = require('ioredis');
const { getFilteredContacts } = require('./recipientSelector');
const { getOrFetchBaseCurrency, getTenantTodayDateString } = require('./shared');

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT || 6379,
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD
});

const ORDINAL_INDEX = {
  'the 1st': 0,
  'the 2nd': 1,
  'the 3rd': 2,
  'the 4th': 3,
  'the last': -1
};

const WEEKDAY_INDEX = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6
};

// Does today satisfy this client's schedule_* criteria?
// Weekly: today's weekday matches schedule_day.
// Monthly: today's weekday matches schedule_day AND today is the correct
// ordinal occurrence of that weekday within the current month.
function matchesScheduleToday(clientConfig, today) {
  const { schedule_unit, schedule_day, schedule_ordinal } = clientConfig;

  const todayWeekday = today.getDay();
  if (todayWeekday !== WEEKDAY_INDEX[schedule_day]) return false;

  if (schedule_unit === 'week') {
    return true;
  }

  if (schedule_unit === 'month') {
    const targetIndex = ORDINAL_INDEX[schedule_ordinal];
    if (targetIndex === undefined) return false;

    const year = today.getFullYear();
    const month = today.getMonth();
    const lastDayOfMonth = new Date(year, month + 1, 0).getDate();

    const matchingDates = [];
    for (let day = 1; day <= lastDayOfMonth; day++) {
      const d = new Date(year, month, day);
      if (d.getDay() === todayWeekday) matchingDates.push(day);
    }

    const expectedDay = targetIndex === -1
      ? matchingDates[matchingDates.length - 1]
      : matchingDates[targetIndex];

    return expectedDay === today.getDate();
  }

  return false;
}

// Runs daily per client at their configured local time. Cheap no-op on days
// that don't match; only pulls Xero data + enqueues when the date matches.
// autoStatementsQueue is passed in (not required) to avoid a circular
// dependency with server.js, which owns the Queue instance.
async function runScheduledCheck(clientId, autoStatementsQueue) {
  const { rows } = await pool.query('SELECT * FROM client_config WHERE id = $1', [clientId]);
  const clientConfig = rows[0];
  if (!clientConfig || !clientConfig.auto_statements_enabled) return;

  const now = new Date();
  if (!matchesScheduleToday(clientConfig, now)) return;

  console.log(`[Scheduler] Schedule matched for client ${clientId}, fetching contacts`);

  // getFilteredContacts now returns bucket objects — { bucketKey, contactId,
  // currencyCode, hasEmail, totalOutstanding } — pre-filtered to hasEmail &&
  // totalOutstanding > 0. Silent exclusions (no email, zero balance) don't
  // write statement_logs rows — this is intentional for the cron path.
  const buckets = await getFilteredContacts(clientId, clientConfig.recipient_filter || 'outstanding');
  if (buckets.length === 0) {
    console.log(`[Scheduler] No contacts matched filter for client ${clientId}, skipping`);
    return;
  }

  const baseCurrency = await getOrFetchBaseCurrency(clientId);
  const todayDateString = getTenantTodayDateString();

  // Pre-check Redis idempotency keys (optimization — actual lock is in the worker).
  const redisKeys = buckets.map((b) => `sent-statement:${clientId}:${b.bucketKey}:${todayDateString}`);
  const sentFlags = redisKeys.length > 0 ? await redis.mget(redisKeys) : [];
  const toEnqueue = buckets.filter((_, i) => !sentFlags[i]);

  if (toEnqueue.length === 0) {
    console.log(`[Scheduler] All buckets for client ${clientId} already sent today, skipping`);
    return;
  }

  // Bulk-insert PROCESSING rows at enqueue time — not left to the worker —
  // so the dashboard shows "Sending..." immediately during queue wait.
  const insertValues = [];
  const insertParams = [];
  let paramIndex = 1;
  for (const b of toEnqueue) {
    insertValues.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, 'PROCESSING')`);
    insertParams.push(clientId, b.contactId, b.bucketKey, b.currencyCode, 'scheduled');
  }
  const { rows: insertedLogs } = await pool.query(
    `INSERT INTO statement_logs (client_id, contact_id, bucket_key, currency_code, trigger_type, status)
     VALUES ${insertValues.join(', ')}
     RETURNING id, bucket_key`,
    insertParams
  );
  const logIdByBucketKey = {};
  for (const row of insertedLogs) {
    logIdByBucketKey[row.bucket_key] = row.id;
  }

  const minuteWindow = Math.floor(Date.now() / 60000);
  const jobs = toEnqueue.map((b) => ({
    name: 'send-statements',
    data: {
      clientId,
      bucketKey: b.bucketKey,
      currencyCode: b.currencyCode,
      contactId: b.contactId,
      baseCurrency,
      todayDateString,
      logId: logIdByBucketKey[b.bucketKey],
    },
    opts: {
      jobId: `send-sched-${clientId}-${b.bucketKey}-${todayDateString}`,
      backoff: { type: 'custom' },
      attempts: 5,
    },
  }));

  await autoStatementsQueue.addBulk(jobs);
  console.log(`[Scheduler] Queued ${toEnqueue.length} bucket(s) for client ${clientId}`);
}

// Registers (or replaces, via deterministic jobId) one repeatable job per
// client with auto_statements_enabled = true, on the dedicated
// 'auto-statements-scheduler' queue (see scheduledCheckWorker.js). Call once
// at server boot and again for a single client immediately after their
// settings are saved.
async function registerRepeatableJob(schedulerQueue, clientConfig) {
  const jobId = `statement-run-${clientConfig.id}`;
  const [hour, minute] = (clientConfig.schedule_time || '06:00').split(':');

  await schedulerQueue.upsertJobScheduler(
    jobId,
    {
      pattern: `${parseInt(minute, 10)} ${parseInt(hour, 10)} * * *`,
      tz: clientConfig.schedule_timezone || 'Australia/Melbourne'
    },
    {
      name: 'scheduled-check',
      data: { clientId: clientConfig.id }
    }
  );
}

async function registerAllRepeatableJobs(schedulerQueue) {
  const { rows } = await pool.query(
    'SELECT * FROM client_config WHERE auto_statements_enabled = true'
  );
  for (const clientConfig of rows) {
    await registerRepeatableJob(schedulerQueue, clientConfig);
  }
  console.log(`[Scheduler] Registered ${rows.length} repeatable job(s)`);
}

module.exports = { matchesScheduleToday, runScheduledCheck, registerRepeatableJob, registerAllRepeatableJobs };
