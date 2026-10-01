'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planReceiptJobs, localParts } = require('./paymentReceiptPlan');

// 2026-09-25 22:00 UTC is 08:00 on the 26th in Melbourne (AEST, UTC+10).
const morning = new Date('2026-09-25T22:00:00Z');
const ago = (now, minutes) => new Date(now.getTime() - minutes * 60 * 1000);
const client = (over = {}) => ({ id: 8, tz: 'Australia/Melbourne', mode: 'hourly', time: null, last_checked_at: null, last_error_at: null, ...over });

test('localParts reads the date and time in the given timezone, falling back on an unknown one', () => {
  assert.deepEqual(localParts(morning, 'Australia/Melbourne'), { date: '2026-09-26', time: '08:00' });
  assert.deepEqual(localParts(morning, 'UTC'), { date: '2026-09-25', time: '22:00' });
  assert.deepEqual(localParts(morning, 'Not/AZone'), { date: '2026-09-26', time: '08:00' });
});

test('a client never checked is due, whatever the interval mode', () => {
  for (const mode of ['every_15_min', 'every_30_min', 'hourly']) {
    assert.deepEqual(planReceiptJobs([client({ mode })], morning), [{ clientId: 8 }]);
  }
});

test('an interval mode is due only once the interval has passed', () => {
  assert.deepEqual(planReceiptJobs([client({ mode: 'every_15_min', last_checked_at: ago(morning, 14) })], morning), []);
  assert.deepEqual(
    planReceiptJobs([client({ mode: 'every_15_min', last_checked_at: ago(morning, 16) })], morning),
    [{ clientId: 8 }],
  );
  assert.deepEqual(planReceiptJobs([client({ mode: 'hourly', last_checked_at: ago(morning, 59) })], morning), []);
});

test('daily_at is due once per day, only at or after the configured time', () => {
  const notYet = client({ mode: 'daily_at', time: '09:00' }); // it's 08:00 locally
  assert.deepEqual(planReceiptJobs([notYet], morning), []);

  const dueNow = client({ mode: 'daily_at', time: '08:00' });
  assert.deepEqual(planReceiptJobs([dueNow], morning), [{ clientId: 8 }]);

  const alreadyToday = client({ mode: 'daily_at', time: '07:00', last_checked_at: ago(morning, 30) });
  assert.deepEqual(planReceiptJobs([alreadyToday], morning), []);

  const yesterday = client({ mode: 'daily_at', time: '07:00', last_checked_at: ago(morning, 25 * 60) });
  assert.deepEqual(planReceiptJobs([yesterday], morning), [{ clientId: 8 }]);
});

test('a client still in its post-error backoff is skipped', () => {
  assert.deepEqual(planReceiptJobs([client({ last_error_at: ago(morning, 3) })], morning), []);
  assert.deepEqual(planReceiptJobs([client({ last_error_at: ago(morning, 11) })], morning), [{ clientId: 8 }]);
});

test('each org is planned on its own', () => {
  const jobs = planReceiptJobs(
    [
      client({ id: 1, mode: 'hourly', last_checked_at: ago(morning, 61) }),
      client({ id: 2, mode: 'hourly', last_checked_at: ago(morning, 5) }),
      client({ id: 3, mode: 'every_15_min' }),
    ],
    morning,
  );
  assert.deepEqual(jobs, [{ clientId: 1 }, { clientId: 3 }]);
});

test('runPlanner enqueues one job per due client, with no fixed jobId (mutual exclusion is the lock, not job-id reuse)', async () => {
  const added = [];
  const db = { query: async () => ({ rows: [client({ id: 8 }), client({ id: 9, last_checked_at: morning })] }) };
  const queue = { addBulk: async (jobs) => added.push(...jobs) };

  const jobs = await require('./paymentReceiptPlan').runPlanner({ db, queue, now: () => morning, log: { log() {} } });

  assert.deepEqual(jobs, [{ clientId: 8 }]);
  assert.equal(added.length, 1);
  assert.deepEqual(added[0].data, { clientId: 8 });
  assert.equal(added[0].opts.jobId, undefined, 'a fixed id here is what caused every check after the first to silently no-op in production');
});

