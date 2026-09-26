'use strict';

// Decides which organisations need a sync now, and runs them one after another. Called every five
// minutes by the planner job (see scheduler.js and xeroSyncWorker.js). Only orgs on 'shadow' or
// 'local' are synced, so an org on 'live' costs no Xero calls.
//   no complete copy yet        a full pull (the backfill), retried after a failure only 10 minutes on
//   overnight (02:00-05:00)     a full pull if the last one is over 22 hours old: the safety net
//   business hours (06:00-21:00) an incremental pull if the last run is over 25 minutes old
// Hours are the organisation's own timezone. About 30 runs of 5 calls a day, well inside Xero's
// 1,000 calls a day per organisation.

const { RESOURCES } = require('./xeroSync');

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const RETRY_AFTER_ERROR_MS = 10 * MINUTE;
const INCREMENTAL_EVERY_MS = 25 * MINUTE;
const FULL_EVERY_MS = 22 * HOUR;
const NIGHT_HOURS = [2, 5]; // [from, until)
const DAY_HOURS = [6, 21];

function localHour(now, timeZone) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(now));
  } catch {
    return localHour(now, 'Australia/Melbourne');
  }
}

const within = (hour, [from, until]) => hour >= from && hour < until;

// clients: [{ id, tz, full_resources, last_run_at, last_full_at, last_error_at }] (dates or null)
function planSyncJobs(clients, now = new Date()) {
  const jobs = [];
  for (const c of clients) {
    if (c.last_error_at && now - new Date(c.last_error_at) < RETRY_AFTER_ERROR_MS) continue;
    if (Number(c.full_resources) < RESOURCES.length) {
      jobs.push({ clientId: c.id, mode: 'full' });
      continue;
    }
    const hour = localHour(now, c.tz || 'Australia/Melbourne');
    if (within(hour, NIGHT_HOURS) && (!c.last_full_at || now - new Date(c.last_full_at) > FULL_EVERY_MS)) {
      jobs.push({ clientId: c.id, mode: 'full' });
    } else if (within(hour, DAY_HOURS) && (!c.last_run_at || now - new Date(c.last_run_at) > INCREMENTAL_EVERY_MS)) {
      jobs.push({ clientId: c.id, mode: 'incremental' });
    }
  }
  return jobs;
}

const syncLockKey = (clientId) => `xero:sync:lock:${clientId}`;
const SYNC_LOCK_TTL_S = 15 * 60;

// One sync per organisation at a time (the planner, the Refresh button and another worker all
// respect it). Returns a release function, or null when a sync is already running.
async function acquireSyncLock(redis, clientId) {
  const token = `${process.pid}:${Date.now()}`;
  const got = await redis.set(syncLockKey(clientId), token, 'EX', SYNC_LOCK_TTL_S, 'NX');
  if (!got) return null;
  return async () => {
    if ((await redis.get(syncLockKey(clientId))) === token) await redis.del(syncLockKey(clientId));
  };
}

const CANDIDATES_SQL = `
  SELECT cc.id, COALESCE(NULLIF(cc.schedule_timezone, ''), 'Australia/Melbourne') AS tz,
         (SELECT count(*) FROM xero_sync_state s WHERE s.client_id = cc.id AND s.last_full_at IS NOT NULL) AS full_resources,
         (SELECT min(s.last_run_at) FROM xero_sync_state s WHERE s.client_id = cc.id) AS last_run_at,
         (SELECT min(s.last_full_at) FROM xero_sync_state s WHERE s.client_id = cc.id) AS last_full_at,
         (SELECT max(s.last_error_at) FROM xero_sync_state s WHERE s.client_id = cc.id) AS last_error_at
    FROM client_config cc
    JOIN oauth_tokens ot ON ot.client_id = cc.id
    JOIN connections c ON c.id = ot.connection_id
   WHERE cc.xero_read_mode IN ('shadow', 'local')
     AND c.access_token IS NOT NULL AND c.refresh_token IS NOT NULL`;

async function runPlanner({ db, redis, sync, getContext, now = () => new Date(), log = console }) {
  const { rows } = await db.query(CANDIDATES_SQL);
  const jobs = planSyncJobs(rows, now());
  for (const job of jobs) {
    const release = await acquireSyncLock(redis, job.clientId);
    if (!release) continue;
    try {
      const ctx = await getContext(job.clientId);
      const summary = await sync.syncClient(ctx, { mode: job.mode });
      const failed = Object.keys(summary.errors);
      if (failed.length > 0) log.warn?.(`[xero-sync] client=${job.clientId} ${job.mode} finished with errors in: ${failed.join(', ')}`);
    } catch (e) {
      // One organisation failing (an expired connection, a used-up day) must not stop the others.
      log.warn?.(`[xero-sync] client=${job.clientId} ${job.mode} failed: ${e.code || ''} ${e.message}`);
    } finally {
      await release().catch(() => {});
    }
  }
  return jobs;
}

module.exports = { planSyncJobs, runPlanner, acquireSyncLock, syncLockKey, localHour };
