// cowork access test
// api edit test
// scheduler.js
// Registers the single global heartbeat job. No per-client jobs, no cron
// per client, no timezones here — scheduledCheckWorker.js decides who is due.


const HEARTBEAT_JOB_ID = 'auto-statements-heartbeat';

async function registerHeartbeat(schedulerQueue) {
  await schedulerQueue.upsertJobScheduler(
    HEARTBEAT_JOB_ID,
    { pattern: '* * * * *' },
    { name: 'heartbeat', data: {} }
  );
  console.log('[Heartbeat] Registered global heartbeat job (* * * * *)');
}

// The Xero sync planner: every five minutes, decides which organisations are due (xeroSyncPlan.js).
const XERO_SYNC_PLANNER_JOB_ID = 'xero-sync-planner';

async function registerXeroSyncPlanner(queue) {
  await queue.upsertJobScheduler(
    XERO_SYNC_PLANNER_JOB_ID,
    { pattern: '*/5 * * * *' },
    { name: 'plan', data: {}, opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 20 } } }
  );
  console.log('[xero-sync] Registered planner job (*/5 * * * *)');
}

module.exports = { registerHeartbeat, registerXeroSyncPlanner };

// const HEARTBEAT_JOB_ID = 'auto-statements-heartbeat';

// async function registerHeartbeat(schedulerQueue) {
//   await schedulerQueue.upsertJobScheduler(
//     HEARTBEAT_JOB_ID,
//     { pattern: '*/15 * * * *' },
//     { name: 'heartbeat', data: {} }
//   );
//   console.log('[Heartbeat] Registered global heartbeat job (*/15 * * * *)');
// }

// module.exports = { registerHeartbeat };
