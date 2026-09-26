'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { requestLog } = require('./requestLog');

function run({ body = { bucketKeys: ['a_AUD', 'b_AUD'] }, statusCode = 202, finish = true, times = [1000, 1034] } = {}) {
  const lines = [];
  const clock = [...times];
  const middleware = requestLog('trigger', { log: (l) => lines.push(l), now: () => clock.shift() });
  const req = { method: 'POST', params: { clientId: '8' }, body };
  const res = Object.assign(new EventEmitter(), { statusCode, writableFinished: finish });
  let nexted = false;
  middleware(req, res, () => { nexted = true; });
  if (finish) res.emit('finish');
  res.emit('close');
  return { lines, nexted };
}

test('logs the client, method, number of buckets, status and duration once the response is finished', () => {
  const { lines, nexted } = run();
  assert.equal(nexted, true);
  assert.deepEqual(lines, ['[trigger] client=8 POST buckets=2 -> 202 in 34 ms']);
});

test('rejected requests are logged too', () => {
  assert.deepEqual(run({ statusCode: 400 }).lines, ['[trigger] client=8 POST buckets=2 -> 400 in 34 ms']);
});

test('a request with no bucket list logs no bucket count, and never logs the body itself', () => {
  const { lines } = run({ body: { secret: 'x' } });
  assert.deepEqual(lines, ['[trigger] client=8 POST -> 202 in 34 ms']);
});

test('a connection closed before any response is reported', () => {
  const { lines } = run({ finish: false });
  assert.deepEqual(lines, ['[trigger] client=8 POST -> connection closed before a response was sent']);
});
