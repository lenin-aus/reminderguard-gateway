const pool = require('./db');
const { getFilteredContacts } = require('./recipientSelector');

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
  const { schedule_unit, schedule_day, schedule_ordinal, schedule_interval } = clientConfig;

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

  const contactIds = await getFilteredContacts(clientId, clientConfig.recipient_filter);
  if (contactIds.length === 0) {
    console.log(`[Scheduler] No contacts matched filter for client ${clientId}, skipping`);
    return;
  }

  await autoStatementsQueue.add('send-statements', { clientId, contactIds });
  console.log(`[Scheduler] Queued ${contactIds.length} contact(s) for client ${clientId}`);
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
