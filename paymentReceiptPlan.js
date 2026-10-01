'use strict';

// Decides which organisations are due a payment-receipt check, and enqueues one job per due org.
// Called every five minutes by a registered job (see scheduler.js), consumed by
// paymentReceiptWorker.js. Only orgs with receipts_enabled are ever considered.
//
//   every_15_min / every_30_min / hourly   due when the last check is older than that interval.
//   daily_at                               due once per calendar day (the org's own timezone),
//                                           at or after the configured time.
// A failed org is retried after 10 minutes, the same backoff xeroSyncPlan uses.

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

// Enqueues one BullMQ job per due org. The actual Xero/Brevo work, and updating
// payment_receipt_state, happens in the worker that consumes this queue, not here.
//
// jobId is the client id alone (no timestamp): if a client's previous check is still
// waiting/active, BullMQ treats a same-id add as already-queued and does not duplicate it, so a
// slow check (still running at the next five-minute tick) is never run twice at once. Once it
// completes or fails it is removed (removeOnComplete/removeOnFail), freeing the id for next time.
async function runPlanner({ db, queue, now = () => new Date(), log = console }) {
  const { rows } = await db.query(CANDIDATES_SQL);
  const jobs = planReceiptJobs(rows, now());
  if (jobs.length === 0) return jobs;
  await queue.addBulk(
    jobs.map((j) => ({
      name: 'check-client',
      data: { clientId: j.clientId },
      opts: {
        jobId: `receipt-check-${j.clientId}`,
        attempts: 1,
        removeOnComplete: { age: 86400, count: 100 },
        removeOnFail: { age: 604800, count: 200 },
      },
    })),
  );
  log.log?.(`[payment-receipts] planner queued ${jobs.length} check(s): ${jobs.map((j) => j.clientId).join(', ')}`);
  return jobs;
}

module.exports = { planReceiptJobs, runPlanner, localParts };
