'use strict';

// Runs only when REDIS_TEST_PORT is set (for example against the local dev stack's Redis).
const test = require('node:test');
const assert = require('node:assert/strict');

const port = process.env.REDIS_TEST_PORT;

test('redis limiter: shared window and concurrency across two limiter instances', { skip: !port && 'set REDIS_TEST_PORT to run' }, async () => {
  const Redis = require('ioredis');
  const { createRedisLimiter } = require('./xeroLimiter');
  const redis = new Redis({ host: process.env.REDIS_TEST_HOST || '127.0.0.1', port: Number(port) });
  const tenant = `test-${Date.now()}`;
  const opts = { rate: 3, windowMs: 600, concurrency: 2, pollMs: 10 };
  const a = createRedisLimiter(redis, opts);
  const b = createRedisLimiter(redis, opts);
  try {
    // Two instances (two processes in production) share one concurrency cap of 2.
    const l1 = await a.acquire(tenant);
    const l2 = await b.acquire(tenant);
    let third = false;
    const p3 = a.acquire(tenant).then((l) => { third = true; return l; });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(third, false, 'the cap of 2 is shared');
    await l1.release();
    const l3 = await p3;
    await l2.release();
    await l3.release();

    // Rate: 3 calls used so far in this window, so the 4th must wait for the window to slide.
    const started = Date.now();
    await (await b.acquire(tenant)).release();
    assert.ok(Date.now() - started >= 300, `4th call waited ${Date.now() - started}ms`);

    await a.setDayRemaining(tenant, 500);
    assert.equal(await b.getDayRemaining(tenant), 500);
  } finally {
    await redis.del(`xero:rl:${tenant}`, `xero:conc:${tenant}`, `xero:day:${tenant}`);
    redis.disconnect();
  }
});
