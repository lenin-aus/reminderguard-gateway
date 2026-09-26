'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lastSentLabel, calendarDaysBetween } = require('./lastSent');

const MEL = 'Australia/Melbourne';
// Midday on 26 Sep 2026 in Melbourne.
const NOW = Date.parse('2026-09-26T02:00:00Z');
const label = (row, nowMs = NOW) => lastSentLabel(row, { nowMs, timeZone: MEL });
const row = (status, createdAt, error_reason = null) => ({ status, error_reason, created_at: createdAt });

test('a failure from the same local day says today; the day before says yesterday; older says N days ago', () => {
  assert.equal(label(row('FAILED', '2026-09-25T23:33:00Z', 'API_ERROR')), 'Failed today', '09:33 on the 26th in Melbourne');
  assert.equal(label(row('FAILED', '2026-09-25T09:33:00Z', 'API_ERROR')), 'Failed yesterday', '19:33 on the 25th');
  assert.equal(label(row('FAILED', '2026-09-24T02:00:00Z', 'API_ERROR')), 'Failed 2 days ago');
  assert.equal(label(row('FAILED', '2026-09-16T02:00:00Z', 'API_ERROR')), 'Failed 10 days ago');
});

test('yesterday means the previous local date, whatever the hour', () => {
  // 23:30 on the 25th local, seen at 01:00 on the 26th: an hour and a half later, but a new day.
  const now = Date.parse('2026-09-25T15:00:00Z');
  assert.equal(label(row('FAILED', '2026-09-25T13:30:00Z', 'API_ERROR'), now), 'Failed yesterday');
  // The same instants read in UTC would be the same date; the client's timezone decides.
  assert.equal(lastSentLabel(row('FAILED', '2026-09-25T13:30:00Z', 'API_ERROR'), { nowMs: now, timeZone: 'UTC' }), 'Failed today');
});

test('a delivered statement reads Today, then N day(s) ago by calendar day', () => {
  assert.equal(label(row('DELIVERED', '2026-09-26T00:30:00Z')), 'Today');
  assert.equal(label(row('DELIVERED', '2026-09-25T09:00:00Z')), '1 day ago');
  assert.equal(label(row('DELIVERED', '2026-09-23T09:00:00Z')), '3 days ago');
});

test('a contact with no email address stays "Never", however old the failure', () => {
  assert.equal(label(row('FAILED', '2026-09-26T01:00:00Z', 'MISSING_EMAIL')), 'Never');
  assert.equal(label(row('FAILED', '2026-09-01T01:00:00Z', 'MISSING_EMAIL')), 'Never');
});

test('a job still sending, and one stuck for more than 15 minutes', () => {
  assert.equal(label(row('PROCESSING', new Date(NOW - 5 * 60 * 1000).toISOString())), 'Sending...');
  assert.equal(label(row('PROCESSING', new Date(NOW - 15 * 60 * 1000).toISOString())), 'Sending...', 'exactly 15 minutes is still sending');
  assert.equal(label(row('PROCESSING', new Date(NOW - 16 * 60 * 1000).toISOString())), 'Failed');
});

test('an unknown status reads Never', () => {
  assert.equal(label(row('SOMETHING_ELSE', '2026-09-26T01:00:00Z')), 'Never');
});

test('a row stamped slightly in the future never reads as negative days', () => {
  assert.equal(label(row('FAILED', '2026-09-26T05:00:00Z', 'API_ERROR')), 'Failed today');
});

test('calendarDaysBetween counts whole days across months and leap days', () => {
  assert.equal(calendarDaysBetween('2026-09-25', '2026-09-26'), 1);
  assert.equal(calendarDaysBetween('2026-08-31', '2026-09-01'), 1);
  assert.equal(calendarDaysBetween('2028-02-28', '2028-03-01'), 2);
});
