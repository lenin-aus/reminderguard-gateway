'use strict';

// Consumes the planner job (every five minutes) and syncs whichever organisations are due. Loaded
// by scheduledCheckWorker.js, so it runs in the same process and no new Coolify app is needed. It
// has its own queue and worker, so a long first sync never delays the statement schedule check.

const { Worker } = require('bullmq');
const pool = require('./db');
const { getXeroSource } = require('./xeroSource');
const { getXeroRedis } = require('./xeroData');
const { getXeroContext } = require('./xeroContext');
const { runPlanner } = require('./xeroSyncPlan');

const connection = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT || 6379,
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
};

// concurrency 1: two overlapping planner runs would only queue up behind each other's locks.
const xeroSyncWorker = new Worker(
  'xero-sync-planner',
  async () => {
    const jobs = await runPlanner({ db: pool, redis: getXeroRedis(), sync: getXeroSource().sync, getContext: getXeroContext });
    if (jobs.length > 0) console.log(`[xero-sync] planner ran ${jobs.map((j) => `${j.clientId}:${j.mode}`).join(', ')}`);
  },
  { connection, concurrency: 1 }
);

xeroSyncWorker.on('failed', (job, err) => console.error('[xero-sync] planner job FAILED:', err?.message));
xeroSyncWorker.on('error', (err) => console.error('[xero-sync] worker error:', err?.message));

module.exports = xeroSyncWorker;
