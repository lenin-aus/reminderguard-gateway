'use strict';

// Decides which organisations are due a payment-receipt check, and enqueues one job per due org.
// Called every five minutes by a registered job (see scheduler.js), consumed by
// paymentReceiptWorker.js. Only orgs with receipts_enabled are ever considered.
//
//   every_15_min / every_30_min / hourly   due when the last check is older than that interval.
//   daily_at                               due once per calendar day (the org's own timezone),
//                                           at or after the configured time.
// A failed org is retried after 10 minutes, the same backoff xeroSyncPlan uses.

const { DateTime } = require('luxon');

const RETRY_AFTER_ERROR_MS = 10 * 60 * 1000;
const INTERVAL_MS = { every_15_min: 15 * 60 * 1000, every_30_min: 30 * 60 * 1000, hourly: 60 * 60 * 1000 };

// The current date ('YYYY-MM-DD') and time ('HH:MM') in the given timezone, for comparing against
// a daily_at schedule without needing a full timezone-aware date library.
function localParts(now, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const p = Object.fromEntries(fmt.formatToParts(now).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  } catch {
    return localParts(now, 'Australia/Melbourne');
  }
}

function isDue(client, now) {
  if (client.last_error_at && now - new Date(client.last_error_at) < RETRY_AFTER_ERROR_MS) return false;

  if (client.mode === 'daily_at') {
    const here = localParts(now, client.tz);
    if (here.time < (client.time || '00:00')) return false;
    if (!client.last_checked_at) return true;
    return localParts(new Date(client.last_checked_at), client.tz).date !== here.date;
  }

  const everyMs = INTERVAL_MS[client.mode] ?? INTERVAL_MS.hourly;
  return !client.last_checked_at || now - new Date(client.last_checked_at) >= everyMs;
}

// clients: [{ id, tz, mode, time, last_checked_at, last_error_at }]
function planReceiptJobs(clients, now = new Date()) {
  return clients.filter((c) => isDue(c, now)).map((c) => ({ clientId: c.id }));
}

const CANDIDATES_SQL = `
  SELECT cc.id, COALESCE(NULLIF(cc.schedule_timezone, ''), 'Australia/Melbourne') AS tz,
         cc.receipts_schedule_mode AS mode, cc.receipts_schedule_time AS time,
         prs.last_checked_at, prs.last_error_at
    FROM client_config cc
    JOIN oauth_tokens ot ON ot.client_id = cc.id
    JOIN connections c ON c.id = ot.connection_id
    LEFT JOIN payment_receipt_state prs ON prs.client_id = cc.id
   WHERE cc.receipts_enabled = true
     AND c.access_token IS NOT NULL AND c.refresh_token IS NOT NULL`;

// Enqueues one BullMQ job per due org, letting BullMQ assign each one its own id. The actual
// Xero/Brevo work, and updating payment_receipt_state, happens in the worker that consumes this
// queue, not here; mutual exclusion is a Redis lock the worker holds (acquireReceiptLock, below),
// not a reused jobId — a FIXED jobId per client was tried first and was wrong: BullMQ's
// removeOnComplete/removeOnFail are a RETENTION policy (keep up to N jobs for up to an age), not
// "delete immediately on completion", so a completed job keeps occupying its id for up to a day;
// every later addBulk with that same id then silently attaches to the already-finished job instead
// of creating a new one, and the worker never runs again. (This is what actually happened in
// production on 2026-10-01: the first check completed fine, and every check after that was a
// silent no-op — same symptom as a hang, but the real cause was job-id reuse, not a stuck call.)
async function runPlanner({ db, queue, now = () => new Date(), log = console }) {
  const { rows } = await db.query(CANDIDATES_SQL);
  const jobs = planReceiptJobs(rows, now());
  if (jobs.length === 0) return jobs;
  await queue.addBulk(
    jobs.map((j) => ({
      name: 'check-client',
      data: { clientId: j.clientId },
      opts: {
        attempts: 1,
        removeOnComplete: { age: 86400, count: 100 },
        removeOnFail: { age: 604800, count: 200 },
      },
    })),
  );
  log.log?.(`[payment-receipts] planner queued ${jobs.length} check(s): ${jobs.map((j) => j.clientId).join(', ')}`);
  return jobs;
}

const receiptLockKey = (clientId) => `payment-receipts:lock:${clientId}`;
const RECEIPT_LOCK_TTL_S = 10 * 60;

// One check per organisation at a time. Returns a release function, or null when a check for this
// org is already running (a normal, harmless outcome, not an error — the job just completes doing
// nothing, and the next planner tick tries again once the running one is done).
async function acquireReceiptLock(redis, clientId) {
  const token = `${process.pid}:${Date.now()}`;
  const got = await redis.set(receiptLockKey(clientId), token, 'EX', RECEIPT_LOCK_TTL_S, 'NX');
  if (!got) return null;
  return async () => {
    if ((await redis.get(receiptLockKey(clientId))) === token) await redis.del(receiptLockKey(clientId));
  };
}

// The "Next run" / "Next runs" display for Payment Receipts. Mirrors isDue()'s own rule for each
// mode exactly — when a run is due right now (never checked, or overdue), the first entry equals
// `from`, the same instant isDue would already call due — so what the planner does on its very next
// tick and what this shows never disagree. Call only for an enabled config with a mode chosen; a
// paused or not-yet-configured schedule has no next run.
//   client: { mode, time, tz, last_checked_at }
function nextDailyReceiptRun(client, from) {
  const [hour, minute] = (client.time || '00:00').split(':').map(Number);
  const nowLocal = DateTime.fromJSDate(from, { zone: client.tz });
  const todaySlot = nowLocal.set({ hour, minute, second: 0, millisecond: 0 });
  if (nowLocal < todaySlot) return todaySlot.toUTC().toJSDate(); // later today
  if (!client.last_checked_at) return from; // time has passed, never checked: due now
  const checkedLocal = DateTime.fromJSDate(new Date(client.last_checked_at), { zone: client.tz });
  if (checkedLocal.toISODate() !== nowLocal.toISODate()) return from; // last checked an earlier day: due now
  return todaySlot.plus({ days: 1 }).toUTC().toJSDate(); // already checked today: due tomorrow
}

function computeUpcomingReceiptRuns(client, { from = new Date(), count = 4 } = {}) {
  if (client.mode === 'daily_at') {
    let next = nextDailyReceiptRun(client, from);
    const runs = [next];
    while (runs.length < count) {
      next = DateTime.fromJSDate(next, { zone: 'utc' }).plus({ days: 1 }).toJSDate();
      runs.push(next);
    }
    return runs;
  }

  const everyMs = INTERVAL_MS[client.mode] ?? INTERVAL_MS.hourly;
  let next = client.last_checked_at ? new Date(new Date(client.last_checked_at).getTime() + everyMs) : from;
  if (next < from) next = from; // overdue: due now, not "last check + interval" in the past
  const runs = [next];
  while (runs.length < count) {
    next = new Date(next.getTime() + everyMs);
    runs.push(next);
  }
  return runs;
}

module.exports = {
  planReceiptJobs,
  runPlanner,
  localParts,
  acquireReceiptLock,
  receiptLockKey,
  computeUpcomingReceiptRuns,
};