test('runPlanner does nothing when no org is due', async () => {
  const added = [];
  const db = { query: async () => ({ rows: [client({ last_checked_at: morning })] }) };
  const queue = { addBulk: async (jobs) => added.push(...jobs) };
  const jobs = await require('./paymentReceiptPlan').runPlanner({ db, queue, now: () => morning });
  assert.deepEqual(jobs, []);
  assert.equal(added.length, 0);
});

test('acquireReceiptLock: one check per organisation at a time, others are independent', async () => {
  const { acquireReceiptLock } = require('./paymentReceiptPlan');
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

  const first = await acquireReceiptLock(redis, 8);
  assert.equal(typeof first, 'function');
  assert.equal(await acquireReceiptLock(redis, 8), null, 'a second check for the same org is refused');
  assert.equal(typeof (await acquireReceiptLock(redis, 9)), 'function', 'another org is independent');

  await first();
  assert.equal(typeof (await acquireReceiptLock(redis, 8)), 'function', 'released, so the next check can run');
});

test('computeUpcomingReceiptRuns, interval modes: evenly spaced from the last check', () => {
  const { computeUpcomingReceiptRuns } = require('./paymentReceiptPlan');
  const runs = computeUpcomingReceiptRuns(
    { mode: 'hourly', time: null, tz: 'Australia/Melbourne', last_checked_at: '2026-09-25T22:00:00Z' },
    { from: morning, count: 3 },
  );
  assert.deepEqual(
    runs.map((d) => d.toISOString()),
    ['2026-09-25T23:00:00.000Z', '2026-09-26T00:00:00.000Z', '2026-09-26T01:00:00.000Z'],
  );
});

test('computeUpcomingReceiptRuns, interval modes: never checked, or overdue, means due right now', () => {
  const { computeUpcomingReceiptRuns } = require('./paymentReceiptPlan');
  const neverChecked = computeUpcomingReceiptRuns({ mode: 'every_15_min', tz: 'Australia/Melbourne', last_checked_at: null }, { from: morning, count: 1 });
  assert.equal(neverChecked[0].toISOString(), morning.toISOString());

  const overdue = computeUpcomingReceiptRuns(
    { mode: 'every_15_min', tz: 'Australia/Melbourne', last_checked_at: ago(morning, 90) },
    { from: morning, count: 1 },
  );
  assert.equal(overdue[0].toISOString(), morning.toISOString());
});

test('computeUpcomingReceiptRuns, daily_at: later today if the time has not passed yet', () => {
  const { computeUpcomingReceiptRuns } = require('./paymentReceiptPlan');
  // morning is 08:00 Melbourne time.
  const runs = computeUpcomingReceiptRuns(
    { mode: 'daily_at', time: '09:00', tz: 'Australia/Melbourne', last_checked_at: null },
    { from: morning, count: 3 },
  );
  assert.deepEqual(runs.map((d) => d.toISOString()), ['2026-09-25T23:00:00.000Z', '2026-09-26T23:00:00.000Z', '2026-09-27T23:00:00.000Z']);
});

test('computeUpcomingReceiptRuns, daily_at: due now once the time has passed and it was not checked today', () => {
  const { computeUpcomingReceiptRuns } = require('./paymentReceiptPlan');
  const neverChecked = computeUpcomingReceiptRuns(
    { mode: 'daily_at', time: '07:00', tz: 'Australia/Melbourne', last_checked_at: null },
    { from: morning, count: 1 },
  );
  assert.equal(neverChecked[0].toISOString(), morning.toISOString(), 'matches isDue: due immediately, not tomorrow');

  const checkedYesterday = computeUpcomingReceiptRuns(
    { mode: 'daily_at', time: '07:00', tz: 'Australia/Melbourne', last_checked_at: ago(morning, 25 * 60) },
    { from: morning, count: 1 },
  );
  assert.equal(checkedYesterday[0].toISOString(), morning.toISOString());
});

test('computeUpcomingReceiptRuns, daily_at: tomorrow once already checked today', () => {
  const { computeUpcomingReceiptRuns } = require('./paymentReceiptPlan');
  const runs = computeUpcomingReceiptRuns(
    { mode: 'daily_at', time: '07:00', tz: 'Australia/Melbourne', last_checked_at: ago(morning, 30) },
    { from: morning, count: 1 },
  );
  assert.equal(runs[0].toISOString(), '2026-09-26T21:00:00.000Z'); // tomorrow 07:00 Melbourne (AEST, +10)
});
