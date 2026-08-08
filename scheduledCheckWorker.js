const { Worker, Queue } = require('bullmq');
const { runScheduledCheck } = require('./scheduler');

const connection = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT || 6379,
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD
};

// The 'auto-statements' queue is for actual sends (owned by server.js /
// autoStatementsWorker.js). runScheduledCheck adds to it on a match.
const autoStatementsQueue = new Queue('auto-statements', { connection });

// Separate queue: only daily scheduled-check triggers land here, so this
// Worker never has to filter out someone else's jobs by name.
const scheduledCheckWorker = new Worker('auto-statements-scheduler', async (job) => {
  const { clientId } = job.data;
  await runScheduledCheck(clientId, autoStatementsQueue);
}, { connection });

scheduledCheckWorker.on('failed', (job, err) => {
  console.error('[ScheduledCheckWorker] Job FAILED:', job?.id, err?.message, err?.stack);
});
scheduledCheckWorker.on('error', (err) => {
  console.error('[ScheduledCheckWorker] Worker-level ERROR:', err?.message, err?.stack);
});

module.exports = scheduledCheckWorker;
