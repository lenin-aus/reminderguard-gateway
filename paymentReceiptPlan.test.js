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

test('runPlanner enqueues one job per due client, with a per-client jobId so a slow run is never duplicated', async () => {
  const added = [];
  const db = { query: async () => ({ rows: [client({ id: 8 }), client({ id: 9, last_checked_at: morning })] }) };
  const queue = { addBulk: async (jobs) => added.push(...jobs) };

  const jobs = await require('./paymentReceiptPlan').runPlanner({ db, queue, now: () => morning, log: { log() {} } });

  assert.deepEqual(jobs, [{ clientId: 8 }]);
  assert.equal(added.length, 1);
  assert.deepEqual(added[0].data, { clientId: 8 });
  assert.equal(added[0].opts.jobId, 'receipt-check-8');
});

test('runPlanner does nothing when no org is due', async () => {
  const added = [];
  const db = { query: async () => ({ rows: [client({ last_checked_at: morning })] }) };
  const queue = { addBulk: async (jobs) => added.push(...jobs) };
  const jobs = await require('./paymentReceiptPlan').runPlanner({ db, queue, now: () => morning });
  assert.deepEqual(jobs, []);
  assert.equal(added.length, 0);
});
