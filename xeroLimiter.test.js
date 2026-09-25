'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryLimiter } = require('./xeroLimiter');

function fakeClock() {
  const clock = { t: 0, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } };
  return clock;
}

test('the rate limit holds the call that would exceed the window until it frees up', async () => {
  const clock = fakeClock();
  const limiter = createMemoryLimiter({ rate: 3, windowMs: 1000, concurrency: 10, now: clock.now, sleep: clock.sleep });

  for (let i = 0; i < 3; i++) (await limiter.acquire('T1')).release();
  assert.equal(clock.t, 0);

  (await limiter.acquire('T1')).release();
  assert.equal(clock.t, 1001, 'the 4th call waits for the first to leave the window');
});

test('the window slides: calls spread over time are not delayed', async () => {
  const clock = fakeClock();
  const limiter = createMemoryLimiter({ rate: 2, windowMs: 1000, concurrency: 10, now: clock.now, sleep: clock.sleep });

  (await limiter.acquire('T1')).release();
  clock.t = 600;
  (await limiter.acquire('T1')).release();
  clock.t = 1100; // the first call (t=0) has left the window
  (await limiter.acquire('T1')).release();
  assert.equal(clock.t, 1100);
});

test('tenants have separate windows', async () => {
  const clock = fakeClock();
  const limiter = createMemoryLimiter({ rate: 1, windowMs: 1000, concurrency: 10, now: clock.now, sleep: clock.sleep });

  (await limiter.acquire('A')).release();
  (await limiter.acquire('B')).release();
  assert.equal(clock.t, 0);
});

test('concurrency is capped, and a released lease lets the next call in', async () => {
  const limiter = createMemoryLimiter({ rate: 1000, concurrency: 2, pollMs: 5 });

  const first = await limiter.acquire('T1');
  await limiter.acquire('T1');
  let thirdResolved = false;
  const third = limiter.acquire('T1').then((lease) => { thirdResolved = true; return lease; });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(thirdResolved, false, 'the third call waits while two are in flight');

  first.release();
  await third;
  assert.equal(thirdResolved, true);
});

test('release is idempotent', async () => {
  const limiter = createMemoryLimiter({ rate: 1000, concurrency: 1, pollMs: 5 });
  const lease = await limiter.acquire('T1');
  lease.release();
  lease.release();
  const next = await limiter.acquire('T1');
  let blocked = true;
  const another = limiter.acquire('T1').then(() => { blocked = false; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(blocked, true, 'a double release must not free a second slot');
  next.release();
  await another;
});

test('the daily quota reported by Xero is stored per tenant', async () => {
  const limiter = createMemoryLimiter();
  assert.equal(await limiter.getDayRemaining('T1'), null);
  await limiter.setDayRemaining('T1', 986);
  assert.equal(await limiter.getDayRemaining('T1'), 986);
  assert.equal(await limiter.getDayRemaining('T2'), null);
});
