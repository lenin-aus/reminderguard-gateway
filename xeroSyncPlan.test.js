'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planSyncJobs, localHour, acquireSyncLock } = require('./xeroSyncPlan');

// 2026-09-25 22:00 UTC is 08:00 on the 26th in Melbourne (AEST, UTC+10); 16:00 UTC is 02:00 there.
const morning = new Date('2026-09-25T22:00:00Z');
const night = new Date('2026-09-25T16:30:00Z');
const evening = new Date('2026-09-26T12:00:00Z'); // 22:00 in Melbourne
const ago = (now, minutes) => new Date(now.getTime() - minutes * 60 * 1000);
const client = (over = {}) => ({ id: 8, tz: 'Australia/Melbourne', full_resources: 5, last_run_at: null, last_full_at: null, last_error_at: null, ...over });

test('hours are read in the organisation\'s own timezone', () => {
  assert.equal(localHour(morning, 'Australia/Melbourne'), 8);
  assert.equal(localHour(morning, 'UTC'), 22);
  assert.equal(localHour(morning, 'Not/AZone'), 8, 'an unknown timezone falls back to Melbourne');
});

test('an org with no complete copy gets a full pull at any hour', () => {
  for (const now of [morning, night, evening]) {
    assert.deepEqual(planSyncJobs([client({ full_resources: 0 })], now), [{ clientId: 8, mode: 'full' }]);
    assert.deepEqual(planSyncJobs([client({ full_resources: 3 })], now), [{ clientId: 8, mode: 'full' }], 'a partly made copy carries on');
  }
});

test('a failed org waits ten minutes before the next attempt', () => {
  assert.deepEqual(planSyncJobs([client({ full_resources: 0, last_error_at: ago(morning, 3) })], morning), []);
  assert.equal(planSyncJobs([client({ full_resources: 0, last_error_at: ago(morning, 11) })], morning).length, 1);
});

test('in business hours an incremental pull is due after 25 minutes, not before', () => {
  const full = ago(morning, 600);
  assert.deepEqual(planSyncJobs([client({ last_run_at: ago(morning, 30), last_full_at: full })], morning), [{ clientId: 8, mode: 'incremental' }]);
  assert.deepEqual(planSyncJobs([client({ last_run_at: ago(morning, 10), last_full_at: full })], morning), []);
});

test('outside business hours nothing runs, except the overnight full pull', () => {
  assert.deepEqual(planSyncJobs([client({ last_run_at: ago(evening, 300), last_full_at: ago(evening, 300) })], evening), []);
  assert.deepEqual(planSyncJobs([client({ last_run_at: ago(night, 300), last_full_at: ago(night, 23 * 60) })], night), [{ clientId: 8, mode: 'full' }]);
  assert.deepEqual(planSyncJobs([client({ last_run_at: ago(night, 300), last_full_at: ago(night, 5 * 60) })], night), [], 'a full pull done recently is not repeated');
});

test('each org is planned on its own', () => {
  const jobs = planSyncJobs(
    [client({ id: 1, last_run_at: ago(morning, 30), last_full_at: ago(morning, 600) }), client({ id: 2, last_run_at: ago(morning, 5), last_full_at: ago(morning, 600) }), client({ id: 3, full_resources: 0 })],
    morning
  );
  assert.deepEqual(jobs, [{ clientId: 1, mode: 'incremental' }, { clientId: 3, mode: 'full' }]);
});

test('one sync per organisation at a time', async () => {
  const store = new Map();
  const redis = {
    async set(key, value, ex, ttl, nx) {
      if (nx === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async get(key) { return store.get(key) ?? null; },
    async del(key) { store.delete(key); },
  };
  const first = await acquireSyncLock(redis, 8);
  assert.equal(typeof first, 'function');
  assert.equal(await acquireSyncLock(redis, 8), null, 'a second one is refused');
  assert.equal(typeof (await acquireSyncLock(redis, 9)), 'function', 'other orgs are independent');
  await first();
  assert.equal(typeof (await acquireSyncLock(redis, 8)), 'function', 'released');
});
