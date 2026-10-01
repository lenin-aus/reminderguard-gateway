'use strict';

// Against real Redis and a real BullMQ queue/worker (not fakes): proves the actual production bug
// is fixed. On 2026-10-01 the planner used a fixed jobId per client; once that client's first check
// completed, BullMQ kept the completed job under that id (removeOnComplete is a retention policy,
// not "delete on completion"), so every later addBulk with the same id silently attached to the
// already-finished job instead of creating a new one — the worker never ran again for that client.
//   REDIS_TEST_PORT=56379 node --test paymentReceiptPlan.redis.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const port = process.env.REDIS_TEST_PORT;
const skip = !port && 'set REDIS_TEST_PORT to run';

const client = (over = {}) => ({
  id: 8,
  tz: 'Australia/Melbourne',
  mode: 'every_15_min',
  time: null,
  last_checked_at: null,
  last_error_at: null,
  ...over,
});

async function withQueue(fn) {
  const { Queue, Worker } = require('bullmq');
  const { acquireReceiptLock } = require('./paymentReceiptPlan');
  const Redis = require('ioredis');
  const connection = { host: '127.0.0.1', port: Number(port), maxRetriesPerRequest: null };
  const name = `payment-receipts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const queue = new Queue(name, { connection });
  const lockRedis = new Redis(connection);
  const runs = [];
  const worker = new Worker(
    name,
    async (job) => {
      const release = await acquireReceiptLock(lockRedis, job.data.clientId);
      if (!release) {
        runs.push({ clientId: job.data.clientId, skipped: true });
        return;
      }
      try {
        await new Promise((r) => setTimeout(r, 30)); // a real check takes a moment
        runs.push({ clientId: job.data.clientId, skipped: false });
      } finally {
        await release();
      }
    },
    { connection, concurrency: 5 }
  );
  await worker.waitUntilReady();
  try {
    await fn({ queue, runs });
  } finally {
    await worker.close();
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
    lockRedis.disconnect();
  }
}

const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test('a second planner tick runs the worker again after the first check has completed', { skip }, () =>
  withQueue(async ({ queue, runs }) => {
    const { runPlanner } = require('./paymentReceiptPlan');
    const db = { query: async () => ({ rows: [client()] }) };

    await runPlanner({ db, queue, log: { log() {} } });
    assert.ok(await waitFor(() => runs.length === 1), 'the first check ran');

    // A second tick, exactly as the real planner fires every five minutes — with the old fixed
    // jobId this add was a silent no-op against the already-completed first job.
    await runPlanner({ db, queue, log: { log() {} } });
    assert.ok(await waitFor(() => runs.length === 2), 'the second check also ran, not silently dropped');
    assert.deepEqual(runs, [{ clientId: 8, skipped: false }, { clientId: 8, skipped: false }]);
  }));

test('two checks for the same org queued at once: one runs, one finds the lock held', { skip }, () =>
  withQueue(async ({ queue, runs }) => {
    await queue.addBulk([
      { name: 'check-client', data: { clientId: 8 } },
      { name: 'check-client', data: { clientId: 8 } },
    ]);

    assert.ok(await waitFor(() => runs.length === 2), 'both jobs finished (one of them by skipping)');
    assert.deepEqual(runs.map((r) => r.skipped).sort(), [false, true]);
  }));
