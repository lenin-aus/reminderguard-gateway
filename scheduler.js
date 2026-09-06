// scheduler.js
// Registers the single global heartbeat job. No per-client jobs, no cron
// per client, no timezones here — scheduledCheckWorker.js decides who is due.


async function registerHeartbeat(schedulerQueue) {
  await schedulerQueue.upsertJobScheduler(
    HEARTBEAT_JOB_ID,
    { pattern: '* * * * *' },
    { name: 'heartbeat', data: {} }
  );
  console.log('[Heartbeat] Registered global heartbeat job (* * * * *)');
}


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
