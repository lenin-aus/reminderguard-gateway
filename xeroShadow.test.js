'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diffCustomers, formatShadowLog } = require('./xeroShadow');

const c = (key, over = {}) => ({ bucketKey: key, contactName: key, currencyCode: 'AUD', hasEmail: true, theyOwe: 100, overdueAmount: 0, daysOverdue: 0, ...over });

test('identical lists are the same, whatever the order', () => {
  const d = diffCustomers([c('a'), c('b')], [c('b'), c('a')]);
  assert.equal(d.same, true);
  assert.equal(formatShadowLog(8, d, null), '[xero-shadow] client=8 live=2 local=2 diffs=0 copy_synced=never');
});

test('customers on one side only, and changed amounts, are reported with the field', () => {
  const d = diffCustomers([c('a'), c('b'), c('c', { theyOwe: 50 })], [c('b'), c('c', { theyOwe: 40, hasEmail: false }), c('d')]);
  assert.equal(d.same, false);
  assert.deepEqual(d.onlyLive, ['a']);
  assert.deepEqual(d.onlyLocal, ['d']);
  assert.deepEqual(d.changed, [{ bucketKey: 'c', fields: [{ field: 'hasEmail', live: true, local: false }, { field: 'theyOwe', live: 50, local: 40 }] }]);
  const line = formatShadowLog(8, d, '2026-09-26T00:00:00Z');
  assert.match(line, /diffs=3 copy_synced=2026-09-26T00:00:00.000Z/);
  assert.match(line, /only_live:a \| only_local:d \| c:hasEmail true->false,theyOwe 50->40/);
});
