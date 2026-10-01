'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateReceiptConfig, toApiReceiptConfig, WRITABLE_KEYS } = require('./receiptConfig');

const paused = {
  receipts_enabled: false,
  receipts_schedule_mode: null,
  receipts_schedule_time: null,
  receipt_test_email: null,
  receipt_cc_email: null,
  receipt_alert_email: null,
};

const active = {
  ...paused,
  receipts_enabled: true,
  receipts_schedule_mode: 'hourly',
  receipt_alert_email: 'books@example.test',
};

test('a paused config with everything null is valid', () => {
  assert.deepEqual(validateReceiptConfig(paused), { ok: true, value: paused });
});

test('an active config needs an alert email', () => {
  const r = validateReceiptConfig({ ...paused, receipts_enabled: true });
  assert.deepEqual(r.fields, { receipt_alert_email: 'Required while receipts are on' });
});

test('an active config with a valid alert email still needs a schedule mode', () => {
  const r = validateReceiptConfig({ ...paused, receipts_enabled: true, receipt_alert_email: 'a@example.test' });
  assert.deepEqual(r.fields, { receipts_schedule_mode: 'Choose how often to check for new payments' });
});

test('daily_at needs a time; every other mode must not have one', () => {
  const noTime = validateReceiptConfig({ ...active, receipts_schedule_mode: 'daily_at' });
  assert.deepEqual(noTime.fields, { receipts_schedule_time: 'Choose a time' });

  const withTime = validateReceiptConfig({
    ...active,
    receipts_schedule_mode: 'daily_at',
    receipts_schedule_time: '09:00',
  });
  assert.deepEqual(withTime, {
    ok: true,
    value: { ...active, receipts_schedule_mode: 'daily_at', receipts_schedule_time: '09:00' },
  });

  const strayTime = validateReceiptConfig({ ...active, receipts_schedule_time: '09:00' });
  assert.deepEqual(strayTime.fields, { receipts_schedule_time: 'Only used with "a specific time each day"' });
});

test('every valid mode is accepted while active', () => {
  for (const mode of ['every_15_min', 'every_30_min', 'hourly']) {
    assert.equal(validateReceiptConfig({ ...active, receipts_schedule_mode: mode }).ok, true);
  }
});

test('a valid schedule mode is accepted while paused too (not required)', () => {
  assert.equal(validateReceiptConfig({ ...paused, receipts_schedule_mode: 'hourly' }).ok, true);
});

test('test and CC emails are optional even while active; the alert email is not', () => {
  const r = validateReceiptConfig({ ...active, receipt_test_email: null, receipt_cc_email: null });
  assert.equal(r.ok, true);
});

test('a bad email, an unknown field or a missing field are each rejected', () => {
  assert.deepEqual(validateReceiptConfig({ ...active, receipt_cc_email: 'nope' }).fields, {
    receipt_cc_email: 'Must be a valid email address, or null',
  });
  assert.deepEqual(validateReceiptConfig({ ...active, extra: 1 }).fields.extra, 'Unknown field');
  const { receipts_enabled, ...missing } = active;
  assert.deepEqual(validateReceiptConfig(missing).fields.receipts_enabled, 'Required');
});

test('a non-object body is rejected', () => {
  assert.deepEqual(validateReceiptConfig(null), { ok: false, fields: { _body: 'Body must be a JSON object' } });
  assert.deepEqual(validateReceiptConfig([1, 2]), { ok: false, fields: { _body: 'Body must be a JSON object' } });
});

test('toApiReceiptConfig treats stored empty strings as null, and only reads the six keys', () => {
  const row = { ...active, receipt_cc_email: '', id: 7, client_name: 'Acme' };
  assert.deepEqual(toApiReceiptConfig(row), { ...active, receipt_cc_email: null });
  assert.deepEqual(Object.keys(toApiReceiptConfig(row)).sort(), [...WRITABLE_KEYS].sort());
});
